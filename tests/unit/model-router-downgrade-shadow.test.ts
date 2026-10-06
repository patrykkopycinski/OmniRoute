/**
 * tests/unit/model-router-downgrade-shadow.test.ts (vitest)
 *
 * Downgrade-only policy truth table, shadow mode, sticky sessions, opt-out.
 * Downgrade invariant: ONLY tier=coding, conf >= DOWNGRADE_MIN_CONF (0.9),
 * fallback=false rewrites best-reasoning-paid → best-coding-paid. Everything
 * else — fast, reasoning, low confidence, classifier error/timeout, empty
 * state, other models, opt-out header — leaves the request untouched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DOWNGRADE_FROM,
  DEFAULT_DOWNGRADE_TO,
  __resetModelRouterSessionsForTests,
  classifyWithSessions,
  isHarnessNudge,
  maybeApplyModelRouterTier,
  renderModelRouterDecisionLine,
  resolveModelRouterConfig,
  sessionKeyFromUsers,
  type ModelRouterConfig,
} from "@/sse/services/modelRouterTier";

function cfg(overrides: Partial<ModelRouterConfig> = {}): ModelRouterConfig {
  const base = resolveModelRouterConfig({
    MODEL_ROUTER_POLICY: "downgrade",
    MODEL_ROUTER_DOWNGRADE_FROM: DEFAULT_DOWNGRADE_FROM,
    MODEL_ROUTER_DOWNGRADE_TO: DEFAULT_DOWNGRADE_TO,
    MODEL_ROUTER_DOWNGRADE_MIN_CONF: "0.9",
    MODEL_ROUTER_DOWNGRADE_TIMEOUT_MS: "800",
  });
  return { ...base, ...overrides };
}

function classifyFetch(tier: string, confidence: number, fallback = false): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ tier, confidence, probabilities: [], fallback }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const failFetch = (async () => {
  throw new Error("connection refused");
}) as unknown as typeof fetch;

const hangFetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), 10_000);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    });
  });
  throw new Error("unreachable");
}) as unknown as typeof fetch;

const FROM_BODY = {
  model: DEFAULT_DOWNGRADE_FROM,
  messages: [{ role: "user", content: "Implement a red-black tree in TypeScript with tests" }],
};

const OTHER_BODY = {
  model: "some-other-model",
  messages: [{ role: "user", content: "Implement a red-black tree in TypeScript with tests" }],
};

afterEach(() => {
  __resetModelRouterSessionsForTests();
});

describe("downgrade truth table", () => {
  const cases: Array<{
    name: string;
    body: typeof FROM_BODY;
    tier?: string;
    conf?: number;
    fallback?: boolean;
    fetchImpl?: typeof fetch;
    noRoute?: boolean;
    expected: string | null; // null = not applied
  }> = [
    {
      name: "coding 0.95 → downgraded",
      body: FROM_BODY,
      tier: "coding",
      conf: 0.95,
      expected: DEFAULT_DOWNGRADE_TO,
    },
    {
      name: "coding 0.9 (boundary) → downgraded",
      body: FROM_BODY,
      tier: "coding",
      conf: 0.9,
      expected: DEFAULT_DOWNGRADE_TO,
    },
    {
      name: "coding 0.89 (below floor) → unchanged",
      body: FROM_BODY,
      tier: "coding",
      conf: 0.89,
      expected: null,
    },
    {
      name: "coding 0.99 but fallback=true → unchanged",
      body: FROM_BODY,
      tier: "coding",
      conf: 0.99,
      fallback: true,
      expected: null,
    },
    {
      name: "reasoning 0.99 → unchanged (never upgrade/stay)",
      body: FROM_BODY,
      tier: "reasoning",
      conf: 0.99,
      expected: null,
    },
    {
      name: "fast 0.99 → unchanged (never fast)",
      body: FROM_BODY,
      tier: "fast",
      conf: 0.99,
      expected: null,
    },
    { name: "classifier error → unchanged", body: FROM_BODY, fetchImpl: failFetch, expected: null },
    {
      name: "classifier timeout → unchanged",
      body: FROM_BODY,
      fetchImpl: hangFetch,
      expected: null,
    },
    {
      name: "other model + coding 0.95 → untouched",
      body: OTHER_BODY,
      tier: "coding",
      conf: 0.95,
      expected: null,
    },
    {
      name: "opt-out header + coding 0.95 → untouched",
      body: FROM_BODY,
      tier: "coding",
      conf: 0.95,
      noRoute: true,
      expected: null,
    },
    {
      name: "empty state (no messages) → unchanged",
      body: { model: DEFAULT_DOWNGRADE_FROM },
      fetchImpl: failFetch,
      expected: null,
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const fetchImpl = c.fetchImpl ?? classifyFetch(c.tier!, c.conf ?? 0.95, c.fallback ?? false);
      const res = await maybeApplyModelRouterTier({
        body: c.body as never,
        modelStr: c.body.model,
        config: cfg(),
        fetchImpl,
        noRoute: c.noRoute,
      });
      if (c.expected === null) {
        expect(res.applied).toBe(false);
        expect(res.model).toBe(c.body.model);
      } else {
        expect(res.applied).toBe(true);
        expect(res.model).toBe(c.expected);
      }
    });
  }

  it("NEVER upgrades: a request for best-coding-paid is never moved to best-reasoning-paid", async () => {
    const res = await maybeApplyModelRouterTier({
      body: { model: "best-coding-paid", messages: FROM_BODY.messages } as never,
      modelStr: "best-coding-paid",
      config: cfg(),
      fetchImpl: classifyFetch("reasoning", 0.99),
    });
    expect(res.applied).toBe(false);
    expect(res.model).toBe("best-coding-paid");
  });

  it("the downgrade timeout (800ms) is used, not the full-policy timeout", async () => {
    const config = cfg();
    expect(config.downgradeTimeoutMs).toBe(800);
    const res = await maybeApplyModelRouterTier({
      body: FROM_BODY as never,
      modelStr: DEFAULT_DOWNGRADE_FROM,
      config,
      fetchImpl: hangFetch,
    });
    expect(res.applied).toBe(false);
  }, 5000);
});

describe("shadow mode", () => {
  it("never rewrites the model, even for a confident coding classification", async () => {
    const res = await maybeApplyModelRouterTier({
      body: FROM_BODY as never,
      modelStr: DEFAULT_DOWNGRADE_FROM,
      config: cfg({ policy: "downgrade", shadow: true }),
      fetchImpl: classifyFetch("coding", 0.95),
    });
    expect(res.applied).toBe(false);
    expect(res.model).toBe(DEFAULT_DOWNGRADE_FROM);
  });

  it("does not wait for the classifier (5s latency, resolves fast)", async () => {
    const t0 = Date.now();
    const res = await maybeApplyModelRouterTier({
      body: FROM_BODY as never,
      modelStr: DEFAULT_DOWNGRADE_FROM,
      config: cfg({ shadow: true }),
      fetchImpl: (async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return new Response(JSON.stringify({ tier: "coding", confidence: 0.95, fallback: false }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });
    const elapsed = Date.now() - t0;
    expect(res.applied).toBe(false);
    expect(elapsed).toBeLessThan(1000);
  });

  it("logs one MODEL_ROUTER_DECISION line with the required fields", async () => {
    const infoSpy = vi.fn();
    // spy through the module's log namespace
    vi.spyOn(await import("@/sse/utils/logger"), "info").mockImplementation(infoSpy);
    try {
      await maybeApplyModelRouterTier({
        body: FROM_BODY as never,
        modelStr: DEFAULT_DOWNGRADE_FROM,
        config: cfg({ shadow: true }),
        fetchImpl: classifyFetch("coding", 0.95),
      });
      // fire-and-forget: let the microtask chain settle
      await new Promise((r) => setTimeout(r, 50));
      const call = infoSpy.mock.calls.find((c) => c[0] === "MODEL_ROUTER_DECISION");
      expect(call).toBeTruthy();
      const line = call![1] as string;
      expect(line).toMatch(/^policy=shadow requested=best-reasoning-paid would=/);
      for (const field of [
        "policy=",
        "requested=",
        "would=",
        "tier=",
        "conf=",
        "fb=",
        "sticky=",
        "sess=",
        "ms=",
        "applied=",
      ]) {
        expect(line).toContain(field);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("decision line renderer format", () => {
    const line = renderModelRouterDecisionLine({
      policy: "shadow",
      requested: "best-reasoning-paid",
      would: "best-coding-paid",
      tier: "coding",
      confidence: 0.95,
      fb: false,
      sticky: false,
      sess: "abc123",
      ms: 12.3,
      applied: false,
    });
    expect(line).toBe(
      "policy=shadow requested=best-reasoning-paid would=best-coding-paid tier=coding conf=0.950 fb=false sticky=false sess=abc123 ms=12.3 applied=false"
    );
  });
});

describe("sticky session tier (sidecar classify_body port)", () => {
  const longBody = (last: string) => ({
    messages: [
      {
        role: "user",
        content: "This is the opening question of the session, well over forty characters long.",
      },
      { role: "assistant", content: "ok" },
      { role: "user", content: last },
    ],
  });
  const fresh = (tier: string, fb = false) => ({
    tier: tier as never,
    confidence: 0.9,
    probabilities: [],
    fallback: fb,
  });

  it("session key = sha1(first user text)[:12]", () => {
    expect(sessionKeyFromUsers(["abc"])).toMatch(/^[0-9a-f]{12}$/);
  });

  it("short last turn (<40 chars) reuses the stored tier", () => {
    classifyWithSessions(
      longBody(
        "This is the opening question of the session, well over forty characters long."
      ) as never,
      fresh("reasoning")
    );
    const second = classifyWithSessions(longBody("short follow-up") as never, fresh("coding"));
    expect(second.sticky).toBe(true);
    expect(second.result.tier).toBe("reasoning");
    expect(second.result.fallback).toBe(false);
  });

  it("long fresh-confident turn reclassifies; long fresh-fallback turn sticks (to the tier stored by the previous call)", () => {
    const opener = "This is the opening question of the session, well over forty characters long.";
    classifyWithSessions(longBody("any turn") as never, fresh("reasoning"));
    // fresh classification NOT fallback → sticky false → new tier wins
    const a = classifyWithSessions(
      longBody("a brand new long substantive request that changes topic entirely") as never,
      fresh("coding")
    );
    expect(a.sticky).toBe(false);
    expect(a.result.tier).toBe("coding");
    // fresh fallback=true → sticky → reuses the tier stored by call `a` (coding)
    const b = classifyWithSessions(
      longBody("another brand new long substantive request, different topic") as never,
      fresh("reasoning", true)
    );
    expect(b.sticky).toBe(true);
    expect(b.result.tier).toBe("coding");
    void opener;
  });

  it("[System: nudge last turn reuses the stored tier", () => {
    classifyWithSessions(longBody("any turn") as never, fresh("reasoning"));
    const nudged = classifyWithSessions(
      {
        messages: [
          {
            role: "user",
            content:
              "This is the opening question of the session, well over forty characters long.",
          },
          { role: "assistant", content: "ok" },
          { role: "user", content: "[System: previous response truncated, continue]" },
        ],
      } as never,
      fresh("coding")
    );
    expect(nudged.sticky).toBe(true);
    expect(nudged.result.tier).toBe("reasoning");
  });

  it("no user turns + empty state → coding fallback", () => {
    const r = classifyWithSessions({ messages: [] } as never, null);
    expect(r.result.tier).toBe("coding");
    expect(r.result.fallback).toBe(true);
    expect(r.session).toBe("");
  });
});

describe("isHarnessNudge", () => {
  it("matches the sidecar's lstrip+prefix rule", () => {
    expect(isHarnessNudge("[System: nudge]")).toBe(true);
    expect(isHarnessNudge("   [System: indented]")).toBe(true);
    expect(isHarnessNudge("\t[System: tabbed]")).toBe(true);
    expect(isHarnessNudge("not[System: at start")).toBe(false);
    expect(isHarnessNudge("plain text")).toBe(false);
    expect(isHarnessNudge("")).toBe(false);
  });
});
