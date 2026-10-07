import test from "node:test";
import assert from "node:assert/strict";
import { ctxProducedSignal, newStreamCtx } from "../../open-sse/executors/cursor";

// Regression guard for the cursor empty-tool-arg signal fix (91e33cfb9).
//
// Symptom this fix was battle-tested against: cursor truncates tool calls under
// load and emits a chunk with `finish_reason: "tool_calls"` and
// `arguments: ""` alongside 0 completion tokens. Before the fix,
// `ctxProducedSignal` used `ctx.toolCalls.length > 0`, so a bare tool-call name
// with no arguments counted as usable signal. That let the truncated turn
// finalize into a clean HTTP 200 that the quality gate accepted, while the
// client could not actually execute the argument-less call. The fix narrows the
// tool-call branch to tool calls that carry non-blank arguments, so the hop
// fails over to the next combo target instead of returning a hollow success.
//
// The function only reads toolCalls / receivedText / thinkingText / tokenDelta,
// so we build a real StreamCtx via newStreamCtx() and push plain tool-call
// objects (the fields the function reads) into it — no type fidelity needed.

function toolCall(argumentsJson: unknown) {
  return { id: "call_1", name: "get_weather", argumentsJson } as never;
}

function freshCtx() {
  return newStreamCtx("kimi-k3-high", () => {});
}

test("empty argumentsJson counts as no signal", () => {
  const ctx = freshCtx();
  ctx.toolCalls.push(toolCall(""));

  // Old code (`ctx.toolCalls.length > 0`) returned true here — that was the bug.
  assert.equal(ctxProducedSignal(ctx), false);
});

test("whitespace-only argumentsJson counts as no signal", () => {
  const ctx = freshCtx();
  ctx.toolCalls.push(toolCall(" \n\t"));

  assert.equal(ctxProducedSignal(ctx), false);
});

test("tool call with real arguments is still usable signal", () => {
  const ctx = freshCtx();
  ctx.toolCalls.push(toolCall('{"query":"hi"}'));

  assert.equal(ctxProducedSignal(ctx), true);
});

test("mixed tool calls: one with arguments is enough (some semantics)", () => {
  const ctx = freshCtx();
  ctx.toolCalls.push(toolCall(""), toolCall("{}"));

  assert.equal(ctxProducedSignal(ctx), true);
});

test("all-empty tool call array is no signal, decided by the toolCall branch alone", () => {
  const ctx = freshCtx();
  ctx.toolCalls.push(toolCall(""), toolCall("   "));

  // The other signal paths must stay false in this ctx, otherwise true/false
  // would be decided by receivedText/tokenDelta and the assertion would not
  // prove anything about the tool-call branch.
  assert.equal(ctx.receivedText, false);
  assert.equal(ctx.toolCalls.length, 2);
  assert.equal(ctx.tokenDelta, 0);
  assert.equal(ctx.thinkingText.length, 0);

  assert.equal(ctxProducedSignal(ctx), false);
});

test("receivedText control: text-only turn still yields signal with empty toolCalls", () => {
  const ctx = freshCtx();
  ctx.receivedText = true;
  assert.equal(ctx.toolCalls.length, 0);

  assert.equal(ctxProducedSignal(ctx), true);
});
