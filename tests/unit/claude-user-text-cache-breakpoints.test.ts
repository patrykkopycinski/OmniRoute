/**
 * User-message content breakpoints must reach Claude.
 *
 * Two clients mark a user text part as a prompt-cache breakpoint:
 *  - /v1/responses: `input_text` + `prompt_cache_breakpoint: { mode: "explicit" }`
 *  - /v1/chat/completions: `{ type: "text", cache_control: { type: "ephemeral" } }`
 * Both used to be dropped on the way to a Claude target, so a large user-side
 * context section was never cached (cache_creation = cache_read = 0).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import { translateRequest } from "../../open-sse/translator/index.ts";
import { convertResponsesApiFormat } from "../../open-sse/translator/helpers/responsesApiHelper.ts";

type Block = Record<string, unknown>;
type Msg = { role: string; content?: Block[] | string };

const MODEL = "claude-sonnet-5-5";

function toClaude(
  body: Record<string, unknown>,
  provider: string,
  preserveCacheControl: boolean
): { system?: Block[]; tools?: Block[]; messages: Msg[] } {
  return translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, MODEL, body, true, null, provider, null, {
    preserveCacheControl,
  }) as { system?: Block[]; tools?: Block[]; messages: Msg[] };
}

function countBreakpoints(result: { system?: Block[]; tools?: Block[]; messages: Msg[] }): number {
  let n = 0;
  for (const b of result.system ?? []) if (b.cache_control) n++;
  for (const t of result.tools ?? []) if (t.cache_control) n++;
  for (const m of result.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) if (b.cache_control) n++;
  }
  return n;
}

function responsesBody(): Record<string, unknown> {
  return {
    model: MODEL,
    instructions: "You are a reviewer.",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "PR context ".repeat(50),
            prompt_cache_breakpoint: { mode: "explicit" },
          },
          { type: "input_text", text: "Review this change." },
        ],
      },
    ],
  };
}

describe("responses input_text prompt_cache_breakpoint -> Claude cache_control", () => {
  for (const preserve of [false, true]) {
    test(`claude target gets cache_control on the marked text block (preserve=${preserve})`, () => {
      const chat = convertResponsesApiFormat(responsesBody(), null, "claude", MODEL);
      const result = toClaude(chat, "claude", preserve);

      const userContent = result.messages[0].content as Block[];
      assert.equal(userContent[0].type, "text");
      assert.deepEqual(userContent[0].cache_control, { type: "ephemeral", ttl: "1h" });
      assert.equal(userContent[1].cache_control, undefined, "unmarked part stays unmarked");
      assert.equal(userContent[0].prompt_cache_breakpoint, undefined, "no OpenAI-only field leaks");
      assert.ok(countBreakpoints(result) <= 4);
    });
  }

  test("any breakpoint mode maps to a breakpoint", () => {
    const body = responsesBody();
    (((body.input as Block[])[0].content as Block[])[0] as Block).prompt_cache_breakpoint = {
      mode: "implicit",
    };
    const chat = convertResponsesApiFormat(body, null, "claude", MODEL);
    const result = toClaude(chat, "claude", false);
    assert.deepEqual((result.messages[0].content as Block[])[0].cache_control, {
      type: "ephemeral",
      ttl: "1h",
    });
  });

  test("uses the route's default TTL (vertex omits ttl, like the system breakpoint)", () => {
    const chat = convertResponsesApiFormat(responsesBody(), null, "vertex", MODEL);
    const result = toClaude(chat, "vertex", false);
    assert.deepEqual((result.messages[0].content as Block[])[0].cache_control, {
      type: "ephemeral",
    });
    assert.deepEqual(result.system?.[result.system.length - 1].cache_control, {
      type: "ephemeral",
    });
  });

  test("TTL ordering stays valid: the message breakpoint never outranks the system one", () => {
    const chat = convertResponsesApiFormat(responsesBody(), null, "claude", MODEL);
    const result = toClaude(chat, "claude", false);
    const sys = result.system?.[result.system.length - 1].cache_control as Block;
    const msg = (result.messages[0].content as Block[])[0].cache_control as Block;
    assert.equal(sys.ttl, "1h");
    assert.equal(msg.ttl, "1h");
  });

  test("non-Claude targets: field only survives for the openai/openrouter allowlist", () => {
    const run = (provider: string) => {
      const chat = convertResponsesApiFormat(responsesBody(), null, provider, MODEL);
      const out = translateRequest(
        FORMATS.OPENAI,
        FORMATS.OPENAI,
        "some-model",
        chat,
        true,
        null,
        provider,
        null,
        { preserveCacheControl: false }
      ) as { messages: Array<{ role: string; content: Block[] }> };
      return out.messages.find((m) => m.role === "user")!.content[0];
    };
    assert.equal(run("groq").prompt_cache_breakpoint, undefined);
    assert.equal(run("mistral").prompt_cache_breakpoint, undefined);
    assert.deepEqual(run("openai").prompt_cache_breakpoint, { mode: "explicit" });
    assert.equal(run("openai").cache_control, undefined);
  });
});

describe("chat user text part cache_control -> Claude", () => {
  const chatBody = (cacheControl: Block): Record<string, unknown> => ({
    model: MODEL,
    messages: [
      { role: "system", content: "You are a reviewer." },
      {
        role: "user",
        content: [
          { type: "text", text: "PR context ".repeat(50), cache_control: cacheControl },
          { type: "text", text: "Review this change." },
        ],
      },
    ],
  });

  for (const preserve of [false, true]) {
    test(`explicit cache_control is preserved on the user text block (preserve=${preserve})`, () => {
      const result = toClaude(chatBody({ type: "ephemeral" }), "claude", preserve);
      const userContent = result.messages[0].content as Block[];
      assert.deepEqual(userContent[0].cache_control, { type: "ephemeral" });
      assert.equal(userContent[1].cache_control, undefined);
    });
  }

  test("an explicit ttl is preserved verbatim", () => {
    const result = toClaude(chatBody({ type: "ephemeral", ttl: "5m" }), "claude", false);
    assert.deepEqual((result.messages[0].content as Block[])[0].cache_control, {
      type: "ephemeral",
      ttl: "5m",
    });
  });
});

describe("breakpoint cap with user-message breakpoints", () => {
  const marked = (text: string): Block => ({
    type: "text",
    text,
    cache_control: { type: "ephemeral" },
  });

  const body = (): Record<string, unknown> => ({
    model: MODEL,
    messages: [
      { role: "system", content: "System prefix" },
      { role: "user", content: [marked("ctx A"), { type: "text", text: "q1" }] },
      { role: "assistant", content: "a1" },
      { role: "user", content: [marked("ctx B"), { type: "text", text: "q2" }] },
      { role: "assistant", content: "a2" },
      { role: "user", content: [marked("ctx C"), { type: "text", text: "q3" }] },
    ],
  });

  for (const preserve of [false, true]) {
    test(`system + 3 user breakpoints + tail stays <= 4, latest user breakpoint kept (preserve=${preserve})`, () => {
      const result = toClaude(body(), "claude", preserve);
      assert.ok(countBreakpoints(result) <= 4, `got ${countBreakpoints(result)} breakpoints`);
      const lastUser = result.messages[result.messages.length - 1].content as Block[];
      assert.ok(
        lastUser[0].cache_control,
        "the latest user breakpoint survives enforcement (earliest are culled first)"
      );
    });
  }
});

describe("TTL ordering with user-message breakpoints", () => {
  test("a 1h breakpoint after an explicit 5m one is downgraded (Anthropic requires 1h before 5m)", () => {
    const result = toClaude(
      {
        model: MODEL,
        messages: [
          { role: "system", content: "System prefix" },
          {
            role: "user",
            content: [
              { type: "text", text: "ctx A", cache_control: { type: "ephemeral", ttl: "5m" } },
            ],
          },
          { role: "assistant", content: "a1" },
          {
            role: "user",
            content: [
              { type: "text", text: "ctx B", prompt_cache_breakpoint: { mode: "explicit" } },
            ],
          },
        ],
      },
      "claude",
      false
    );
    const ttls: unknown[] = [];
    for (const b of result.system ?? [])
      if (b.cache_control) ttls.push((b.cache_control as Block).ttl);
    for (const m of result.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) if (b.cache_control) ttls.push((b.cache_control as Block).ttl);
    }
    const firstFive = ttls.indexOf("5m");
    assert.ok(firstFive >= 0);
    assert.ok(!ttls.slice(firstFive).includes("1h"), `1h after 5m: ${JSON.stringify(ttls)}`);
    assert.ok(ttls.length <= 4);
  });
});

// ---- review follow-ups -------------------------------------------------------

type Claude = { system?: Block[]; tools?: Block[]; messages: Msg[] };

function breakpointSequence(result: Claude): Array<{ where: string; ttl: unknown }> {
  const seq: Array<{ where: string; ttl: unknown }> = [];
  for (const t of result.tools ?? [])
    if (t.cache_control) seq.push({ where: "tool", ttl: (t.cache_control as Block).ttl });
  for (const b of result.system ?? [])
    if (b.cache_control) seq.push({ where: "system", ttl: (b.cache_control as Block).ttl });
  for (const m of result.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content)
      if (b.cache_control) seq.push({ where: m.role, ttl: (b.cache_control as Block).ttl });
  }
  return seq;
}

// Anthropic: 1h breakpoints must precede 5m ones; a missing ttl is the 5m default.
function assertValidBreakpoints(result: Claude): void {
  const seq = breakpointSequence(result);
  assert.ok(seq.length <= 4, `>4 breakpoints: ${JSON.stringify(seq)}`);
  let seenFive = false;
  for (const { ttl } of seq) {
    if (ttl === "1h") assert.ok(!seenFive, `1h after 5m: ${JSON.stringify(seq)}`);
    else seenFive = true;
  }
}

const tools = [
  {
    type: "function",
    function: { name: "lookup", description: "d", parameters: { type: "object" } },
  },
];

const markedPart = (text: string): Block => ({
  type: "text",
  text,
  prompt_cache_breakpoint: { mode: "explicit" },
});

function responsesTurns(markedTurns: number): Record<string, unknown> {
  const input: Block[] = [];
  for (let i = 0; i < markedTurns; i++) {
    input.push({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: `ctx ${i}`, prompt_cache_breakpoint: { mode: "explicit" } },
        { type: "input_text", text: `q${i}` },
      ],
    });
    if (i < markedTurns - 1) {
      input.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `a${i}` }],
      });
    }
  }
  return { model: MODEL, instructions: "You are a reviewer.", input, tools };
}

describe("preserve mode on a claude-format provider outside the caching set (H2)", () => {
  for (const provider of ["anthropic", "minimax", "kimi-coding", "glm"]) {
    test(`${provider}: marked two-turn keeps valid TTL order`, () => {
      const chat = convertResponsesApiFormat(responsesTurns(2), null, provider, MODEL);
      assertValidBreakpoints(toClaude(chat, provider, true));
    });
    test(`${provider}: three marked turns + tools stays <= 4 blocks`, () => {
      const chat = convertResponsesApiFormat(responsesTurns(3), null, provider, MODEL);
      assertValidBreakpoints(toClaude(chat, provider, true));
    });
  }

  test("requests without user breakpoints are unchanged for a non-caching provider", () => {
    const body = {
      model: MODEL,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ],
    };
    const result = toClaude(JSON.parse(JSON.stringify(body)), "anthropic", true);
    // Base behaviour: system + last assistant markers only, nothing re-derived.
    assert.deepEqual(
      breakpointSequence(result).map((b) => b.where),
      ["system", "assistant"]
    );
  });
});

describe("multi-turn anthropic-compatible-*: user breakpoint keeps the route TTL (M4)", () => {
  const provider = "anthropic-compatible-test";
  for (const preserve of [false, true]) {
    test(`1h on the marked user turn, heuristic assistant marker dropped (preserve=${preserve})`, () => {
      const chat = convertResponsesApiFormat(responsesTurns(2), null, provider, MODEL);
      const result = toClaude(chat, provider, preserve);
      assertValidBreakpoints(result);
      const lastUser = result.messages[result.messages.length - 1].content as Block[];
      assert.deepEqual(lastUser[0].cache_control, { type: "ephemeral", ttl: "1h" });
    });
  }
});

describe("zed-hosted anthropic path (M3)", () => {
  test("2+ marked user parts: <= 4 blocks, valid TTL order", async () => {
    const { __test__ } = await import("../../open-sse/executors/zed-hosted.ts");
    const request = __test__.buildProviderRequest(
      "anthropic" as never,
      MODEL,
      {
        model: MODEL,
        tools,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: [markedPart("c1"), markedPart("c2")] },
          { role: "assistant", content: "a1" },
          { role: "user", content: [markedPart("c3"), markedPart("c4")] },
          { role: "assistant", content: "a2" },
          { role: "user", content: [markedPart("c5")] },
        ],
      },
      true,
      {} as never
    ) as Claude;
    assertValidBreakpoints(request);
    assert.ok(breakpointSequence(request).some((b) => b.where === "user"));
  });
});

// ---- review round 3 ----------------------------------------------------------

describe("Claude-source bodies are forwarded verbatim (L1)", () => {
  test("Claude -> Claude keeps a client 1h marker that follows an un-ttl'd one", () => {
    const body = {
      model: MODEL,
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "ctx", cache_control: { type: "ephemeral", ttl: "1h" } }],
        },
      ],
    };
    const result = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.CLAUDE,
      MODEL,
      JSON.parse(JSON.stringify(body)),
      true,
      null,
      "claude",
      null,
      {}
    ) as Claude;
    assert.deepEqual(result.system, body.system);
    assert.deepEqual(result.messages, body.messages);
  });
});

describe("missing ttl is treated as 5m by the ordering pass (L2)", () => {
  test("chat turn 1 cache_control without ttl, turn 2 breakpoint marker -> turn 2 is 5m", () => {
    const result = toClaude(
      {
        model: MODEL,
        messages: [
          { role: "system", content: "sys" },
          {
            role: "user",
            content: [{ type: "text", text: "ctx 1", cache_control: { type: "ephemeral" } }],
          },
          { role: "assistant", content: "a1" },
          { role: "user", content: [markedPart("ctx 2")] },
        ],
      },
      "claude",
      false
    );
    const users = result.messages.filter((m) => m.role === "user");
    assert.deepEqual((users[0].content as Block[])[0].cache_control, { type: "ephemeral" });
    assert.deepEqual((users[1].content as Block[])[0].cache_control, {
      type: "ephemeral",
      ttl: "5m",
    });
    assertValidBreakpoints(result);
  });
});
