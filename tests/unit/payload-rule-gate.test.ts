import test from "node:test";
import assert from "node:assert/strict";
import { runGoldenGate } from "../../scripts/payload-rules/gate.mjs";

test("golden gate passes a rule that only appends to matched prompts", async () => {
  const result = await runGoldenGate({
    rules: {
      transform: [
        {
          models: [{ name: "test-model-*" }],
          ops: [{ op: "append", path: "messages.0.content", value: " OK" }],
        },
      ],
    },
    golden: [
      { name: "short", model: "test-model-x", payload: { messages: [{ role: "user", content: "hi" }] }, expect: { messages: [{ role: "user", content: "hi OK" }] } },
      { name: "nomatch", model: "other-model", payload: { messages: [{ role: "user", content: "hi" }] }, expect: { messages: [{ role: "user", content: "hi" }] } },
    ],
  });
  assert.equal(result.passed, true);
  assert.equal(result.failures.length, 0);
  assert.equal(result.cases.length, 2);
});

test("golden gate fails when transform breaks an expected payload", async () => {
  const result = await runGoldenGate({
    rules: {
      transform: [
        {
          models: [{ name: "*" }],
          ops: [{ op: "replace", path: "messages.0.content", search: "hi", replace: "XX" }],
        },
      ],
    },
    golden: [
      { name: "must-not-change", model: "other-model", payload: { messages: [{ role: "user", content: "hi" }] }, expect: { messages: [{ role: "user", content: "hi" }] } },
    ],
  });
  assert.equal(result.passed, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /must-not-change/);
});

test("golden gate fails on invalid regex rule before any replay", async () => {
  const result = await runGoldenGate({
    rules: {
      transform: [
        {
          models: [{ name: "*" }],
          ops: [{ op: "regex", path: "messages.0.content", pattern: "([unclosed", replace: "x" }],
        },
      ],
    },
    golden: [],
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => /pattern/i.test(f)));
});

test("golden gate enforces coverage: a rule matching no golden case fails", async () => {
  const result = await runGoldenGate({
    rules: {
      transform: [
        {
          models: [{ name: "never-*" }],
          ops: [{ op: "append", path: "messages.0.content", value: " x" }],
        },
      ],
    },
    golden: [
      { name: "only-case", model: "other", payload: { messages: [{ role: "user", content: "hi" }] }, expect: { messages: [{ role: "user", content: "hi" }] } },
    ],
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => /coverage/i.test(f)));
});
