import test from "node:test";
import assert from "node:assert/strict";

import { applyReasoningInputPolicy } from "../../open-sse/services/reasoningInputPolicy.ts";

// Incident 2026-09-14: combo best-reasoning-paid -> moonshot/k3-256k returned
// [400] "the reasoning_details at position 94 entry 0 has an invalid type" and
// "must not contain streaming index". Root cause: Claude-style
// `{type:"thinking", thinking}` details echoed into chat history are invisible
// to inspectChatReasoning (checks text/content keys only), so the drop pass
// never ran and foreign shapes reached kimi's strict input validator. The
// failover storm then tripped the admission heap guard -> global 503.

function policy(body: Record<string, unknown>, provider = "moonshot") {
  return applyReasoningInputPolicy(body, "chat", { provider });
}

test("foreign thinking-block reasoning_details are dropped on chat input", () => {
  const body = {
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "ok",
        reasoning_details: [{ type: "thinking", thinking: "internal chain" }],
      },
      { role: "user", content: "continue" },
    ],
  };
  policy(body);
  const assistant = body.messages[1] as Record<string, unknown>;
  assert.equal(assistant.reasoning_details, undefined);
});

test("streaming_index is stripped from portable reasoning_details entries", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: "ok",
        reasoning_details: [
          { type: "reasoning_text", text: "valid reasoning", streaming_index: 3 },
        ],
      },
      { role: "user", content: "continue" },
    ],
  };
  policy(body);
  const details = (body.messages[0] as Record<string, unknown>).reasoning_details as unknown[];
  assert.equal(details.length, 1);
  assert.deepEqual(details[0], { type: "reasoning_text", text: "valid reasoning" });
});

test("mixed state onto plaintext transport keeps only the portable plaintext entry", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: "ok",
        reasoning_details: [
          { type: "reasoning_text", text: "portable" },
          { type: "reasoning.encrypted", data: "opaque-blob" },
        ],
      },
      { role: "user", content: "continue" },
    ],
  };
  policy(body);
  // #10949 projection: mixed input onto a plaintext transport drops the opaque
  // entry; the scrub itself must not have removed the portable plaintext one.
  const details = (body.messages[0] as Record<string, unknown>).reasoning_details as unknown[];
  assert.equal(details.length, 1);
  assert.deepEqual(details[0], { type: "reasoning_text", text: "portable" });
});

test("summary details are portable and kept", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: "ok",
        reasoning_details: [{ type: "summary", summary_text: "did a thing" }],
      },
      { role: "user", content: "continue" },
    ],
  };
  policy(body);
  const details = (body.messages[0] as Record<string, unknown>).reasoning_details as unknown[];
  assert.equal(details.length, 1);
});

test("empty-after-scrub reasoning_details key is removed entirely", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: "ok",
        reasoning_details: [{ type: "thinking", thinking: "x" }, { type: "stream" }],
      },
      { role: "user", content: "continue" },
    ],
  };
  policy(body);
  const assistant = body.messages[0] as Record<string, unknown>;
  assert.equal("reasoning_details" in assistant, false);
});

test("non-assistant messages carrying reasoning_details are left alone", () => {
  const body = {
    messages: [
      { role: "tool", content: "result", reasoning_details: [{ type: "thinking", thinking: "x" }] },
      { role: "user", content: "continue" },
    ],
  };
  policy(body);
  const toolMsg = body.messages[0] as Record<string, unknown>;
  assert.ok(Array.isArray(toolMsg.reasoning_details));
});
