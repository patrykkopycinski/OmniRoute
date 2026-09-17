/**
 * Gate 1 — the pre-read chat-admission pressure gate — must PUMP the sampler,
 * not just read the cached observation.
 *
 * `ResourcePressureRuntime.check()` is the ONLY pump (`scheduleRefresh()` is
 * called from exactly one place, inside it; there is no timer). Gate 1 used to
 * shed on `controller.pressureSeverity()`, a cached read that never samples, and
 * it returns BEFORE the request can reach gate 4
 * (`AdaptiveAdmissionRuntimeImpl.acquire()`, the only other pump on this path).
 * So a burst of purely HEAVY traffic under critical pressure froze the
 * observation: `state` stayed `critical` after the heap had fully recovered and
 * gate 1 kept shedding, with nothing left to move it back to `normal`.
 *
 * This is the heavy-traffic mirror of the light-traffic pump test in
 * `admission-runtime-pressure-weight.test.ts`, and it drives the REAL
 * `checkResourcePressureGuard` facade against a tripped process singleton — a
 * stub that ignored the weight (or never sampled) would pass the fix while the
 * deployed behaviour stayed broken.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  reloadResourcePressureRuntime,
  getResourcePressureObservation,
  checkResourcePressureGuard,
} from "../../open-sse/utils/resourcePressure.ts";
import type { ResourceSignals } from "../../open-sse/utils/resourcePressurePolicy.ts";
import type { ChatPressureWeight } from "../../src/shared/middleware/chatPressureWeight.ts";

const { ChatAdmissionController, admitChatRequest, defaultPressureSeverity } =
  await import("../../src/shared/middleware/chatBodyAdmission.ts");

const MiB = 1024 ** 2;
const silentSink = () => {};

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

function requestOf(bytes: number): Request {
  const body = "x".repeat(bytes);
  return new Request("http://x/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(body.length) },
    body,
  });
}

/** A controller wired exactly like the production singleton: its severity probe
 * is the cached process observation, never a per-test constant. */
function liveController() {
  return new ChatAdmissionController(Number.MAX_SAFE_INTEGER, undefined, 0, silentSink, {
    maxInflightBytes: 1024 * MiB,
    checkPressureSeverity: defaultPressureSeverity,
  });
}

const GATE_OPTIONS = {
  largeBodyBytes: 1024,
  hardMaxBytes: 10 * MiB,
  queueMs: 0,
} as const;

function restoreQuietRuntime(): void {
  reloadResourcePressureRuntime({
    immediateHeapUsedMb: () => 0,
    sample: async () => signals(0, 1),
  });
}

test("gate 1: heavy-only traffic keeps pumping the sampler and lets pressure recover", async () => {
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
  const controller = liveController();

  try {
    // Prime to critical the way the live process does — via any path that calls
    // check(). Gate 1's own pump is what this test is about, so priming must not
    // depend on it.
    for (let i = 0; i < 4; i += 1) {
      checkResourcePressureGuard({ requestWeight: "light" });
      now += 10;
      await runtime.whenRefreshSettled();
    }
    const primedSamples = samples;
    assert.ok(primedSamples >= 2, "precondition: the sampler was primed");
    assert.equal(
      getResourcePressureObservation().state.severity,
      "critical",
      "precondition: sampled state reached critical"
    );

    // The heap fully recovers. From here on the traffic is HEAVY ONLY: every
    // request is shed by gate 1 before it can reach any other pump.
    heapUsedMb = 10;
    let shed = 0;
    for (let i = 0; i < 4; i += 1) {
      const result = await admitChatRequest(requestOf(4096), {
        controller,
        sessionId: "heavy-only",
        ...GATE_OPTIONS,
      });
      if (result.admit) result.lease?.release();
      else shed += 1;
      now += 10;
      await runtime.whenRefreshSettled();
    }

    assert.ok(
      samples > primedSamples,
      `heavy requests must keep pumping the sampler (primed ${primedSamples}, now ${samples})`
    );
    assert.equal(
      getResourcePressureObservation().state.severity,
      "normal",
      "pressure must return to normal — a frozen observation sheds heavy requests forever"
    );
    assert.ok(shed >= 1, "sanity: the burst really did start out being shed");

    // And the gate reopens for heavy traffic once the state has recovered.
    const afterRecovery = await admitChatRequest(requestOf(4096), {
      controller,
      sessionId: "heavy-only",
      ...GATE_OPTIONS,
    });
    assert.equal(afterRecovery.admit, true, "a recovered gateway must admit heavy requests again");
    if (afterRecovery.admit) afterRecovery.lease?.release();

    // The pump is UNCONDITIONAL, not gated on an already-critical state: a gate
    // that only samples while it is shedding cannot observe pressure BUILDING,
    // so the next episode would be detected only once some other path happens to
    // call check().
    now += 10;
    await runtime.whenRefreshSettled();
    const recoveredSamples = samples;
    for (let i = 0; i < 2; i += 1) {
      const result = await admitChatRequest(requestOf(4096), {
        controller,
        sessionId: "heavy-only",
        ...GATE_OPTIONS,
      });
      if (result.admit) result.lease?.release();
      now += 10;
      await runtime.whenRefreshSettled();
    }
    assert.ok(
      samples > recoveredSamples,
      `heavy traffic must keep sampling under NORMAL pressure too (was ${recoveredSamples}, now ${samples})`
    );

    // ...and so must LIGHT traffic through this same gate. A light request is
    // shed by nobody, but short-circuiting it before the pump would reintroduce
    // the frozen observation from the other direction (light-only traffic).
    const lightSamples = samples;
    for (let i = 0; i < 2; i += 1) {
      const result = await admitChatRequest(requestOf(64), {
        controller,
        sessionId: "light-pump",
        ...GATE_OPTIONS,
      });
      assert.equal(result.admit, true, "a light request must never be shed");
      if (result.admit) result.lease?.release();
      now += 10;
      await runtime.whenRefreshSettled();
    }
    assert.ok(
      samples > lightSamples,
      `light traffic must pump the sampler at gate 1 too (was ${lightSamples}, now ${samples})`
    );
  } finally {
    restoreQuietRuntime();
  }
});

test("gate 1: a tripped singleton still sheds HEAVY and still admits LIGHT", async () => {
  reloadResourcePressureRuntime({
    heapThresholdMb: 100,
    immediateHeapUsedMb: () => 500,
    sample: async () => signals(0, 950),
  });
  const controller = liveController();

  try {
    assert.ok(
      checkResourcePressureGuard(),
      "precondition: the process pressure guard must be tripped"
    );

    const heavy = await admitChatRequest(requestOf(4096), {
      controller,
      sessionId: "gate1-heavy",
      ...GATE_OPTIONS,
    });
    assert.equal(heavy.admit, false, "a heavy request must still be shed under critical pressure");
    if (!heavy.admit) {
      assert.equal(heavy.response.status, 503);
      const payload = (await heavy.response.json()) as { error: { code: string } };
      assert.equal(payload.error.code, "resource_pressure");
    }
    assert.equal(controller.shedsByReason.resource_pressure, 1);

    const light = await admitChatRequest(requestOf(64), {
      controller,
      sessionId: "gate1-light",
      ...GATE_OPTIONS,
    });
    assert.equal(light.admit, true, "a request that cannot grow the heap must not be refused");
    if (light.admit) {
      assert.equal((await light.request.text()).length, 64, "the body reaches the handler intact");
      light.lease?.release();
    }
    assert.equal(
      controller.shedsByReason.resource_pressure,
      1,
      "the light request must not record a shed"
    );
  } finally {
    restoreQuietRuntime();
  }
});

test("gate 1: declares the request weight on the injected pressure seam", async () => {
  const weights: (ChatPressureWeight | undefined)[] = [];
  const controller = liveController();
  const pressureCheck = (options?: { requestWeight?: ChatPressureWeight }) => {
    weights.push(options?.requestWeight);
    return null;
  };

  const heavy = await admitChatRequest(requestOf(4096), {
    controller,
    sessionId: "seam-heavy",
    ...GATE_OPTIONS,
    pressureCheck,
  });
  if (heavy.admit) heavy.lease?.release();
  const light = await admitChatRequest(requestOf(64), {
    controller,
    sessionId: "seam-light",
    ...GATE_OPTIONS,
    pressureCheck,
  });
  if (light.admit) light.lease?.release();

  assert.deepEqual(weights, ["heavy", "light"]);
});

test("gate 1: an admitted LIGHT request logs no pressure rejection", async () => {
  reloadResourcePressureRuntime({
    heapThresholdMb: 100,
    immediateHeapUsedMb: () => 500,
    sample: async () => signals(0, 950),
  });
  const controller = liveController();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  try {
    const light = await admitChatRequest(requestOf(64), {
      controller,
      sessionId: "silent-light",
      ...GATE_OPTIONS,
    });
    assert.equal(light.admit, true);
    if (light.admit) light.lease?.release();
    assert.deepEqual(
      warnings.filter((line) => line.includes("[resourcePressure]")),
      [],
      "an admitted request must not log a pressure rejection"
    );

    const heavy = await admitChatRequest(requestOf(4096), {
      controller,
      sessionId: "silent-heavy",
      ...GATE_OPTIONS,
    });
    assert.equal(heavy.admit, false);
    assert.equal(
      warnings.filter((line) => line.includes("[resourcePressure]")).length,
      1,
      "a real shed still logs exactly one line"
    );
  } finally {
    console.warn = originalWarn;
    restoreQuietRuntime();
  }
});
