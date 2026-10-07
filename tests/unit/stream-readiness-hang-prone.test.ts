import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveStreamReadinessTimeout } from "../../open-sse/utils/streamReadinessPolicy.ts";

const messages = Array.from({ length: 181 }, () => ({ role: "user", content: "hello" }));
const resolve = (provider: string, model: string) =>
  resolveStreamReadinessTimeout({ provider, model, baseTimeoutMs: 80_000, body: { messages } });

test("cursor Kimi stall cap wins over history and reasoning warm-up", () => {
  for (const model of ["kimi-k3-high", "cursor/kimi-k3-high", "Cursor/Kimi-K3-High"]) {
    const result = resolve("cursor", model);
    assert.equal(result.timeoutMs, 90_000);
    assert.ok(result.reasons.includes("hang_prone_stall_fast_fail"));
  }
});

test("stall cap does not change other providers or near-miss models", () => {
  for (const provider of ["moonshot", "openrouter", "cursor-api"]) {
    assert.ok(!resolve(provider, "kimi-k3-high").reasons.includes("hang_prone_stall_fast_fail"));
  }
  for (const model of ["kimi-k3", "kimi-k3-high-1m", "grok-4.6-high"]) {
    assert.ok(!resolve("cursor", model).reasons.includes("hang_prone_stall_fast_fail"));
  }
});

test("stall cap preserves short windows and the configured ceiling", () => {
  const result = resolveStreamReadinessTimeout({
    provider: "cursor", model: "kimi-k3-high", baseTimeoutMs: 10_000, maxTimeoutMs: 30_000,
    body: { messages: [] },
  });
  assert.equal(result.timeoutMs, 30_000);
  const short = resolveStreamReadinessTimeout({
    provider: "cursor", model: "kimi-k3-high", baseTimeoutMs: 10_000, body: { messages: [] },
  });
  assert.equal(short.timeoutMs, 40_000);
});

test("long cursor source history keeps its ceiling except for stalled Kimi", () => {
  const sourceBody = { input: messages };
  const body = { messages: [{ role: "user", content: "flattened history" }] };
  const normal = resolveStreamReadinessTimeout({
    provider: "cursor", model: "grok-4.6-high", baseTimeoutMs: 80_000, body, sourceBody,
  });
  assert.equal(normal.timeoutMs, normal.maxTimeoutMs);
  const stalled = resolveStreamReadinessTimeout({
    provider: "cursor", model: "kimi-k3-high", baseTimeoutMs: 80_000, body, sourceBody,
  });
  assert.equal(stalled.timeoutMs, 90_000);
  assert.ok(stalled.reasons.includes("cursor_long_history"));
});
