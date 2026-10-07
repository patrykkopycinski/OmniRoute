/**
 * tests/unit/model-router-rule.test.ts (vitest)
 *
 * Short-imperative downgrade rule (MODEL_ROUTER_DOWNGRADE_DECIDER=rule|both):
 * table test over the offline-evaluated real examples plus the stripping
 * cases, then decider wiring (rule / both) and shadow rule= logging.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DOWNGRADE_FROM,
  DEFAULT_DOWNGRADE_TO,
  maybeApplyModelRouterTier,
  renderModelRouterDecisionLine,
  resolveModelRouterConfig,
  shortImperativeRule,
  type ModelRouterConfig,
} from "@/sse/services/modelRouterTier";

function bodyOf(last: string, extraMessages: Array<{ role: string; content: unknown }> = []) {
  return {
    model: DEFAULT_DOWNGRADE_FROM,
    messages: [
      { role: "user", content: "This is a long opening question well over forty characters." },
      ...extraMessages,
      { role: "user", content: last },
    ],
  };
}

function classifyFetch(tier: string, confidence: number, fallback = false): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ tier, confidence, probabilities: [], fallback }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const NEVER_CALLED_FETCH = (async () => {
  throw new Error("classifier must not be called in rule mode");
}) as unknown as typeof fetch;

function cfg(overrides: Partial<ModelRouterConfig> = {}): ModelRouterConfig {
  return {
    ...resolveModelRouterConfig({
      MODEL_ROUTER_POLICY: "downgrade",
      MODEL_ROUTER_DOWNGRADE_MIN_CONF: "0.9",
    }),
    ...overrides,
  };
}

describe("shortImperativeRule table (real evaluated examples + stripping)", () => {
  const cases: Array<{ name: string; last: string; down: boolean; len?: number }> = [
    // judges said reasoning → keep
    {
      name: "why…with question mark",
      last: 'why I do have reasoning high here, but in logs it showed "medium"?',
      down: false,
    },
    { name: "is this PR still relevant", last: "is this PR still relevant", down: false },
    { name: "what is the status?", last: "what is the status?", down: false },
    { name: "review it", last: "review it", down: false },
    // judges said coding → down
    { name: "go all", last: "go all", down: true },
    { name: "go", last: "go", down: true },
    { name: "#2", last: "#2", down: true },
    { name: "accept v1", last: "accept v1", down: true },
    { name: "fix it", last: "fix it", down: true },
    { name: "push", last: "push", down: true },
    { name: "go b+a, restore corpus", last: "go b+a, restore corpus", down: true },
    // cue regex word boundaries
    { name: "plan cue word boundary", last: "plan around the word boundary", down: false },
    {
      name: "word containing plan (planning) does NOT trip \\b",
      last: "keep planning work going",
      down: true,
    },
    { name: "Analysis cue analyse", last: "analyse", down: false },
    { name: "analyze US spelling", last: "analyze", down: false },
    { name: "how do we", last: "how do we", down: false },
    { name: "is it", last: "is it ok", down: false },
    { name: "design", last: "design", down: false },
    { name: "compare", last: "compare", down: false },
    // length boundary: 39 chars down, 40+ keep
    { name: "39 chars → down", last: "a".repeat(39), down: true },
    { name: "40 chars → keep", last: "a".repeat(40), down: false },
    // stripping: attached context
    {
      name: "attached context tail stripped → short imperative remains",
      last: "go all\n--- Attached Context ---\n" + "x".repeat(500),
      down: true,
    },
    {
      name: "attached context contains invoked skill marker → keep",
      last: 'go\n--- Attached Context ---\n[IMPORTANT: The user has invoked the "plan" skill]',
      down: false,
    },
    {
      name: "attached context leaves a long/cued body → keep",
      last: "why is this wrong?\n--- Attached Context ---\n" + "x".repeat(100),
      down: false,
    },
    // stripping: memory-context block
    {
      name: "memory-context block stripped",
      last: "ship it <memory-context>\nrelevance stuff\n</memory-context>",
      down: true,
    },
    // stripping: [IMPORTANT: …] leading wrapper
    {
      name: "leading [IMPORTANT: …] wrapper stripped",
      last: "[IMPORTANT: read this first] go",
      down: true,
    },
    // stripping: out-of-band wrapper keeps inner text
    {
      name: "out-of-band wrapper keeps inner text (short → down)",
      last: "[OUT-OF-BAND USER MESSAGE — direct]\nfix it\n[/OUT-OF-BAND USER MESSAGE]",
      down: true,
    },
    {
      name: "out-of-band wrapper keeps inner text (cued → keep)",
      last: "[OUT-OF-BAND USER MESSAGE — direct]\nwhat is this?\n[/OUT-OF-BAND USER MESSAGE]",
      down: false,
    },
    // empty after stripping → keep
    {
      name: "only attached context → empty body → keep",
      last: "--- Attached Context ---\nstuff",
      down: false,
    },
    {
      name: "only memory-context → empty body → keep",
      last: "<memory-context>x</memory-context>",
      down: false,
    },
    // invoked skill → keep
    {
      name: "invoked skill marker → keep",
      last: '[IMPORTANT: The user has invoked the "plan" skill] go',
      down: false,
    },
    {
      name: "non-invocation IMPORTANT prefix → strip",
      last: '[IMPORTANT: The user has invoked the "plan" tool] go',
      down: true,
    },
    {
      name: "out-of-band marker inside ordinary text is not a leading wrapper",
      last: "hello [OUT-OF-BAND USER MESSAGE]review it[/OUT-OF-BAND USER MESSAGE]",
      down: false,
    },
    {
      name: "out-of-band trailing reasoning text remains",
      last: "[OUT-OF-BAND USER MESSAGE]go[/OUT-OF-BAND USER MESSAGE] review it",
      down: false,
    },
    // nudges are skipped: last REAL user message is used
    {
      name: "[System: nudge skipped, earlier real message decides",
      last: "[System: continue]",
      down: true,
    },
    // emoji counted as one code point
    { name: "emoji counted as single code points", last: "go 🚀🚀🚀🚀🚀🚀🚀🚀🚀", down: true },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.down ? "down" : "keep"}`, () => {
      const msgs =
        c.last === "[System: continue]"
          ? [
              {
                role: "user",
                content: "This is a long opening question well over forty characters.",
              },
              { role: "user", content: "ship it now please" },
              { role: "user", content: "[System: continue]" },
            ]
          : bodyOf(c.last).messages;
      const r = shortImperativeRule({ model: "m", messages: msgs });
      expect(r.down).toBe(c.down);
    });
  }
});

describe("decider wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decider=rule downgrades WITHOUT calling the classifier (no latency)", async () => {
    const res = await maybeApplyModelRouterTier({
      body: bodyOf("fix it") as never,
      modelStr: DEFAULT_DOWNGRADE_FROM,
      config: cfg({ decider: "rule" }),
      fetchImpl: NEVER_CALLED_FETCH,
    });
    expect(res.applied).toBe(true);
    expect(res.model).toBe(DEFAULT_DOWNGRADE_TO);
  });

  it("decider=rule keeps on a cued message even though the classifier would say coding", async () => {
    const res = await maybeApplyModelRouterTier({
      body: bodyOf("review it") as never,
      modelStr: DEFAULT_DOWNGRADE_FROM,
      config: cfg({ decider: "rule" }),
      fetchImpl: NEVER_CALLED_FETCH,
    });
    expect(res.applied).toBe(false);
    expect(res.model).toBe(DEFAULT_DOWNGRADE_FROM);
  });

  it("decider=both requires agreement: rule yes + classifier coding 0.95 → down", async () => {
    const res = await maybeApplyModelRouterTier({
      body: bodyOf("fix it") as never,
      modelStr: DEFAULT_DOWNGRADE_FROM,
      config: cfg({ decider: "both" }),
      fetchImpl: classifyFetch("coding", 0.95),
    });
    expect(res.applied).toBe(true);
    expect(res.model).toBe(DEFAULT_DOWNGRADE_TO);
  });

  it("decider=both: rule yes + classifier reasoning → keep (no upgrade path)", async () => {
    const res = await maybeApplyModelRouterTier({
      body: bodyOf("fix it") as never,
      modelStr: DEFAULT_DOWNGRADE_FROM,
      config: cfg({ decider: "both" }),
      fetchImpl: classifyFetch("reasoning", 0.99),
    });
    expect(res.applied).toBe(false);
  });

  it("decider=both: rule keep + classifier coding 0.95 → keep", async () => {
    const res = await maybeApplyModelRouterTier({
      body: bodyOf("review it") as never,
      modelStr: DEFAULT_DOWNGRADE_FROM,
      config: cfg({ decider: "both" }),
      fetchImpl: classifyFetch("coding", 0.95),
    });
    expect(res.applied).toBe(false);
  });

  it("default decider=classifier ignores the rule (backwards compatible)", async () => {
    const res = await maybeApplyModelRouterTier({
      body: bodyOf("review it") as never,
      modelStr: DEFAULT_DOWNGRADE_FROM,
      config: cfg({ decider: "classifier" }),
      fetchImpl: classifyFetch("coding", 0.95),
    });
    expect(res.applied).toBe(true);
    expect(res.model).toBe(DEFAULT_DOWNGRADE_TO);
  });

  it("rule mode preserves never-upgrade, other-model pass-through and opt-out", async () => {
    const options = cfg({ decider: "rule" });
    const other = await maybeApplyModelRouterTier({
      body: { ...bodyOf("fix it"), model: DEFAULT_DOWNGRADE_TO } as never,
      modelStr: DEFAULT_DOWNGRADE_TO,
      config: options,
      fetchImpl: NEVER_CALLED_FETCH,
    });
    expect(other).toMatchObject({ applied: false, model: DEFAULT_DOWNGRADE_TO });
    const optOut = await maybeApplyModelRouterTier({
      body: bodyOf("fix it") as never,
      modelStr: DEFAULT_DOWNGRADE_FROM,
      config: options,
      noRoute: true,
      fetchImpl: NEVER_CALLED_FETCH,
    });
    expect(optOut).toMatchObject({ applied: false, model: DEFAULT_DOWNGRADE_FROM });
  });

  it("invalid decider falls back to classifier; max-char env override applies", () => {
    const invalid = resolveModelRouterConfig({
      MODEL_ROUTER_POLICY: "downgrade",
      MODEL_ROUTER_DOWNGRADE_DECIDER: "typo",
      MODEL_ROUTER_RULE_MAX_CHARS: "7",
    });
    expect(invalid.decider).toBe("classifier");
    expect(invalid.ruleMaxChars).toBe(7);
    expect(shortImperativeRule(bodyOf("accept v1"), invalid.ruleMaxChars).down).toBe(false);
    expect(shortImperativeRule(bodyOf("fix it"), invalid.ruleMaxChars).down).toBe(true);
  });

  it("shadow with rule decider logs both classifier and rule verdicts without rewriting", async () => {
    const infoSpy = vi.fn();
    const fetchSpy = vi.fn(classifyFetch("reasoning", 0.99));
    vi.spyOn(await import("@/sse/utils/logger"), "info").mockImplementation(infoSpy);
    const res = await maybeApplyModelRouterTier({
      body: bodyOf("fix it") as never,
      modelStr: DEFAULT_DOWNGRADE_FROM,
      config: cfg({ decider: "rule", shadow: true }),
      fetchImpl: fetchSpy as typeof fetch,
    });
    expect(res.applied).toBe(false);
    expect(res.model).toBe(DEFAULT_DOWNGRADE_FROM);
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledOnce();
      const decision = infoSpy.mock.calls.find((c) => c[0] === "MODEL_ROUTER_DECISION");
      expect(decision?.[1]).toMatch(/would=best-coding-paid tier=reasoning conf=0\.990/);
      expect(decision?.[1]).toMatch(/rule=down rule_len=6$/);
    });
  });

  it("shadow logs rule= and rule_len= fields", async () => {
    const infoSpy = vi.fn();
    vi.spyOn(await import("@/sse/utils/logger"), "info").mockImplementation(infoSpy);
    await maybeApplyModelRouterTier({
      body: bodyOf("fix it") as never,
      modelStr: DEFAULT_DOWNGRADE_FROM,
      config: cfg({ shadow: true }),
      fetchImpl: classifyFetch("coding", 0.95),
    });
    await vi.waitFor(() => {
      const call = infoSpy.mock.calls.find((c) => c[0] === "MODEL_ROUTER_DECISION");
      expect(call?.[1]).toMatch(/ rule=down rule_len=6$/);
    });
  });

  it("decision line renders rule fields", () => {
    expect(
      renderModelRouterDecisionLine({
        policy: "shadow",
        requested: "best-reasoning-paid",
        would: "best-reasoning-paid",
        tier: "coding",
        confidence: 0.95,
        fb: false,
        sticky: false,
        sess: "abc",
        ms: 12.3,
        applied: false,
        rule: "keep",
        ruleLen: 9,
      })
    ).toContain(" rule=keep rule_len=9");
  });
});
