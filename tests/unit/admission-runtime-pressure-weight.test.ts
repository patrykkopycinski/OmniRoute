/**
 * Gate 4 — the adaptive-admission runtime's own pressure fuse.
 *
 * `AdaptiveAdmissionRuntimeImpl.acquire()` runs BEFORE chatCore's and
 * chatHelpers' pressure guards (`chat.ts:751` -> `chatAdmission.ts`
 * `runtime.acquire`), so wiring only those two leaves every light request still
 * rejected with `code:"resource_pressure"` on the live path — the exact failure
 * the weight-aware admission work exists to remove.
 *
 * The admit/shed cases drive the REAL `checkResourcePressureGuard` facade
 * against a tripped process singleton rather than a hand-written stub: a stub
 * that ignored the weight argument would pass the fix while the deployed
 * behaviour stayed broken, which is precisely the gap this file closes. They
 * fail on the pre-fix commit (`933e3e78c`), where `acquire()` called
 * `this.checkResourcePressure()` with no arguments.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  createAdaptiveAdmissionRuntime,
  type AdaptiveAdmissionRuntime,
} from "../../open-sse/services/admission/runtime.ts";
import {
  checkResourcePressureGuard,
  getResourcePressureObservation,
  reloadResourcePressureRuntime,
} from "../../open-sse/utils/resourcePressure.ts";
import type {
  ChatPressureWeight,
  ResourceSignals,
} from "../../open-sse/utils/resourcePressurePolicy.ts";

const MiB = 1024 ** 2;

function signals(observedAtMs: number, heapUsedMb: number): ResourceSignals {
  return {
    observedAtMs,
    v8: { heapUsedBytes: heapUsedMb * MiB, heapLimitBytes: 1_000 * MiB },
    process: {
      rssBytes: 200 * MiB,
      externalBytes: 10 * MiB,
      arrayBuffersBytes: MiB,
      availableBytes: null,
      constrainedBytes: null,
    },
    cgroup: { currentBytes: null, maxBytes: null, highBytes: null, fileBytes: null, events: null },
    psi: null,
  };
}

const LIGHT_BODY = {
  model: "m",
  messages: [{ role: "user", content: "hi" }],
};

/** Past the default message-count and estimated-token bounds (200 / 32_000). */
const HEAVY_BODY = {
  model: "m",
  messages: Array.from({ length: 220 }, () => ({
    role: "user",
    content: "x".repeat(2_000),
  })),
};

/**
 * Trip the process-wide pressure singleton on its absolute heap guard and return
 * the restore fn. `reloadResourcePressureRuntime` is the supported seam; the
 * admission runtime below is built with NO `checkResourcePressure` override, so
 * it resolves the real facade exactly as production does.
 */
function tripProcessPressure(): () => void {
  reloadResourcePressureRuntime({
    heapThresholdMb: 100,
    immediateHeapUsedMb: () => 500,
    sample: async () => signals(0, 950),
  });
  return () => {
    reloadResourcePressureRuntime({
      immediateHeapUsedMb: () => 0,
      sample: async () => signals(0, 1),
    });
  };
}

function admissionRuntime(): AdaptiveAdmissionRuntime {
  return createAdaptiveAdmissionRuntime({});
}

describe("adaptive-admission gate 4: weight-aware resource pressure", () => {
  it("admits a LIGHT request under critical pressure and still sheds a HEAVY one", async () => {
    const restore = tripProcessPressure();
    const runtime = admissionRuntime();
    try {
      // Precondition: the process guard really is firing for an unclassified caller.
      assert.ok(
        checkResourcePressureGuard(),
        "precondition: the process pressure guard must be tripped"
      );

      const light = await runtime.acquire({
        tenantKey: "t",
        body: LIGHT_BODY,
        streaming: false,
      });
      assert.equal(
        light.status,
        "admitted",
        "a 5-token ping must not be shed by the adaptive-admission pressure fuse"
      );
      if (light.status === "admitted") light.lease.release("success");

      const heavy = await runtime.acquire({
        tenantKey: "t",
        body: HEAVY_BODY,
        streaming: false,
      });
      assert.equal(heavy.status, "rejected");
      assert.equal((heavy as { code?: string }).code, "resource_pressure");
    } finally {
      runtime.dispose();
      restore();
    }
  });

  it("treats a body whose weight cannot be established as HEAVY", async () => {
    const restore = tripProcessPressure();
    const runtime = admissionRuntime();
    try {
      const result = await runtime.acquire({
        tenantKey: "t",
        body: { prompt: "an envelope with no chat shape" },
        streaming: false,
      });
      assert.equal(result.status, "rejected");
      assert.equal((result as { code?: string }).code, "resource_pressure");
    } finally {
      runtime.dispose();
      restore();
    }
  });

  it("declares the request weight on the injected seam", async () => {
    const weights: (ChatPressureWeight | undefined)[] = [];
    const runtime = createAdaptiveAdmissionRuntime({
      checkResourcePressure: (options) => {
        weights.push(options?.requestWeight);
        return null;
      },
    });
    try {
      const light = await runtime.acquire({ tenantKey: "t", body: LIGHT_BODY });
      if (light.status === "admitted") light.lease.release("success");
      const heavy = await runtime.acquire({ tenantKey: "t", body: HEAVY_BODY });
      if (heavy.status === "admitted") heavy.lease.release("success");
      assert.deepEqual(weights, ["light", "heavy"]);
    } finally {
      runtime.dispose();
    }
  });
});

/**
 * A light request must be silent as well as admitted. The first shape of this
 * fix built the guard and dropped it at the facade, which left
 * `buildCriticalGuard`'s `... returning 503` warn line on every admitted ping —
 * the same "logs say one thing, the response says another" confusion this card
 * exists to remove. The weight therefore goes INTO `check()`.
 */
describe("light requests under pressure are silent", () => {
  it("logs no 'returning 503' warn line for a request it admits", async () => {
    const restore = tripProcessPressure();
    const runtime = admissionRuntime();
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const light = await runtime.acquire({ tenantKey: "t", body: LIGHT_BODY });
      assert.equal(light.status, "admitted");
      if (light.status === "admitted") light.lease.release("success");
      assert.deepEqual(
        warnings.filter((line) => line.includes("[resourcePressure]")),
        [],
        "an admitted request must not log a pressure rejection"
      );

      const heavy = await runtime.acquire({ tenantKey: "t", body: HEAVY_BODY });
      assert.equal(heavy.status, "rejected");
      assert.equal(
        warnings.filter((line) => line.includes("[resourcePressure]")).length,
        1,
        "a real shed still logs exactly one line"
      );
    } finally {
      console.warn = originalWarn;
      runtime.dispose();
      restore();
    }
  });
});

/**
 * Pump invariant. `check()` is the ONLY thing that schedules a sampler refresh
 * (`scheduleRefresh()` is called from exactly one place, inside it; there is no
 * timer). A light-request path that returned BEFORE calling `check()` would stop
 * refreshing the observation during light-only traffic: `state` would freeze at
 * `critical` and the structural gate would shed heavy requests forever with no
 * path back to `normal` — a self-clearing episode turned permanent. This pins
 * that light traffic keeps the sampler running.
 */
describe("pressure sampler pump under light-only traffic", () => {
  it("lets pressure recover to normal even when every request is LIGHT", async () => {
    let now = 0;
    let heapUsedMb = 950; // 0.95 of the limit — above criticalRatio 0.92.
    let samples = 0;
    const runtime = reloadResourcePressureRuntime({
      nowMs: () => now,
      // Absolute heap guard off: this test is about the SAMPLED tracker state.
      heapThresholdMb: null,
      staleAfterMs: 1,
      immediateHeapUsedMb: () => 0,
      sample: async () => {
        samples += 1;
        return signals(now, heapUsedMb);
      },
    });

    const lightCheck = async () => {
      assert.equal(
        checkResourcePressureGuard({ requestWeight: "light" }),
        null,
        "a light request must never be shed"
      );
      now += 10;
      await runtime.whenRefreshSettled();
    };

    try {
      // Only light traffic from here on — the scenario that would freeze a
      // short-circuiting implementation.
      for (let i = 0; i < 4; i += 1) await lightCheck();
      const primedSamples = samples;
      assert.ok(primedSamples >= 2, "light traffic must drive the sampler");
      assert.equal(
        getResourcePressureObservation().state.severity,
        "critical",
        "precondition: sampled state reached critical"
      );

      // The heap recovers. Only further check() calls can ever observe it.
      heapUsedMb = 10;
      for (let i = 0; i < 4; i += 1) await lightCheck();

      assert.ok(samples > primedSamples, "light requests must keep pumping the sampler");
      assert.equal(
        getResourcePressureObservation().state.severity,
        "normal",
        "pressure must return to normal — a frozen observation sheds heavy requests forever"
      );
    } finally {
      reloadResourcePressureRuntime({
        immediateHeapUsedMb: () => 0,
        sample: async () => signals(0, 1),
      });
    }
  });
});
