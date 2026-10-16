import test from "node:test";
import assert from "node:assert/strict";

// Reasoning must never surface as a text block when the response already carries a
// real content block (text or tool_use). The reasoning-only synthesis ("fix B") is for
// responses with NO other content block.

const { openaiToClaudeResponse } =
  await import("../../open-sse/translator/response/openai-to-claude.ts");

function createState(): Record<string, any> {
  return {
    toolCalls: new Map(),
    _pendingXmlToolCalls: [],
    _xmlInvokeBuffer: "",
    requestedThinking: false,
  };
}

function run(state: Record<string, any>, deltas: Array<Record<string, any>>) {
  const out: any[] = [];
  deltas.forEach((delta, i) => {
    const last = i === deltas.length - 1;
    const r = openaiToClaudeResponse(
      {
        id: "chatcmpl-x",
        model: "qwen3.8-flash-next",
        choices: [{ index: 0, delta, finish_reason: last ? "tool_calls" : null }],
        ...(last ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
      },
      state
    );
    if (r) out.push(...(r as any[]));
  });
  return out;
}

function textOf(events: any[]): string {
  return events
    .filter((e) => e.type === "content_block_delta" && e.delta?.type === "text_delta")
    .map((e) => e.delta.text)
    .join("");
}

test("reasoning + tool_use (no text): reasoning is NOT synthesized into a text block", () => {
  const events = run(createState(), [
    { reasoning_content: "Thinking about which tool to call. " },
    {
      tool_calls: [
        { index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: "" } },
      ],
    },
    { tool_calls: [{ index: 0, function: { arguments: '{"path":"calc.py"}' } }] },
    {},
  ]);
  assert.equal(
    events.some((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use"),
    true
  );
  assert.equal(textOf(events), "", `reasoning leaked into a text block: ${textOf(events)}`);
  assert.equal(
    events.some((e) => e.content_block?.type === "thinking"),
    false
  );
});

test("reasoning + text + tool_use: reasoning is NOT appended as a second text block", () => {
  const events = run(createState(), [
    { reasoning_content: "Let me think. " },
    { content: "Reading the file." },
    {
      tool_calls: [
        { index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: "{}" } },
      ],
    },
    {},
  ]);
  assert.equal(textOf(events), "Reading the file.");
});

test("reasoning-only response still synthesizes the text block (fix B preserved)", () => {
  const state = createState();
  const events = run(state, [{ reasoning_content: "Only reasoning here." }, {}]);
  assert.equal(textOf(events), "Only reasoning here.");
});
