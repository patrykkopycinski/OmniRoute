/**
 * tests/unit/model-router-tier.test.ts
 *
 * In-process input-aware tier router (Laya/JEV classifier → named combo).
 *
 * Covers the four acceptance surfaces of the migration from the standalone
 * laya-router sidecar:
 *   1. tier→combo closed set (never `auto/*`) + per-tier confidence floors
 *   2. the `/classify` HTTP contract (parsing + failure modes)
 *   3. `buildRouterState` byte parity with the sidecar's `state_from_body`
 *   4. flag-gated passthrough — off = the router is never consulted
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_ROUTER_INPROCESS_FLAG,
  MODEL_ROUTER_TIERS,
  DEFAULT_TIER_COMBOS,
  DEFAULT_MIN_CONFIDENCE,
  buildRouterState,
  textFromContent,
  parseClassifyResponse,
  classifyViaHttp,
  selectTierCombo,
  resolveModelRouterConfig,
  maybeApplyModelRouterTier,
  isModelRouterInprocessEnabled,
} from "../../src/sse/services/modelRouterTier.ts";
import { FEATURE_FLAG_DEFINITIONS } from "../../src/shared/constants/featureFlagDefinitions.ts";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// 1. flag default + closed set
// ---------------------------------------------------------------------------

test("MODEL_ROUTER_INPROCESS is defined and defaults to OFF", () => {
  const def = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === MODEL_ROUTER_INPROCESS_FLAG);
  assert.ok(def, "flag definition must exist");
  assert.equal(def?.defaultValue, "false");
  assert.equal(def?.type, "boolean");
  assert.equal(def?.category, "runtime");
});

test("resolved flag is OFF by default and honours the env override", async () => {
  const { clearAllFeatureFlagOverrides } = await import("../../src/lib/db/featureFlags.ts");
  const core = await import("../../src/lib/db/core.ts");
  const previous = process.env.MODEL_ROUTER_INPROCESS;
  try {
    clearAllFeatureFlagOverrides();
    delete process.env.MODEL_ROUTER_INPROCESS;
    assert.equal(isModelRouterInprocessEnabled(), false, "default OFF");

    process.env.MODEL_ROUTER_INPROCESS = "true";
    assert.equal(isModelRouterInprocessEnabled(), true);

    process.env.MODEL_ROUTER_INPROCESS = "false";
    assert.equal(isModelRouterInprocessEnabled(), false);
  } finally {
    if (previous === undefined) delete process.env.MODEL_ROUTER_INPROCESS;
    else process.env.MODEL_ROUTER_INPROCESS = previous;
    core.resetDbInstance();
  }
});

test("tier→combo map is the sidecar's closed set over named combos", () => {
  assert.deepEqual(DEFAULT_TIER_COMBOS, {
    reasoning: "best-reasoning-paid",
    coding: "best-coding-paid",
    fast: "fast",
  });
  for (const tier of MODEL_ROUTER_TIERS) {
    assert.ok(
      !DEFAULT_TIER_COMBOS[tier].startsWith("auto/"),
      `${tier} must never resolve to an auto/* combo`
    );
  }
});

test("per-tier confidence floors match the sidecar (fast 0.45)", () => {
  assert.deepEqual(DEFAULT_MIN_CONFIDENCE, { reasoning: 0.6, coding: 0.6, fast: 0.45 });
});

test("a configured auto/* combo is refused at config resolution", () => {
  const cfg = resolveModelRouterConfig({
    MODEL_ROUTER_COMBO_CODING: "auto/best-coding",
    MODEL_ROUTER_DEFAULT_COMBO: "auto/best-coding",
  });
  assert.equal(cfg.tierCombos.coding, "best-coding-paid");
  assert.equal(cfg.defaultCombo, "best-coding-paid");
});

// ---------------------------------------------------------------------------
// 2. state assembly (sidecar parity)
// ---------------------------------------------------------------------------

test("textFromContent handles strings and OpenAI/Anthropic parts", () => {
  assert.equal(textFromContent("hi"), "hi");
  assert.equal(
    textFromContent([
      { type: "text", text: "a" },
      { type: "image_url", image_url: { url: "x" } },
      { type: "text", text: "b" },
    ]),
    "a\nb"
  );
  assert.equal(textFromContent(null), "");
  assert.equal(textFromContent({ nope: 1 }), "");
});

test("buildRouterState leads with the last user turn, then newest non-system turns, system last", () => {
  const state = buildRouterState({
    system: "SYS",
    messages: [
      { role: "user", content: "first question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "LAST QUESTION" },
    ],
  });
  assert.deepEqual(state.split("\n"), ["LAST QUESTION", "answer", "first question", "SYS"]);
});

test("buildRouterState concatenates the system prompt without a separator (sidecar byte parity)", () => {
  const state = buildRouterState({
    system: "AAA",
    messages: [
      { role: "user", content: "Q" },
      { role: "system", content: "BBB" },
    ],
  });
  // sidecar: sys_txt = _text(body["system"]) + "\n".join([system turns]) => "AAABBB"
  assert.equal(state, "Q\nAAABBB");
});

test("buildRouterState head-truncates to STATE_CHARS", () => {
  const long = "x".repeat(50);
  const state = buildRouterState({ messages: [{ role: "user", content: long }] }, 10);
  assert.equal(state, long.slice(0, 10));
});

test("buildRouterState skips blank turns and tolerates an empty body", () => {
  assert.equal(buildRouterState({}), "");
  assert.equal(
    buildRouterState({
      messages: [
        { role: "user", content: "   " },
        { role: "user", content: "ok" },
      ],
    }),
    "ok"
  );
});

// ---------------------------------------------------------------------------
// 3. /classify contract
// ---------------------------------------------------------------------------

test("parseClassifyResponse accepts a well-formed payload", () => {
  const parsed = parseClassifyResponse({
    tier: "reasoning",
    confidence: 0.72,
    probabilities: [0.72, 0.2, 0.08],
    fallback: false,
  });
  assert.deepEqual(parsed, {
    tier: "reasoning",
    confidence: 0.72,
    probabilities: [0.72, 0.2, 0.08],
    fallback: false,
  });
});

test("parseClassifyResponse rejects malformed payloads", () => {
  assert.equal(parseClassifyResponse(null), null);
  assert.equal(parseClassifyResponse("nope"), null);
  assert.equal(parseClassifyResponse({ confidence: 0.5 }), null, "missing tier");
  assert.equal(parseClassifyResponse({ tier: "auto", confidence: 0.5 }), null, "unknown tier");
  assert.equal(parseClassifyResponse({ tier: "fast" }), null, "missing confidence");
  assert.equal(parseClassifyResponse({ tier: "fast", confidence: 1.4 }), null, "out of range");
});

test("classifyViaHttp parses a valid response and returns null on every failure", async () => {
  const cfg = resolveModelRouterConfig({});
  const ok = await classifyViaHttp("hi", cfg, async () =>
    jsonResponse({ tier: "fast", confidence: 0.5 })
  );
  assert.equal(ok?.tier, "fast");

  assert.equal(await classifyViaHttp("hi", cfg, async () => jsonResponse({}, 500)), null);
  assert.equal(
    await classifyViaHttp("hi", cfg, async () => {
      throw new Error("connection refused");
    }),
    null
  );

  // Empty state short-circuits: the remote is never called.
  let called = false;
  const empty = await classifyViaHttp("   ", cfg, async () => {
    called = true;
    return jsonResponse({ tier: "fast", confidence: 0.9 });
  });
  assert.equal(empty, null);
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// 4. tier selection + fallbacks
// ---------------------------------------------------------------------------

test("selectTierCombo maps tiers and applies the per-tier floor", () => {
  const cfg = resolveModelRouterConfig({});

  assert.equal(
    selectTierCombo({ tier: "reasoning", confidence: 0.9, fallback: false }, cfg).combo,
    "best-reasoning-paid"
  );
  // 0.5 is below coding's 0.60 floor but above fast's 0.45.
  assert.equal(
    selectTierCombo({ tier: "fast", confidence: 0.5, fallback: false }, cfg).combo,
    "fast"
  );
  const lowCoding = selectTierCombo({ tier: "coding", confidence: 0.5, fallback: false }, cfg);
  assert.equal(lowCoding.fallback, true);
  assert.equal(lowCoding.reason, "low_confidence");
  assert.equal(lowCoding.combo, "best-coding-paid");
});

test("selectTierCombo falls back to the default combo on a failed classification", () => {
  const cfg = resolveModelRouterConfig({});
  const none = selectTierCombo(null, cfg);
  assert.equal(none.combo, "best-coding-paid");
  assert.equal(none.fallback, true);
  assert.equal(none.reason, "classify_failed");
  assert.equal(none.tier, "coding");
});

test("selectTierCombo refuses an auto/* tier mapping even if config sanitising is bypassed", () => {
  const base = resolveModelRouterConfig({});
  const cfg = { ...base, tierCombos: { ...base.tierCombos, reasoning: "auto/best-reasoning" } };
  const sel = selectTierCombo({ tier: "reasoning", confidence: 0.99, fallback: false }, cfg);
  assert.equal(sel.combo, "best-coding-paid");
  assert.equal(sel.fallback, true);
  assert.equal(sel.reason, "invalid_combo");
});

test("MODEL_ROUTER_MIN_CONFIDENCE overrides every tier floor", () => {
  const cfg = resolveModelRouterConfig({ MODEL_ROUTER_MIN_CONFIDENCE: "0.9" });
  assert.deepEqual(cfg.minConfidence, { reasoning: 0.9, coding: 0.9, fast: 0.9 });
});

// ---------------------------------------------------------------------------
// 5. wiring helper (flag-off passthrough)
// ---------------------------------------------------------------------------

test("non-router models are never touched", async () => {
  const result = await maybeApplyModelRouterTier({
    body: { messages: [{ role: "user", content: "hi" }] },
    modelStr: "gpt-5",
    fetchImpl: async () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(result.applied, false);
  assert.equal(result.model, "gpt-5");
});

test("the virtual router model is rewritten to the mapped combo", async () => {
  let posted: { state?: string } | null = null;
  const result = await maybeApplyModelRouterTier({
    body: { messages: [{ role: "user", content: "design a scheduler" }] },
    modelStr: "laya-router",
    config: resolveModelRouterConfig({}),
    fetchImpl: async (_url, init) => {
      posted = JSON.parse(String(init?.body));
      return jsonResponse({ tier: "reasoning", confidence: 0.8, probabilities: [0.8, 0.1, 0.1] });
    },
  });
  assert.equal(result.applied, true);
  assert.equal(result.model, "best-reasoning-paid");
  assert.equal(result.tier, "reasoning");
  assert.equal(result.fallback, false);
  assert.equal(posted?.state, "design a scheduler");
});

test("a classify failure still rewrites the virtual model (never a black hole)", async () => {
  const result = await maybeApplyModelRouterTier({
    body: { messages: [{ role: "user", content: "hi" }] },
    modelStr: "laya-router",
    config: resolveModelRouterConfig({}),
    fetchImpl: async () => {
      throw new Error("sidecar down");
    },
  });
  assert.equal(result.applied, true);
  assert.equal(result.model, "best-coding-paid");
  assert.equal(result.fallback, true);
  assert.equal(result.reason, "classify_failed");
});

test("a low-confidence classification falls back to the default combo", async () => {
  const result = await maybeApplyModelRouterTier({
    body: { messages: [{ role: "user", content: "hi" }] },
    modelStr: "laya-router",
    config: resolveModelRouterConfig({}),
    fetchImpl: async () => jsonResponse({ tier: "reasoning", confidence: 0.1 }),
  });
  assert.equal(result.model, "best-coding-paid");
  assert.equal(result.fallback, true);
  assert.equal(result.reason, "low_confidence");
  assert.equal(result.tier, "reasoning");
});

test("flag OFF: the router is not consulted, so routing is byte-identical", async () => {
  // Mirrors the chat.ts wiring: the helper is only reached behind
  // `isModelRouterInprocessEnabled()`. With the flag off an ordinary request
  // resolves to the same model whether or not this feature exists.
  const { clearAllFeatureFlagOverrides } = await import("../../src/lib/db/featureFlags.ts");
  const core = await import("../../src/lib/db/core.ts");
  const previous = process.env.MODEL_ROUTER_INPROCESS;
  try {
    clearAllFeatureFlagOverrides();
    delete process.env.MODEL_ROUTER_INPROCESS;
    assert.equal(isModelRouterInprocessEnabled(), false);

    // The wiring only calls the helper when the flag is on — emulate it: with
    // the flag off, `modelStr` for a virtual-model request is left untouched
    // (today's behaviour: the gateway has no such model) and no fetch happens.
    let fetched = false;
    const fetchImpl = async () => {
      fetched = true;
      return jsonResponse({ tier: "fast", confidence: 0.9 });
    };
    let modelStr = "laya-router";
    if (isModelRouterInprocessEnabled()) {
      const applied = await maybeApplyModelRouterTier({ body: {}, modelStr, fetchImpl });
      if (applied.applied && applied.model) modelStr = applied.model;
    }
    assert.equal(modelStr, "laya-router");
    assert.equal(fetched, false);
  } finally {
    if (previous === undefined) delete process.env.MODEL_ROUTER_INPROCESS;
    else process.env.MODEL_ROUTER_INPROCESS = previous;
    core.resetDbInstance();
  }
});
