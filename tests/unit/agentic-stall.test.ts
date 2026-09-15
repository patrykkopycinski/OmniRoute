/**
 * tests/unit/agentic-stall.test.ts — kanban t_1ebaf474
 *
 * The agentic-stall guard classifies a quality-valid 200 as a mid-turn stall
 * (stop + summary/narration, no tool call, tool-result tail) so the combo loop
 * fails over instead of returning the stall to the client. These tests pin:
 *  - the request-shape gate (tools + tool-result tail, both API shapes),
 *  - the narration heuristic (summary markers + short structureless prose),
 *  - full classification over OpenAI/Anthropic × JSON/SSE response shapes,
 *  - the positive controls (no tools pending / real tool call / structured
 *    answer are NEVER classified),
 *  - the env kill switch.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  AGENTIC_STALL_SIGNATURE,
  classifyAgenticStallResponse,
  contentLooksLikeStallNarration,
  requestExpectsToolCall,
} from "../../open-sse/services/combo/agenticStall.ts";

const TOOLS = [{ type: "function", function: { name: "read_file" } }];

function openAiToolTailBody() {
  return {
    model: "some/model",
    tools: TOOLS,
    messages: [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: "file contents…" },
    ],
  };
}

function anthropicToolTailBody() {
  return {
    model: "some/model",
    tools: TOOLS,
    messages: [
      { role: "user", content: "fix the bug" },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents…" }],
      },
    ],
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(payload: string): Response {
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const STALL_TEXT =
  "<summary>\n## Overview\nThe session expanded from a changelog review into a full sweep of open PRs…\n</summary>";

describe("requestExpectsToolCall", () => {
  test("OpenAI shape: tools + role:tool tail → true", () => {
    assert.equal(requestExpectsToolCall(openAiToolTailBody()), true);
  });

  test("Anthropic shape: tools + tool_result tail → true", () => {
    assert.equal(requestExpectsToolCall(anthropicToolTailBody()), true);
  });

  test("no tools → false (positive control: plain question)", () => {
    assert.equal(
      requestExpectsToolCall({ messages: [{ role: "tool", content: "x" }] }),
      false
    );
  });

  test("tools but tail is a plain user message → false", () => {
    assert.equal(
      requestExpectsToolCall({
        tools: TOOLS,
        messages: [{ role: "user", content: "what is 2+2?" }],
      }),
      false
    );
  });

  test("Anthropic tools but tail user text-only → false", () => {
    assert.equal(
      requestExpectsToolCall({
        tools: TOOLS,
        messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
      }),
      false
    );
  });

  test("garbage body → false", () => {
    assert.equal(requestExpectsToolCall(null), false);
    assert.equal(requestExpectsToolCall("nope"), false);
    assert.equal(requestExpectsToolCall({ tools: TOOLS, messages: [] }), false);
  });
});

describe("contentLooksLikeStallNarration", () => {
  test("summary block → stall shape", () => {
    assert.equal(contentLooksLikeStallNarration(STALL_TEXT), true);
  });

  test("markdown summary heading → stall shape", () => {
    assert.equal(contentLooksLikeStallNarration("# Summary\nwe did things and more"), true);
  });

  test("'Summary:' prose opener → stall shape", () => {
    assert.equal(contentLooksLikeStallNarration("Summary: fixed three PRs today"), true);
  });

  test("short structureless ack ('Nothing to save.') → stall shape", () => {
    assert.equal(contentLooksLikeStallNarration("Nothing to save."), true);
  });

  test("structured answer (list) → NOT stall shape", () => {
    assert.equal(
      contentLooksLikeStallNarration("Done:\n- fixed the parser\n- added a test"),
      false
    );
  });

  test("answer with code fence → NOT stall shape", () => {
    assert.equal(
      contentLooksLikeStallNarration("Apply this:\n```ts\nfoo();\n```"),
      false
    );
  });

  test("long prose answer → NOT stall shape", () => {
    const long = "The root cause is a stale cache entry in the routing layer. ".repeat(6);
    assert.equal(long.trim().length > 240, true);
    assert.equal(contentLooksLikeStallNarration(long), false);
  });

  test("empty content → NOT stall shape (quality gates own that case)", () => {
    assert.equal(contentLooksLikeStallNarration(""), false);
    assert.equal(contentLooksLikeStallNarration("   "), false);
  });
});

describe("classifyAgenticStallResponse", () => {
  beforeEach(() => {
    delete process.env.OMNIROUTE_AGENTIC_STALL_FAILOVER;
  });
  afterEach(() => {
    delete process.env.OMNIROUTE_AGENTIC_STALL_FAILOVER;
  });

  test("OpenAI JSON: stop + summary, no tool_calls, tool tail → STALL", async () => {
    const verdict = await classifyAgenticStallResponse({
      body: openAiToolTailBody(),
      response: jsonResponse({
        choices: [
          { finish_reason: "stop", message: { role: "assistant", content: STALL_TEXT } },
        ],
      }),
    });
    assert.ok(verdict);
    assert.equal(verdict.signature, AGENTIC_STALL_SIGNATURE);
  });

  test("OpenAI JSON: same shape WITH tool_calls → not a stall", async () => {
    const verdict = await classifyAgenticStallResponse({
      body: openAiToolTailBody(),
      response: jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: STALL_TEXT,
              tool_calls: [{ id: "c2", function: { name: "read_file", arguments: "{}" } }],
            },
          },
        ],
      }),
    });
    assert.equal(verdict, null);
  });

  test("OpenAI JSON: finish_reason 'length' → not a stall", async () => {
    const verdict = await classifyAgenticStallResponse({
      body: openAiToolTailBody(),
      response: jsonResponse({
        choices: [
          { finish_reason: "length", message: { role: "assistant", content: STALL_TEXT } },
        ],
      }),
    });
    assert.equal(verdict, null);
  });

  test("OpenAI JSON: stop + structured answer → not a stall", async () => {
    const verdict = await classifyAgenticStallResponse({
      body: openAiToolTailBody(),
      response: jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "Fixed:\n- parser null check\n- new unit test" },
          },
        ],
      }),
    });
    assert.equal(verdict, null);
  });

  test("positive control: legitimate text answer, no tools pending → not a stall", async () => {
    const verdict = await classifyAgenticStallResponse({
      body: { messages: [{ role: "user", content: "summarize this chat" }] },
      response: jsonResponse({
        choices: [
          { finish_reason: "stop", message: { role: "assistant", content: STALL_TEXT } },
        ],
      }),
    });
    assert.equal(verdict, null);
  });

  test("Anthropic JSON: end_turn + text-only, tool_result tail → STALL", async () => {
    const verdict = await classifyAgenticStallResponse({
      body: anthropicToolTailBody(),
      response: jsonResponse({
        type: "message",
        stop_reason: "end_turn",
        content: [{ type: "text", text: STALL_TEXT }],
      }),
    });
    assert.ok(verdict);
    assert.equal(verdict.signature, AGENTIC_STALL_SIGNATURE);
  });

  test("Anthropic JSON: end_turn WITH tool_use block → not a stall", async () => {
    const verdict = await classifyAgenticStallResponse({
      body: anthropicToolTailBody(),
      response: jsonResponse({
        type: "message",
        stop_reason: "end_turn",
        content: [
          { type: "text", text: STALL_TEXT },
          { type: "tool_use", id: "t2", name: "read_file", input: {} },
        ],
      }),
    });
    assert.equal(verdict, null);
  });

  test("OpenAI SSE: summary chunks + finish stop → STALL", async () => {
    const sse =
      `data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{"content":${JSON.stringify(STALL_TEXT.slice(0, 40))}},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{"content":${JSON.stringify(STALL_TEXT.slice(40))}},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;
    const verdict = await classifyAgenticStallResponse({
      body: openAiToolTailBody(),
      response: sseResponse(sse),
    });
    assert.ok(verdict);
    assert.equal(verdict.signature, AGENTIC_STALL_SIGNATURE);
  });

  test("OpenAI SSE: tool_calls delta present → not a stall", async () => {
    const sse =
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file"}}]},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n` +
      `data: [DONE]\n\n`;
    const verdict = await classifyAgenticStallResponse({
      body: openAiToolTailBody(),
      response: sseResponse(sse),
    });
    assert.equal(verdict, null);
  });

  test("Anthropic SSE: text blocks + end_turn → STALL", async () => {
    const sse =
      `event: message_start\ndata: {"type":"message_start"}\n\n` +
      `event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text","text":""}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":${JSON.stringify(STALL_TEXT)}}}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    const verdict = await classifyAgenticStallResponse({
      body: anthropicToolTailBody(),
      response: sseResponse(sse),
    });
    assert.ok(verdict);
    assert.equal(verdict.signature, AGENTIC_STALL_SIGNATURE);
  });

  test("Anthropic SSE: tool_use block start → not a stall", async () => {
    const sse =
      `event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"t3","name":"read_file"}}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n`;
    const verdict = await classifyAgenticStallResponse({
      body: anthropicToolTailBody(),
      response: sseResponse(sse),
    });
    assert.equal(verdict, null);
  });

  test("short ack over SSE ('Nothing to save.') → STALL", async () => {
    const sse =
      `data: {"choices":[{"delta":{"content":"Nothing to save."},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;
    const verdict = await classifyAgenticStallResponse({
      body: openAiToolTailBody(),
      response: sseResponse(sse),
    });
    assert.ok(verdict);
    assert.equal(verdict.signature, AGENTIC_STALL_SIGNATURE);
  });

  test("kill switch: OMNIROUTE_AGENTIC_STALL_FAILOVER=0 → never classifies", async () => {
    process.env.OMNIROUTE_AGENTIC_STALL_FAILOVER = "0";
    const verdict = await classifyAgenticStallResponse({
      body: openAiToolTailBody(),
      response: jsonResponse({
        choices: [
          { finish_reason: "stop", message: { role: "assistant", content: STALL_TEXT } },
        ],
      }),
    });
    assert.equal(verdict, null);
  });

  test("unrecognized content-type → null (cannot classify, never breaks path)", async () => {
    const verdict = await classifyAgenticStallResponse({
      body: openAiToolTailBody(),
      response: new Response("plain text", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    });
    assert.equal(verdict, null);
  });

  test("original response body is NOT consumed (clone-only contract)", async () => {
    const response = jsonResponse({
      choices: [
        { finish_reason: "stop", message: { role: "assistant", content: STALL_TEXT } },
      ],
    });
    const verdict = await classifyAgenticStallResponse({
      body: openAiToolTailBody(),
      response,
    });
    assert.ok(verdict);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, STALL_TEXT);
  });
});
