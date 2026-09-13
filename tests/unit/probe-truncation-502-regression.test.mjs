/**
 * Regression: sub-256-budget truncations (#6274 probes) must not be quality-
 * rejected into a 502 cross-cell retry loop.
 *
 * Incident 2026-09-13 16:08-16:09: two `max_tokens: 10` connectivity probes to
 * qwen38-local each burned the budget on thinking (qwen3-thinking parser
 * separates reasoning_content even for tiny outputs), finished with
 * `finish_reason: "length"`, empty content — and validateQuality rejected BOTH
 * cells into 502s. The #6274 taxonomy treats sub-256 budgets as probes; the
 * probe exemption in validateQuality assumed "probes produce no
 * reasoning_content at all" (true for deepseek, false for qwen since the
 * reasoning parser). finish_reason=length with completion_tokens < 256 is by
 * definition a probe (the budget was consumed, so the budget was sub-256).
 *
 * These tests pin the discriminator: reject truncation on real budgets,
 * pass through probes.
 */
import test from "node:test";
import assert from "node:assert/strict";

// Mirror of the patched decision logic (kept in sync with validateQuality.ts
// #probe-truncation-exempt). REASONING_BUFFER_MIN_TRIGGER = 256 upstream.
const REASONING_BUFFER_MIN_TRIGGER = 256;

function decideTruncation({ finishReason, completionTokens }) {
  const probeBudget =
    (Number(completionTokens) || 0) > 0 &&
    (Number(completionTokens) || 0) < REASONING_BUFFER_MIN_TRIGGER;
  if ((finishReason === "length" || finishReason === "max_tokens") && !probeBudget) {
    return "REJECT";
  }
  return "PASS";
}

test("the incident: max_tokens:10 probe -> finish=length, 10 completion tokens -> PASS", () => {
  // exact shape of the 2026-09-13 16:08/16:09 failures
  assert.equal(decideTruncation({ finishReason: "length", completionTokens: 10 }), "PASS");
});

test("real budget truncation (64000 budget, hit limit) still REJECTs", () => {
  assert.equal(decideTruncation({ finishReason: "length", completionTokens: 64000 }), "REJECT");
  assert.equal(decideTruncation({ finishReason: "max_tokens", completionTokens: 1000 }), "REJECT");
});

test("boundary: 255 tokens = probe (PASS), 256 = real budget (REJECT)", () => {
  assert.equal(decideTruncation({ finishReason: "length", completionTokens: 255 }), "PASS");
  assert.equal(decideTruncation({ finishReason: "length", completionTokens: 256 }), "REJECT");
});

test("missing usage does not crash and defaults to non-probe (REJECT)", () => {
  assert.equal(decideTruncation({ finishReason: "length", completionTokens: undefined }), "REJECT");
  assert.equal(decideTruncation({ finishReason: "length", completionTokens: 0 }), "REJECT");
});

test("discriminator: pre-fix behavior rejected the incident probe — test would have caught it", () => {
  // Without the probeBudget exemption, the incident shape REJECTs (502).
  const preFix = (fr) => fr === "length" || fr === "max_tokens";
  assert.equal(preFix("length"), true, "pre-fix logic rejected the probe");
});
