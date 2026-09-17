// chatPressureWeight.ts — the ONE definition of "small enough to admit while the
// gateway is under CRITICAL resource pressure".
//
// The pressure gates used to refuse every chat request, including a 5-token
// health ping. That blanket refusal is what killed agent workers (they burn
// their retry budget on 5xx) while the cgroup ceiling still had headroom above
// the V8 line that tripped the guard. These tests pin the classifier that both
// the pre-read admission gate and the post-parse provider-work guards consult —
// if the two layers disagreed, a small request admitted at the gate would still
// be 503'd one layer up.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_HEAVY_ESTIMATED_TOKENS,
  CHAT_HEAVY_MESSAGE_COUNT,
  CHAT_HEAVY_TOOL_COUNT,
  CHAT_LARGE_BODY_BYTES,
  DEFAULT_CHAT_PRESSURE_BOUNDS,
  chatPressureFacts,
  classifyChatPressureWeight,
  classifyParsedRequestBodyWeight,
  type ChatPressureFacts,
} from "../../src/shared/middleware/chatPressureWeight.ts";

// Small, explicit bounds keep every case readable and independent of env.
const bounds = { largeBodyBytes: 1_000, heavyMessages: 3, heavyTools: 2, heavyTokens: 50 };
const weightOf = (facts: ChatPressureFacts) => classifyChatPressureWeight(facts, bounds);

test("declared bounds mirror the env-resolved constants", () => {
  assert.deepEqual(DEFAULT_CHAT_PRESSURE_BOUNDS, {
    largeBodyBytes: CHAT_LARGE_BODY_BYTES,
    heavyMessages: CHAT_HEAVY_MESSAGE_COUNT,
    heavyTools: CHAT_HEAVY_TOOL_COUNT,
    heavyTokens: CHAT_HEAVY_ESTIMATED_TOKENS,
  });
  const defaults = classifyChatPressureWeight({ bodyBytes: 128 }, DEFAULT_CHAT_PRESSURE_BOUNDS);
  assert.equal(defaults, "light", "a 128-byte ping is light under the real defaults");
});

test("every dimension small → light", () => {
  assert.equal(weightOf({ bodyBytes: 999, messageCount: 2, toolCount: 1, tokens: 49 }), "light");
});

test("thresholds are inclusive — reaching one alone makes the request heavy", () => {
  assert.equal(weightOf({ bodyBytes: 1_000 }), "heavy", "declared bytes at the bound");
  assert.equal(weightOf({ messageCount: 3 }), "heavy", "message count at the bound");
  assert.equal(weightOf({ toolCount: 2 }), "heavy", "tool count at the bound");
  assert.equal(weightOf({ tokens: 50 }), "heavy", "token estimate at the bound");
});

test("one heavy dimension outweighs the others being small", () => {
  assert.equal(
    weightOf({ bodyBytes: 10, messageCount: 1, toolCount: 0, tokens: 1 }),
    "light",
    "control: all dimensions small"
  );
  assert.equal(
    classifyChatPressureWeight({ bodyBytes: 10, messageCount: 9 }, bounds),
    "heavy",
    "an agent-shaped message history wins over a tiny body"
  );
});

test("no evidence is heavy, not light", () => {
  assert.equal(weightOf({}), "heavy", "nothing known ⇒ cannot be proven small");
  assert.equal(weightOf({ bodyBytes: null }), "heavy", "chunked body ⇒ size unknown");
  assert.equal(
    weightOf({ messageCount: null, toolCount: null, tokens: null }),
    "heavy",
    "explicit nulls are unknowns, never zero"
  );
  assert.equal(weightOf({ bodyBytes: 0 }), "light", "a declared zero IS evidence of small");
});

test("parsed bodies classify on structure", () => {
  const small = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(classifyParsedRequestBodyWeight(small, bounds), "light");

  const manyMessages = {
    messages: Array.from({ length: 3 }, () => ({ role: "user", content: "hi" })),
  };
  assert.equal(classifyParsedRequestBodyWeight(manyMessages, bounds), "heavy");

  const manyTools = { messages: [{ role: "user", content: "hi" }], tools: [{}, {}] };
  assert.equal(classifyParsedRequestBodyWeight(manyTools, bounds), "heavy");

  // Responses-API shape: `input` is the message carrier.
  const responsesShape = { input: [{ role: "user", content: "hi" }, { role: "user", content: "x" }] };
  assert.equal(classifyParsedRequestBodyWeight(responsesShape, bounds), "light");
  assert.equal(
    chatPressureFacts(responsesShape, bounds).messageCount,
    2,
    "input entries count as messages"
  );
});

test("a large payload inside the messages is heavy even with few messages", () => {
  const huge = { messages: [{ role: "user", content: "x".repeat(5_000) }] };
  assert.equal(
    classifyParsedRequestBodyWeight(huge, bounds),
    "heavy",
    "the bounded token estimate must reach the token bound"
  );
});

test("an unterminated/unmeasurable body is heavy", () => {
  assert.equal(classifyParsedRequestBodyWeight(undefined, bounds), "heavy");
  assert.equal(classifyParsedRequestBodyWeight(null, bounds), "heavy");
  assert.equal(classifyParsedRequestBodyWeight("a string body", bounds), "heavy");
  assert.equal(classifyParsedRequestBodyWeight([], bounds), "heavy");
  assert.equal(
    classifyParsedRequestBodyWeight({ prompt: "x".repeat(10_000) }, bounds),
    "heavy",
    "an envelope with no messages/input/tools cannot be measured, so it is never light"
  );
});

test("an empty message list is evidence of a small request", () => {
  assert.equal(classifyParsedRequestBodyWeight({ messages: [] }, bounds), "light");
  assert.deepEqual(chatPressureFacts({ messages: [] }, bounds), {
    messageCount: 0,
    toolCount: 0,
    tokens: 0,
  });
});
