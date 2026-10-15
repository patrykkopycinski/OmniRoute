/**
 * Lite tool-result truncation: exempt tool names (default "clarify") and the
 * byte-count marker. A cut `clarify` result once hid 3 of 5 user answers.
 * Run: node --import tsx/esm --test tests/unit/compression/lite-exempt-tools.test.ts
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  compressToolResults,
  isUsableLiteExemptToolNames,
  resolveLiteExemptToolNames,
} from "../../../open-sse/services/compression/lite.ts";
import { liteEngine } from "../../../open-sse/services/compression/engines/cavemanAdapter.ts";
import { adaptBodyForCompression } from "../../../open-sse/services/compression/bodyAdapter.ts";
import { liteConfigSchema } from "../../../src/shared/validation/compressionConfigSchemas.ts";

const BIG = Array.from({ length: 430 }, (_, i) => `answer ${i}: some user text`).join("\n");
const CAP = 2000;

type Msg = Record<string, unknown>;

function assistantCall(id: string, name: string): Msg {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
  };
}

/** Prior-turn tool result followed by a later assistant turn, so it is not "current turn". */
function priorTurn(toolMsg: Msg, callName: string, callId = "c1"): { messages: Msg[] } {
  return {
    messages: [
      { role: "user", content: "go" },
      assistantCall(callId, callName),
      toolMsg,
      { role: "assistant", content: "done" },
      { role: "user", content: "next" },
    ],
  };
}

function toolContent(body: { messages: Msg[] }): string {
  return body.messages.find((m) => m.role === "tool")!.content as string;
}

afterEach(() => {
  delete process.env.OMNIROUTE_LITE_EXEMPT_TOOLS;
});

describe("lite exemptToolNames", () => {
  it("leaves a clarify result over the cap untouched (name on the message)", () => {
    assert.ok(BIG.length > CAP);
    const body = priorTurn(
      { role: "tool", name: "clarify", tool_call_id: "c1", content: BIG },
      "clarify"
    );
    const out = compressToolResults(body as never, { maxToolLength: CAP });
    assert.equal(out.applied, false);
    assert.equal(toolContent(out.body as never), BIG);
  });

  it("resolves the tool name from the assistant tool_calls when `name` is missing", () => {
    const body = priorTurn({ role: "tool", tool_call_id: "c1", content: BIG }, "clarify");
    const out = compressToolResults(body as never, { maxToolLength: CAP });
    assert.equal(out.applied, false);
    assert.equal(toolContent(out.body as never), BIG);
  });

  it("still truncates a non-exempt tool, with an N-of-M marker", () => {
    const body = priorTurn({ role: "tool", tool_call_id: "c1", content: BIG }, "read");
    const out = compressToolResults(body as never, { maxToolLength: CAP });
    assert.equal(out.applied, true);
    const text = toolContent(out.body as never);
    const m = text.match(/\n\.\.\.\[truncated (\d+) of (\d+) chars\]$/);
    assert.ok(m, `marker missing in: ${text.slice(-80)}`);
    assert.equal(Number(m[2]), BIG.length);
    const kept = text.slice(0, m.index);
    assert.equal(Number(m[1]), BIG.length - kept.length);
    assert.equal(BIG.startsWith(kept), true);
  });

  it("honours a custom exemptToolNames list (default clarify no longer applies)", () => {
    const readBody = priorTurn({ role: "tool", tool_call_id: "c1", content: BIG }, "read");
    const kept = compressToolResults(readBody as never, {
      maxToolLength: CAP,
      exemptToolNames: ["read"],
    });
    assert.equal(toolContent(kept.body as never), BIG);

    const clarifyBody = priorTurn({ role: "tool", tool_call_id: "c1", content: BIG }, "clarify");
    const cut = compressToolResults(clarifyBody as never, {
      maxToolLength: CAP,
      exemptToolNames: ["read"],
    });
    assert.equal(cut.applied, true);
  });

  it("OMNIROUTE_LITE_EXEMPT_TOOLS adds names on top of the configured list", () => {
    process.env.OMNIROUTE_LITE_EXEMPT_TOOLS = " pager , other ,";
    assert.deepEqual([...resolveLiteExemptToolNames()].sort(), ["clarify", "other", "pager"]);
    assert.deepEqual([...resolveLiteExemptToolNames(["x"])].sort(), ["other", "pager", "x"]);
    const body = priorTurn({ role: "tool", tool_call_id: "c1", content: BIG }, "pager");
    const out = compressToolResults(body as never, { maxToolLength: CAP });
    assert.equal(out.applied, false);
  });

  it("never exempts a tool message whose name cannot be resolved", () => {
    // A tool message with no resolvable name is never exempt.
    const body = priorTurn({ role: "tool", tool_call_id: "unknown", content: BIG }, "clarify");
    const out = compressToolResults(body as never, { maxToolLength: CAP });
    assert.equal(out.applied, true);
  });

  it("validates the list shape", () => {
    assert.equal(isUsableLiteExemptToolNames(["a"]), true);
    assert.equal(isUsableLiteExemptToolNames([]), true);
    assert.equal(isUsableLiteExemptToolNames([""]), false);
    assert.equal(isUsableLiteExemptToolNames([1]), false);
    assert.equal(isUsableLiteExemptToolNames("clarify"), false);
    assert.equal(isUsableLiteExemptToolNames(Array(65).fill("a")), false);
    assert.equal(liteConfigSchema.safeParse({ exemptToolNames: ["clarify"] }).success, true);
    assert.equal(liteConfigSchema.safeParse({ exemptToolNames: [""] }).success, false);
    assert.equal(liteConfigSchema.safeParse({ exemptToolNames: "clarify" }).success, false);
    assert.equal(liteEngine.validateConfig!({ exemptToolNames: ["a"] }).valid, true);
    assert.equal(liteEngine.validateConfig!({ exemptToolNames: [3] }).valid, false);
  });

  it("flows config.lite.exemptToolNames and stepConfig through liteEngine.apply", () => {
    const mk = () => priorTurn({ role: "tool", tool_call_id: "c1", content: BIG }, "mytool");
    const base = { messages: mk().messages } as Record<string, unknown>;
    const cut = liteEngine.apply(base, { config: { lite: { maxToolLength: CAP } } } as never);
    assert.equal(cut.compressed, true);

    const viaConfig = liteEngine.apply(
      { messages: mk().messages } as never,
      {
        config: { lite: { maxToolLength: CAP, exemptToolNames: ["mytool"] } },
      } as never
    );
    assert.equal(toolContent(viaConfig.body as never), BIG);

    const viaStep = liteEngine.apply(
      { messages: mk().messages } as never,
      {
        config: { lite: { maxToolLength: CAP } },
        stepConfig: { exemptToolNames: ["mytool"] },
      } as never
    );
    assert.equal(toolContent(viaStep.body as never), BIG);
  });

  it("covers /v1/responses traffic: function_call_output resolves its tool name via call_id", () => {
    const body = {
      input: [
        { type: "message", role: "user", content: "go" },
        { type: "function_call", call_id: "c1", name: "clarify", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: BIG },
        { type: "function_call", call_id: "c2", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "c2", output: BIG },
        { type: "message", role: "assistant", content: "ok" },
        { type: "message", role: "user", content: "next" },
      ],
    };
    const out = liteEngine.apply(
      body as never,
      {
        config: { lite: { maxToolLength: CAP } },
      } as never
    );
    const input = out.body.input as Array<Record<string, unknown>>;
    assert.equal(input[2].output, BIG, "clarify output must be untouched");
    assert.notEqual(input[4].output, BIG, "read output must still be truncated");
    assert.match(String(input[4].output), /\[truncated \d+ of \d+ chars\]$/);
    assert.ok(!("name" in input[2]) || input[2].name === undefined, "synthetic name must not leak");
    assert.ok(!("messages" in out.body));
  });

  it("adapter exposes the tool name on synthetic tool messages only", () => {
    const adapter = adaptBodyForCompression({
      input: [
        { type: "function_call", call_id: "c1", name: "clarify", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "hello" },
      ],
    });
    const msgs = adapter.body.messages as Msg[];
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].name, "clarify");
  });
});
