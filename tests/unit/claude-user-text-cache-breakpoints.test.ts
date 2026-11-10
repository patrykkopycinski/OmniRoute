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
