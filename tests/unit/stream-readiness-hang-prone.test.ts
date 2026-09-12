import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveStreamReadinessTimeout } from "../../open-sse/utils/streamReadinessPolicy.ts";

// kimi-k3-high on cursor is bimodal: the first SSE event lands inside ~10-40s,
// or the upstream goes dead-silent and never emits anything (a queue/stall on
// Cursor's side, not a reasoning warm-up). The generic reasoning bumps would
// hand it a 115s-185s readiness window, so every stall burns the full window
// before the combo cascades. `resolveStreamReadinessTimeout` must clamp the
// computed first-event window to 90s for exactly that provider/model pair —
// keyed on identity, NOT on the `-high` suffix (cursor's grok-4.6-high is a
// genuine slow-reasoning target that needs the long window) and NOT on
// provider family (the same id on moonshot/openrouter must be untouched).

const KIMI_HANG_CAP_MS = 90_000;
const HANG_REASON = "hang_prone_stall_fast_fail";

const BASE_MS = 80_000;

function items(count: number, contentPad = 1): Array<{ role: string; content: string }> {
  return Array.from({ length: count }, (_, index) => ({
    role: "user",
    content: String(index).padEnd(contentPad, "x"),
  }));
}

function tools(count: number): Array<{ type: string; name: string }> {
  return Array.from({ length: count }, (_, index) => ({ type: "function", name: `tool_${index}` }));
}

// 181 items => +20s large_history; 20 tools => +15s tool_heavy.
const LARGE_HISTORY = 181;
const VERY_LARGE_HISTORY = 401;
const TOOL_HEAVY = 20;

function run(input: {
  provider?: string | null;
  model?: string | null;
  body?: Record<string, unknown> | null;
  baseTimeoutMs?: number;
  maxTimeoutMs?: number;
}) {
  return resolveStreamReadinessTimeout({
    baseTimeoutMs: input.baseTimeoutMs ?? BASE_MS,
    provider: input.provider ?? "cursor",
    model: input.model ?? "kimi-k3-high",
    body: input.body ?? { input: items(LARGE_HISTORY) },
    ...(input.maxTimeoutMs === undefined ? {} : { maxTimeoutMs: input.maxTimeoutMs }),
  });
}

test("hang fast-fail clamps cursor/kimi-k3-high even though large_history pushed the window past 90s", () => {
  const result = run({ model: "kimi-k3-high", body: { input: items(LARGE_HISTORY) } });

  // Uncapped this path computes 80s + 20s = 100s; the hang rule must pull it down.
  assert.equal(result.timeoutMs, KIMI_HANG_CAP_MS);
  assert.ok(result.reasons.includes("large_history"));
  assert.ok(result.reasons.includes(HANG_REASON));
});

test("hang fast-fail recognises the provider-prefixed spelling cursor/kimi-k3-high", () => {
  const result = run({ model: "cursor/kimi-k3-high", body: { messages: items(LARGE_HISTORY) } });

  assert.equal(result.timeoutMs, KIMI_HANG_CAP_MS);
  assert.ok(result.reasons.includes(HANG_REASON));
});

test("hang fast-fail matching is case-insensitive on provider and model", () => {
  const result = run({ provider: "CURSOR", model: "Cursor/Kimi-K3-High" });

  assert.equal(result.timeoutMs, KIMI_HANG_CAP_MS);
  assert.ok(result.reasons.includes(HANG_REASON));
});

test("hang fast-fail does not fire for the same model id on non-cursor providers", () => {
  for (const provider of ["moonshot", "openrouter"]) {
    const result = run({
      provider,
      model: provider === "openrouter" ? "cursor/kimi-k3-high" : "kimi-k3-high",
    });

    // 80s + 20s large_history stands; only cursor has the stall behaviour.
    assert.equal(result.timeoutMs, 100_000, `provider=${provider}`);
    assert.ok(!result.reasons.includes(HANG_REASON), `provider=${provider}`);
  }
});

test("hang fast-fail does not fire for the cursor-api sibling provider", () => {
  const result = run({ provider: "cursor-api", model: "kimi-k3-high" });

  assert.equal(result.timeoutMs, 100_000);
  assert.ok(!result.reasons.includes(HANG_REASON));
});

test("hang fast-fail does not fire for near-miss kimi ids on cursor", () => {
  const nearMisses = [
    "kimi-k3-max",
    "kimi-k3-low",
    "kimi-k2.7-code",
    "kimi-k3-high-1m",
    "kimi-k3-high ",
  ];

  for (const model of nearMisses) {
    const result = run({ model });

    assert.equal(result.timeoutMs, 100_000, `model=${model}`);
    assert.ok(!result.reasons.includes(HANG_REASON), `model=${model}`);
  }
});

test("hang fast-fail clamps a window that reasoning bumps pushed to 115s", () => {
  const body = { input: items(LARGE_HISTORY), tools: tools(TOOL_HEAVY) };

  // Control: the identical request on cursor's grok-4.6-high keeps 80 + 20 + 15.
  const control = run({ model: "cursor-grok-4.6-high", body });
  assert.equal(control.timeoutMs, 115_000);
  assert.ok(!control.reasons.includes(HANG_REASON));

  const capped = run({ model: "kimi-k3-high", body });
  assert.equal(capped.timeoutMs, KIMI_HANG_CAP_MS);
  assert.ok(capped.reasons.includes(HANG_REASON));
});

test("hang fast-fail clamps a fully-bumped 185s window under a 300s ceiling", () => {
  const result = run({
    maxTimeoutMs: 300_000,
    body: { input: items(VERY_LARGE_HISTORY, 3000), tools: tools(TOOL_HEAVY) },
  });

  // +45 very_large_history, +15 tool_heavy, +45 very_large_payload -> 185s uncapped.
  assert.equal(result.timeoutMs, KIMI_HANG_CAP_MS);
  assert.equal(result.maxTimeoutMs, 300_000);
  assert.deepEqual(result.reasons, [
    "very_large_history",
    "tool_heavy",
    "very_large_payload",
    HANG_REASON,
  ]);
});

test("hang fast-fail clamps a window that only the tool_heavy bump pushed above 90s", () => {
  const result = run({ body: { input: items(3), tools: tools(TOOL_HEAVY) } });

  // Tiny history: 80s + 15s tool_heavy = 95s, so the clamp is not keyed to history size.
  assert.equal(result.timeoutMs, KIMI_HANG_CAP_MS);
  assert.deepEqual(result.reasons, ["tool_heavy", HANG_REASON]);
});

test("hang fast-fail never raises a window that is already below the 90s cap", () => {
  const minimal = run({ baseTimeoutMs: 60_000, body: { input: items(3) } });
  assert.equal(minimal.timeoutMs, 60_000);
  assert.ok(minimal.reasons.includes(HANG_REASON));

  const bumped = run({ baseTimeoutMs: 60_000, body: { input: items(LARGE_HISTORY) } });
  assert.equal(bumped.timeoutMs, 80_000);
  assert.ok(bumped.reasons.includes(HANG_REASON));
});

test("hang fast-fail is a no-op when the readiness policy is disabled", () => {
  const result = run({ baseTimeoutMs: 0 });

  assert.equal(result.timeoutMs, 0);
  assert.deepEqual(result.reasons, ["disabled"]);
});

test("hang fast-fail still lets maxTimeoutMs be the final clamp", () => {
  const capped = run({ baseTimeoutMs: 40_000, maxTimeoutMs: 50_000 });
  // 40s + 20s large_history = 60s, hang cap leaves it, then the 50s ceiling wins.
  assert.equal(capped.timeoutMs, 50_000);
  assert.deepEqual(capped.reasons, ["large_history", HANG_REASON]);

  // A fully-bumped window under a raised ceiling lands on the hang cap, not the ceiling.
  const large = run({
    maxTimeoutMs: 300_000,
    baseTimeoutMs: 40_000,
    body: { input: items(VERY_LARGE_HISTORY, 3000), tools: tools(TOOL_HEAVY) },
  });
  assert.equal(large.timeoutMs, KIMI_HANG_CAP_MS);
  assert.deepEqual(large.reasons, [
    "very_large_history",
    "tool_heavy",
    "very_large_payload",
    HANG_REASON,
  ]);
});

test("genuine slow-reasoning cursor grok-4.6-high keeps its long readiness window", () => {
  const spellings = [
    "grok-4.6-high",
    "cursor-grok-4.6-high",
    "cursor/cursor-grok-4.6-high",
    "cursor-grok-4.6-xhigh",
  ];

  for (const model of spellings) {
    const withHistoryAndTools = run({
      model,
      body: { input: items(LARGE_HISTORY), tools: tools(TOOL_HEAVY) },
    });
    assert.equal(withHistoryAndTools.timeoutMs, 115_000, `model=${model}`);
    assert.ok(!withHistoryAndTools.reasons.includes(HANG_REASON), `model=${model}`);

    // The reasoning budget path is what earns the long window; the hang rule must not
    // short-circuit it even when the effort is requested explicitly in the body.
    const huge = run({
      model,
      maxTimeoutMs: 300_000,
      body: {
        input: items(VERY_LARGE_HISTORY, 3000),
        tools: tools(TOOL_HEAVY),
        reasoning_effort: "high",
      },
    });
    assert.equal(huge.timeoutMs, 185_000, `model=${model}`);
    assert.ok(!huge.reasons.includes(HANG_REASON), `model=${model}`);
  }
});

test("cursor extended-thinking targets keep their warm-up window above the hang cap", () => {
  const thinkingHigh = run({
    model: "claude-opus-5-thinking-high",
    body: { input: items(LARGE_HISTORY), tools: tools(TOOL_HEAVY) },
  });
  assert.equal(thinkingHigh.timeoutMs, 145_000);
  assert.ok(thinkingHigh.reasons.includes("extended_thinking"));
  assert.ok(!thinkingHigh.reasons.includes(HANG_REASON));

  const thinkingMaxHuge = run({
    model: "cursor/claude-fable-5-1-thinking-max",
    body: { input: items(VERY_LARGE_HISTORY, 3000), tools: tools(TOOL_HEAVY) },
  });
  assert.equal(thinkingMaxHuge.timeoutMs, 180_000);
  assert.ok(!thinkingMaxHuge.reasons.includes(HANG_REASON));
});
