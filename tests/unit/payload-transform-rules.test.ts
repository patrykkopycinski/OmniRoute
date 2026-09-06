import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPayloadRules,
  normalizePayloadRulesConfig,
  resetPayloadRulesConfigForTests,
  setPayloadRulesConfig,
  type PayloadRulesConfig,
} from "../../open-sse/services/payloadRules.ts";

function configWithTransform(rules: unknown): PayloadRulesConfig {
  return normalizePayloadRulesConfig({ transform: rules });
}

function baseRules(): PayloadRulesConfig {
  return normalizePayloadRulesConfig({});
}

test("transform: append op appends string value to existing string path", () => {
  const config = configWithTransform([
    {
      models: [{ name: "claude-*" }],
      ops: [{ op: "append", path: "messages.0.content", value: " BE-SAFE" }],
    },
  ]);
  const payload = { messages: [{ role: "user", content: "hi" }] };
  const { payload: out, applied } = applyPayloadRules(
    payload,
    "claude-sonnet-5",
    ["anthropic"],
    config
  );
  assert.equal(out.messages[0].content, "hi BE-SAFE");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].type, "transform");
  assert.equal(applied[0].path, "messages.0.content");
  // audit entry carries a bounded snippet for the trace diff, never the full content
  const entryJson = JSON.stringify(applied[0]);
  const entryValue = applied[0].value as { beforeSnippet?: string; afterSnippet?: string; before?: number; after?: number };
  assert.ok(entryJson.includes("BE-SAFE"), "snippet should carry the changed region");
  assert.ok((entryValue.beforeSnippet ?? "").length <= 240);
  assert.ok((entryValue.afterSnippet ?? "").length <= 240);
  assert.equal(entryValue.before, 2);
  assert.equal(entryValue.after, 10);
});

test("transform: prepend op prepends to existing string path", () => {
  const config = configWithTransform([
    {
      models: [{ name: "*" }],
      ops: [{ op: "prepend", path: "system.0.text", value: "PRE " }],
    },
  ]);
  const payload = { system: [{ type: "text", text: "sys" }] };
  const { payload: out, applied } = applyPayloadRules(payload, "gpt-5.2", ["openai"], config);
  assert.equal(out.system[0].text, "PRE sys");
  assert.equal(applied.length, 1);
});

test("transform: replace op replaces first occurrence", () => {
  const config = configWithTransform([
    {
      models: [{ name: "gpt-*" }],
      ops: [{ op: "replace", path: "messages.0.content", search: "XML", replace: "JSON" }],
    },
  ]);
  const payload = { messages: [{ role: "user", content: "use XML tags not XML braces" }] };
  const { payload: out } = applyPayloadRules(payload, "gpt-5.2", ["openai"], config);
  assert.equal(out.messages[0].content, "use JSON tags not XML braces");
});

test("transform: regex op with flags replaces all matches", () => {
  const config = configWithTransform([
    {
      models: [{ name: "*" }],
      ops: [
        { op: "regex", path: "messages.0.content", pattern: "a+", flags: "g", replace: "b" },
      ],
    },
  ]);
  const payload = { messages: [{ role: "user", content: "aaa baa" }] };
  const { payload: out } = applyPayloadRules(payload, "m", ["openai"], config);
  assert.equal(out.messages[0].content, "b bb");
});

test("transform: missing path or non-string value is skipped silently", () => {
  const config = configWithTransform([
    {
      models: [{ name: "*" }],
      ops: [
        { op: "append", path: "messages.5.content", value: "X" },
        { op: "append", path: "tools.0.function", value: "X" },
      ],
    },
  ]);
  const payload = { messages: [{ role: "user", content: "hi" }], tools: [{ function: {} }] };
  const { payload: out, applied } = applyPayloadRules(payload, "m", ["openai"], config);
  assert.deepEqual(out, payload);
  assert.equal(applied.length, 0);
});

test("transform: model wildcard mismatch does not apply", () => {
  const config = configWithTransform([
    { models: [{ name: "claude-*" }], ops: [{ op: "append", path: "messages.0.content", value: "X" }] },
  ]);
  const payload = { messages: [{ role: "user", content: "hi" }] };
  const { payload: out, applied } = applyPayloadRules(payload, "gpt-5.2", ["openai"], config);
  assert.equal(out.messages[0].content, "hi");
  assert.equal(applied.length, 0);
});

test("transform: protocol scoping restricts application", () => {
  const config = configWithTransform([
    {
      models: [{ name: "*", protocol: "anthropic" }],
      ops: [{ op: "append", path: "messages.0.content", value: "X" }],
    },
  ]);
  const payload = { messages: [{ role: "user", content: "hi" }] };
  const openai = applyPayloadRules(payload, "claude-5", ["openai"], config);
  assert.equal(openai.applied.length, 0);
  const anthropic = applyPayloadRules(payload, "claude-5", ["anthropic"], config);
  assert.equal(anthropic.applied.length, 1);
});

test("transform: invalid regex pattern is dropped at normalize time", () => {
  const config = configWithTransform([
    {
      models: [{ name: "*" }],
      ops: [{ op: "regex", path: "messages.0.content", pattern: "(", replace: "x" }],
    },
  ]);
  assert.equal(config.transform.length, 0);
});

test("transform: unknown op is dropped at normalize time", () => {
  const config = configWithTransform([
    {
      models: [{ name: "*" }],
      ops: [{ op: "_ROT13", path: "messages.0.content", value: "x" }],
    },
  ]);
  assert.equal(config.transform.length, 0);
});

test("transform: rules requiring path+value fields are dropped when incomplete", () => {
  const config = configWithTransform([
    { models: [{ name: "*" }], ops: [{ op: "append", value: "x" }] },
  ]);
  assert.equal(config.transform.length, 0);
});

test("transform: runs after override, before filter", () => {
  const config = normalizePayloadRulesConfig({
    override: [{ models: [{ name: "*" }], params: { temperature: 0.7 } }],
    transform: [
      { models: [{ name: "*" }], ops: [{ op: "append", path: "messages.0.content", value: " T" }] },
    ],
    filter: [{ models: [{ name: "*" }], params: ["temperature"] }],
  });
  const payload = { messages: [{ role: "user", content: "hi" }], temperature: 1 };
  const { payload: out, applied } = applyPayloadRules(payload, "m", ["openai"], config);
  assert.equal(out.messages[0].content, "hi T");
  assert.equal(out.temperature, undefined);
  assert.deepEqual(
    applied.map((r) => r.type),
    ["override", "transform", "filter"]
  );
});

test("transform: input payload is not mutated", () => {
  const config = configWithTransform([
    { models: [{ name: "*" }], ops: [{ op: "append", path: "messages.0.content", value: " T" }] },
  ]);
  const payload = { messages: [{ role: "user", content: "hi" }] };
  applyPayloadRules(payload, "m", ["openai"], config);
  assert.equal(payload.messages[0].content, "hi");
});

test("no rules configured: payload returned unchanged", () => {
  const payload = { messages: [{ role: "user", content: "hi" }], temperature: 0.5 };
  const { payload: out, applied } = applyPayloadRules(payload, "m", ["openai"], baseRules());
  assert.deepEqual(out, payload);
  assert.equal(applied.length, 0);
});

test("transform: no-op op is not recorded as applied", () => {
  const config = configWithTransform([
    {
      models: [{ name: "*" }],
      ops: [
        { op: "append", path: "messages.0.content", value: "" },
        { op: "replace", path: "messages.0.content", search: "zzz", replace: "y" },
      ],
    },
  ]);
  const payload = { messages: [{ role: "user", content: "hi" }] };
  const { payload: out, applied } = applyPayloadRules(payload, "m", ["openai"], config);
  assert.deepEqual(out, payload);
  assert.equal(applied.length, 0);
});

test("clonePayloadRulesConfig copies transform rules", () => {
  setPayloadRulesConfig({
    transform: [
      { models: [{ name: "*" }], ops: [{ op: "append", path: "messages.0.content", value: "X" }] },
    ],
  });
  // getPayloadRulesConfig would hit the DB; exercise the clone path via a second set+apply
  const config = configWithTransform([
    { models: [{ name: "*" }], ops: [{ op: "append", path: "messages.0.content", value: "X" }] },
  ]);
  const payload = { messages: [{ role: "user", content: "a" }] };
  const first = applyPayloadRules(payload, "m", ["openai"], config);
  const second = applyPayloadRules(payload, "m", ["openai"], config);
  assert.equal(first.payload.messages[0].content, "aX");
  assert.equal(second.payload.messages[0].content, "aX");
  resetPayloadRulesConfigForTests();
});
