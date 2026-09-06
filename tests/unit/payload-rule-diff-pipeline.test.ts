import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPayloadRules, setPayloadRulesConfig, resetPayloadRulesConfigForTests } from "../../open-sse/services/payloadRules.ts";
import { createRequestLogger } from "../../open-sse/utils/requestLogger.ts";

function configWithTransform(rules) {
  return {
    default: [], override: [], filter: [], defaultRaw: [],
    transform: rules.map((r) => ({
      models: r.models ?? [{ name: "*" }],
      ops: r.ops,
    })),
  };
}

test("transform entries carry bounded before/after snippets for diff display", () => {
  setPayloadRulesConfig(configWithTransform([
    { ops: [{ op: "append", path: "messages.0.content", value: " [X]" }] },
  ]));
  const { payload, applied } = applyPayloadRules(
    { messages: [{ role: "user", content: "hello world this is a longer prompt for context" }] },
    "m", ["openai"], configWithTransform([
      { ops: [{ op: "append", path: "messages.0.content", value: " [X]" }] },
    ])
  );
  assert.equal(payload.messages[0].content, "hello world this is a longer prompt for context [X]");
  const entry = applied.find((a) => a.type === "transform");
  assert.ok(entry, "transform entry recorded");
  const value = entry.value;
  assert.equal(value.op, "append");
  assert.equal(value.before, 47);
  assert.equal(value.after, 51);
  assert.ok(typeof value.beforeSnippet === "string" && value.beforeSnippet.length > 0);
  assert.ok(value.afterSnippet.includes("[X]"));
  // snippets are bounded
  assert.ok(value.beforeSnippet.length <= 200 + 40);
  assert.ok(value.afterSnippet.length <= 200 + 40);
});

test("requestLogger.logPayloadRuleDiff stores entries in pipeline payloads", async () => {
  const logger = await createRequestLogger({ enabled: true });
  logger.logPayloadRuleDiff([
    { type: "transform", path: "messages.0.content", value: { op: "append", before: 5, after: 9, beforeSnippet: "hello", afterSnippet: "hello [X]" } },
  ]);
  const payloads = logger.getPipelinePayloads();
  assert.ok(payloads);
  assert.ok(Array.isArray(payloads.payloadRuleDiff.entries));
  assert.equal(payloads.payloadRuleDiff.entries.length, 1);
  assert.equal(payloads.payloadRuleDiff.entries[0].type, "transform");
  assert.match(JSON.stringify(payloads.payloadRuleDiff.entries[0].value.afterSnippet), /hello \[X\]/);
});

test("requestLogger.logPayloadRuleDiff ignores empty input", async () => {
  const logger = await createRequestLogger({ enabled: true });
  logger.logPayloadRuleDiff([]);
  const payloads = logger.getPipelinePayloads();
  assert.equal(payloads?.payloadRuleDiff ?? null, null);
});

test("prepareUpstreamBody reports applied rules via onAppliedRules", async () => {
  const { prepareUpstreamBody } = await import("../../open-sse/handlers/chatCore/upstreamBody.ts");
  setPayloadRulesConfig(configWithTransform([
    { ops: [{ op: "append", path: "messages.0.content", value: " [ADAPT]" }] },
  ]));
  const seen = [];
  const body = await prepareUpstreamBody({
    translatedBody: { model: "test-model-x", messages: [{ role: "user", content: "hi" }] },
    modelToCall: "test-model-x",
    provider: "openai-compatible-chat",
    targetFormat: "openai",
    credentials: null,
    onAppliedRules: (applied) => seen.push(...applied),
  });
  assert.equal(body.messages[0].content, "hi [ADAPT]");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "transform");
  assert.equal(seen[0].value.afterSnippet, "hi [ADAPT]");
});

test.after(() => {
  resetPayloadRulesConfigForTests();
});
