import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateFinalInputTokenBreakdown,
  estimateFinalInputTokens,
  estimateCalibratedFinalInputTokens,
  GATE_CHARS_PER_TOKEN,
  gateBudgetToCompressionTokens,
} from "../../open-sse/handlers/chatCore/contextEstimation.ts";
import { estimateTokens } from "../../open-sse/services/contextManager.ts";
import {
  recordEstimatorCalibrationFromUsage,
  resetEstimatorCalibrationForTests,
} from "../../open-sse/services/estimatorCalibration.ts";

test("estimateFinalInputTokens counts nested request contents and auxiliary fields", () => {
  const contents = [{ role: "user", parts: [{ text: "nested Gemini request" }] }];
  const tools = [{ name: "lookup", description: "find a record" }];
  const body = {
    request: { contents },
    tools,
    system: "system prompt",
    instructions: 42,
  };

  const d = GATE_CHARS_PER_TOKEN;
  assert.equal(
    estimateFinalInputTokens(body),
    estimateTokens(contents, d) +
      estimateTokens(tools, d) +
      estimateTokens(body.system, d) +
      estimateTokens(body.instructions, d)
  );
});

test("estimateFinalInputTokens ignores a malformed nested request and uses input", () => {
  const input = [{ role: "user", content: "fallback input" }];
  const body = {
    request: "not an object",
    input,
  };

  assert.equal(estimateFinalInputTokens(body), estimateTokens(input, GATE_CHARS_PER_TOKEN));
});

test("estimateFinalInputTokenBreakdown identifies auxiliary input after compression", () => {
  const body = {
    messages: [{ role: "user", content: "compressed message" }],
    tools: [{ name: "lookup", description: "tool schema" }],
    system: "system prompt",
    instructions: "instructions",
  };
  const breakdown = estimateFinalInputTokenBreakdown(body);

  const d = GATE_CHARS_PER_TOKEN;
  assert.deepEqual(breakdown, {
    messages: estimateTokens(body.messages, d),
    tools: estimateTokens(body.tools, d),
    system: estimateTokens(body.system, d),
    instructions: estimateTokens(body.instructions, d),
    total:
      estimateTokens(body.messages, d) +
      estimateTokens(body.tools, d) +
      estimateTokens(body.system, d) +
      estimateTokens(body.instructions, d),
  });
  assert.equal(estimateFinalInputTokens(body), breakdown.total);
});

test("estimateTokens accepts the unknown JSON values it already serializes", () => {
  assert.equal(estimateTokens(true), 1);
  assert.equal(estimateTokens(42), 1);
  assert.equal(estimateTokens(undefined), 0);
});

// ─── precomputed-breakdown snapshot reuse (chatCore single-scan) ────────────

function fullBody() {
  return {
    messages: [{ role: "user", content: "compress me please" }],
    tools: [{ name: "lookup", description: "tool schema" }],
    system: "system prompt",
    instructions: "instructions",
  };
}

test("precomputed breakdown: 4-arg form equals the 3-arg form on cold calibration", () => {
  resetEstimatorCalibrationForTests();
  const body = fullBody();
  const breakdown = estimateFinalInputTokenBreakdown(body);
  assert.equal(
    estimateCalibratedFinalInputTokens(body, "prov", "model", breakdown),
    estimateCalibratedFinalInputTokens(body, "prov", "model"),
    "snapshot reuse must not shift the calibrated estimate"
  );
  // The raw tools component the handler reads as its reserve is the same number
  // the old inline estimateTokens(body.tools) produced.
  assert.equal(breakdown.tools, estimateTokens(body.tools, GATE_CHARS_PER_TOKEN));
});

test("precomputed breakdown: equal once a calibration factor is learned", () => {
  resetEstimatorCalibrationForTests();
  try {
    const body = fullBody();
    const raw = estimateFinalInputTokens(body);
    // The calibration service only accepts observations with estimates ≥1000
    // tokens; the toy body is smaller, so seed the bucket with an explicit pair.
    for (let i = 0; i < 3; i++) {
      recordEstimatorCalibrationFromUsage({
        provider: "prov",
        model: "model",
        estimatedTokens: 200_000,
        usage: { prompt_tokens: 100_000 },
        toolsPresent: true,
      });
    }
    const breakdown = estimateFinalInputTokenBreakdown(body);
    const viaSnapshot = estimateCalibratedFinalInputTokens(body, "prov", "model", breakdown);
    const viaLegacy = estimateCalibratedFinalInputTokens(body, "prov", "model");
    assert.equal(viaSnapshot, viaLegacy);
    assert.ok(viaSnapshot < raw, `learned 0.5 factor must scale the estimate down (raw=${raw})`);
  } finally {
    resetEstimatorCalibrationForTests();
  }
});

test("precomputed breakdown: calibration disabled keeps the raw total", () => {
  const original = process.env.OMNIROUTE_ESTIMATOR_CALIBRATION;
  process.env.OMNIROUTE_ESTIMATOR_CALIBRATION = "off";
  try {
    const body = fullBody();
    const breakdown = estimateFinalInputTokenBreakdown(body);
    assert.equal(
      estimateCalibratedFinalInputTokens(body, "prov", "model", breakdown),
      estimateFinalInputTokens(body)
    );
  } finally {
    if (original === undefined) delete process.env.OMNIROUTE_ESTIMATOR_CALIBRATION;
    else process.env.OMNIROUTE_ESTIMATOR_CALIBRATION = original;
  }
});

test("precomputed breakdown: falsy bodies match the legacy form", () => {
  for (const body of [null, undefined]) {
    const breakdown = estimateFinalInputTokenBreakdown(
      body as Record<string, unknown> | null | undefined
    );
    // Empty/absent messages still carry the [] serialization cost (ceil(2/4)=1);
    // what matters is that both forms agree on the same number.
    assert.equal(
      estimateCalibratedFinalInputTokens(body, "prov", "model", breakdown),
      estimateCalibratedFinalInputTokens(body, "prov", "model")
    );
    assert.equal(breakdown.total, estimateFinalInputTokens(body));
  }
});

// ─── dense gate divisor (agent-JSON calibration) ────────────────────────────

function withGateEnv<T>(value: string | undefined, fn: () => T): T {
  const original = process.env.OMNIROUTE_GATE_CHARS_PER_TOKEN;
  if (value === undefined) delete process.env.OMNIROUTE_GATE_CHARS_PER_TOKEN;
  else process.env.OMNIROUTE_GATE_CHARS_PER_TOKEN = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.OMNIROUTE_GATE_CHARS_PER_TOKEN;
    else process.env.OMNIROUTE_GATE_CHARS_PER_TOKEN = original;
  }
}

/** Plain string body whose total serialized length is exactly `jsonLen` chars. */
function bodyOfSerializedLength(jsonLen: number) {
  // messages: [{"role":"user","content":"..."}] — measure the wrapper, pad the content.
  const wrapper = JSON.stringify([{ role: "user", content: "" }]).length;
  return { messages: [{ role: "user", content: "x".repeat(jsonLen - wrapper) }] };
}

test("estimateTokens default divisor is unchanged (char/4)", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("abcd", 4), 1);
  assert.equal(estimateTokens("abcdef", 3), 2);
});

test("estimateTokens divisor does not scale the per-image budget", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "A".repeat(50_000) },
  };
  // With an enormous divisor the text term collapses to ~1 token, so what remains is the
  // fixed per-image budget; if the divisor scaled it too, the result would collapse with it.
  const budgetOnly = estimateTokens([image], 1_000_000);
  assert.ok(budgetOnly > 100, `image budget must stay unscaled (got ${budgetOnly})`);
  assert.ok(budgetOnly <= estimateTokens([image], 4));
});

test("gate calibration: densest measured body (jsonLen 386,749) lands in [118,318, 120,000]", () => {
  withGateEnv(undefined, () => {
    const body = bodyOfSerializedLength(386_749);
    assert.equal(JSON.stringify(body.messages).length, 386_749);
    const estimate = estimateFinalInputTokens(body);
    assert.ok(estimate >= 118_318, `undercount: ${estimate}`);
    assert.ok(estimate <= 120_000, `would trip a 120k cap on a cold factor: ${estimate}`);
    assert.ok(estimate >= Math.floor(386_749 / 3.3));
  });
});

test("gate calibration: body B (jsonLen 454,405) is not undercounted", () => {
  withGateEnv(undefined, () => {
    const estimate = estimateFinalInputTokens(bodyOfSerializedLength(454_405));
    assert.ok(estimate >= 137_756, `undercount: ${estimate}`);
  });
});

test("GATE_CHARS_PER_TOKEN is 3.25, inside the [3.223, 3.268] window", () => {
  assert.equal(GATE_CHARS_PER_TOKEN, 3.25);
});

test("OMNIROUTE_GATE_CHARS_PER_TOKEN: valid override changes the estimate", () => {
  const body = bodyOfSerializedLength(40_000);
  const base = withGateEnv(undefined, () => estimateFinalInputTokens(body));
  const at4 = withGateEnv("4", () => estimateFinalInputTokens(body));
  assert.equal(at4, estimateTokens(body.messages, 4) + 0);
  assert.ok(at4 < base);
  assert.equal(
    withGateEnv("1", () => estimateFinalInputTokens(body)),
    estimateTokens(body.messages, 1)
  );
  assert.equal(
    withGateEnv("8", () => estimateFinalInputTokens(body)),
    estimateTokens(body.messages, 8)
  );
});

test("OMNIROUTE_GATE_CHARS_PER_TOKEN: invalid values fall back to the default", () => {
  const body = bodyOfSerializedLength(40_000);
  const base = withGateEnv(undefined, () => estimateFinalInputTokens(body));
  // "3.25abc" exercises the reviewer case but is vacuous on its own (parseFloat
  // yields exactly the fallback default); "4abc" is the strictness discriminator —
  // parseFloat would silently accept 4, Number rejects it and the estimate must fall back.
  for (const bad of ["abc", "", "   ", "NaN", "Infinity", "-3", "0", "0.99", "8.01", "1e9", "3.25abc", "4abc"]) {
    assert.equal(
      withGateEnv(bad, () => estimateFinalInputTokens(body)),
      base,
      `invalid override ${JSON.stringify(bad)} must fall back`
    );
  }
});

test("last-resort compaction target converts dense gate budget to char/4 units", () => {
  withGateEnv(undefined, () => {
    const ceiling = 100_000;
    const body = {
      messages: [{ role: "user", content: "x".repeat(200_000) }],
      tools: [{ name: "lookup", description: "d".repeat(40_000) }],
    };
    const breakdown = estimateFinalInputTokenBreakdown(body);
    const denseBudget = ceiling - breakdown.tools - 1;
    const target = gateBudgetToCompressionTokens(denseBudget);
    assert.equal(target, Math.floor((denseBudget * GATE_CHARS_PER_TOKEN) / 4));
    assert.ok(target < denseBudget, "char/4 units are smaller than dense tokens");

    // A message set compressed to exactly `target` char/4 tokens, plus tools, must pass the gate.
    const compactedChars = target * 4;
    const compacted = {
      messages: [{ role: "user", content: "x".repeat(compactedChars - 40) }],
      tools: body.tools,
    };
    assert.ok(estimateTokens(compacted.messages) <= target);
    assert.ok(
      estimateFinalInputTokens(compacted) <= ceiling,
      `compaction to target must satisfy the gate (got ${estimateFinalInputTokens(compacted)})`
    );
    // Not under-compacted: the old unconverted target would leave ~23% headroom unused;
    // the converted target must use (nearly) the whole dense budget.
    assert.ok(estimateFinalInputTokens(compacted) >= ceiling * 0.97);
  });
});
