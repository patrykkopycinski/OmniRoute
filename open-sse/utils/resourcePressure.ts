import { checkHeapPressureGuard, HEAP_PRESSURE_THRESHOLD_MB } from "./heapPressure.ts";
import { buildErrorBody } from "./error.ts";
import {
  createResourcePressureTracker,
  resourcePressureRetryAfterSeconds,
  resolveResourcePressureThresholds,
  RESOURCE_PRESSURE_RETRY_AFTER_MIN_SECONDS,
  type ChatPressureWeight,
  type PressureReason,
  type ResourcePressureState,
  type ResourcePressureThresholds,
  type ResourceSignals,
} from "./resourcePressurePolicy.ts";
import {
  sampleResourceSignals,
  type SampleResourceSignalsDeps,
} from "./resourcePressureSampler.ts";

const MB = 1024 * 1024;
const PRESSURE_MESSAGE = "Service temporarily unavailable due to resource pressure. Retry shortly.";

export type ResourcePressureGuardResult = {
  success: false;
  status: 503;
  error: string;
  response: Response;
};

export type ResourcePressureObservation = {
  signals: ResourceSignals | null;
  state: ResourcePressureState;
};

export type ResourcePressureRuntimeOptions = {
  thresholds?: Partial<ResourcePressureThresholds>;
  heapThresholdMb?: number | null;
  immediateHeapUsedMb?: () => number;
  sample?: () => Promise<ResourceSignals>;
  nowMs?: () => number;
  schedule?: (refresh: () => void) => void;
  staleAfterMs?: number;
  maxStaleMs?: number;
  retryAfterMs?: number;
  samplerDeps?: SampleResourceSignalsDeps;
};

export type ResourcePressureCheckOptions = {
  /**
   * Declared weight of the request being checked. A `"light"` request still
   * drives the full check — sampler refresh and tracker state update — but its
   * verdict is discarded before a 503 is built or logged. Passing the weight in
   * here (rather than discarding the result at the call site) is what keeps the
   * logs honest: a fabricated-then-dropped guard would emit a
   * `returning 503` warn line for a request that was actually admitted.
   */
  requestWeight?: ChatPressureWeight;
};

export type ResourcePressureRuntime = {
  check: (options?: ResourcePressureCheckOptions) => ResourcePressureGuardResult | null;
  getObservation: () => ResourcePressureObservation;
  whenRefreshSettled: () => Promise<void>;
  dispose: () => void;
};

function emptyState(): ResourcePressureState {
  return {
    severity: "normal",
    reason: "none",
    elevatedStreak: 0,
    recoveryStreak: 0,
    lastTransitionAtMs: 0,
    observedAtMs: 0,
  };
}

function requireDuration(name: string, value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 3_600_000) {
    throw new RangeError(`${name} must be an integer between 0 and 3600000`);
  }
  return value;
}

/**
 * Human-readable key=value detail appended to the rejection log line. Every
 * rejection (immediate heap trip AND cached-critical-state reuse) goes
 * through here, so this is the one place that needs the actual numbers —
 * the bare reason code alone ("psi_some") gives an operator nothing to act
 * on when deciding whether the guard is mistuned vs. genuinely saturated.
 */
function formatPressureDetail(detail: Record<string, number | string | null | undefined>): string {
  return Object.entries(detail)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value ?? "null"}`)
    .join(" ");
}

/** Builds buildCriticalGuard's detail object for the cached-critical-state
 * reuse path in check() -- pulled out of check() itself so that function's
 * own cyclomatic complexity stays under the ratchet, not because this needs
 * to be reused anywhere else. */
function describeCachedPressure(params: {
  signals: ResourceSignals | null;
  recoveryStreak: number;
  cacheAgeMs: number;
}): Record<string, number | string | null> {
  const cgroup = params.signals?.cgroup;
  return {
    psiSomeAvg10: params.signals?.psi?.someAvg10 ?? null,
    psiFullAvg10: params.signals?.psi?.fullAvg10 ?? null,
    cgroupCurrentMb: cgroup?.currentBytes ? Math.round(cgroup.currentBytes / MB) : null,
    cgroupMaxMb: cgroup?.maxBytes ? Math.round(cgroup.maxBytes / MB) : null,
    recoveryStreak: params.recoveryStreak,
    sampleAgeMs: params.cacheAgeMs,
  };
}

function buildCriticalGuard(
  reason: PressureReason,
  detail: Record<string, number | string | null | undefined> = {},
  retryAfterSeconds: number = RESOURCE_PRESSURE_RETRY_AFTER_MIN_SECONDS
): ResourcePressureGuardResult {
  const detailText = formatPressureDetail(detail);
  console.warn(
    `[resourcePressure] critical pressure guard tripped (reason=${reason}${detailText ? " " + detailText : ""}); returning 503`
  );
  return {
    success: false,
    status: 503,
    error: PRESSURE_MESSAGE,
    response: new Response(
      JSON.stringify(
        buildErrorBody(503, PRESSURE_MESSAGE, undefined, {
          type: "server_error",
          code: "resource_pressure",
        })
      ),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          // Derived from how long the pressure state has already lasted — a fixed
          // hint made clients re-send into an episode that runs for minutes.
          "Retry-After": String(retryAfterSeconds),
        },
      }
    ),
  };
}

/**
 * Live heap trip check. Returns the numbers behind the trip (never a ready
 * response) — the caller builds the single 503, so one trip produces exactly one
 * `[resourcePressure]` warn line carrying the detail AND the derived
 * `Retry-After`. `checkHeapPressureGuard`'s own 503 body is still built here only
 * because it owns the historical `[chatCore] heap pressure guard tripped` warn.
 */
function immediateHeapGuard(
  heapUsedMb: number,
  thresholdMb: number | null
): { heapUsedMb: number; thresholdMb: number } | null {
  if (thresholdMb == null) return null;
  if (!checkHeapPressureGuard(heapUsedMb, thresholdMb)) return null;
  return { heapUsedMb, thresholdMb };
}

export function createResourcePressureRuntime(
  options: ResourcePressureRuntimeOptions = {}
): ResourcePressureRuntime {
  const heapThresholdMb =
    options.heapThresholdMb === undefined ? HEAP_PRESSURE_THRESHOLD_MB : options.heapThresholdMb;
  if (heapThresholdMb !== null && (!Number.isFinite(heapThresholdMb) || heapThresholdMb <= 0)) {
    throw new RangeError("heapThresholdMb must be positive and finite or null");
  }
  const thresholds = resolveResourcePressureThresholds({
    ...options.thresholds,
    heapAbsoluteThresholdMb:
      options.thresholds?.heapAbsoluteThresholdMb === undefined
        ? null
        : options.thresholds.heapAbsoluteThresholdMb,
  });
  const staleAfterMs = requireDuration("staleAfterMs", options.staleAfterMs ?? 1_000);
  const maxStaleMs = requireDuration("maxStaleMs", options.maxStaleMs ?? 30_000);
  const retryAfterMs = requireDuration("retryAfterMs", options.retryAfterMs ?? 1_000);
  if (maxStaleMs < staleAfterMs) {
    throw new RangeError("maxStaleMs must be greater than or equal to staleAfterMs");
  }

  const nowMs = options.nowMs ?? Date.now;
  const immediateHeapUsedMb =
    options.immediateHeapUsedMb ?? (() => process.memoryUsage().heapUsed / MB);
  const sample = options.sample ?? (() => sampleResourceSignals(options.samplerDeps));
  const schedule =
    options.schedule ??
    ((refresh) => {
      const handle = setImmediate(refresh);
      handle.unref();
    });
  const tracker = createResourcePressureTracker(thresholds);

  let lastSignals: ResourceSignals | null = null;
  let state = emptyState();
  let lastRefreshAtMs = Number.NEGATIVE_INFINITY;
  let nextRefreshAtMs = Number.NEGATIVE_INFINITY;
  let scheduled = false;
  let inFlight: Promise<void> | null = null;
  let disposed = false;

  const refresh = (): void => {
    if (disposed || inFlight) return;
    scheduled = false;
    inFlight = Promise.resolve()
      .then(sample)
      .then((signals) => {
        if (disposed) return;
        const settledAtMs = nowMs();
        lastSignals = signals;
        state = tracker.observe(signals);
        lastRefreshAtMs = settledAtMs;
        nextRefreshAtMs = settledAtMs + staleAfterMs;
      })
      .catch(() => {
        if (!disposed) nextRefreshAtMs = nowMs() + retryAfterMs;
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const scheduleRefresh = (): void => {
    if (disposed || scheduled || inFlight) return;
    scheduled = true;
    schedule(refresh);
  };

  return {
    check(options: ResourcePressureCheckOptions = {}) {
      // A light request is shed by nobody, but it must still drive the whole
      // check: `scheduleRefresh()` below is the ONLY pump of the sampler, so an
      // early return here would freeze the observation during light-only
      // traffic. The weight is consulted at each RETURN instead — that also
      // keeps `buildCriticalGuard`'s "returning 503" warn line off requests
      // that were in fact admitted.
      const light = options.requestWeight === "light";
      let heapUsedMb = 0;
      try {
        heapUsedMb = immediateHeapUsedMb();
      } catch {
        heapUsedMb = 0;
      }
      const immediate = immediateHeapGuard(heapUsedMb, heapThresholdMb);
      const now = nowMs();
      if (now >= nextRefreshAtMs) scheduleRefresh();
      if (immediate) {
        // Keep the ONSET of the absolute spike: a fresh `lastTransitionAtMs`
        // per check would report every trip as brand new, so the derived
        // `Retry-After` could never convey that an episode has been running for
        // minutes (which is exactly the case this guard fires in). Severity and
        // reason are already what we are about to record, so only the
        // observation stamp moves while the spike persists.
        state =
          state.severity === "critical" && state.reason === "v8_heap_absolute"
            ? { ...state, observedAtMs: now }
            : {
                severity: "critical",
                reason: "v8_heap_absolute",
                elevatedStreak: 0,
                recoveryStreak: 0,
                lastTransitionAtMs: now,
                observedAtMs: now,
              };
        return light
          ? null
          : buildCriticalGuard(
              "v8_heap_absolute",
              {
                heapUsedMb: Math.round(immediate.heapUsedMb),
                thresholdMb: Math.round(immediate.thresholdMb),
              },
              resourcePressureRetryAfterSeconds(state, now)
            );
      }
      const cacheAge = lastSignals ? Math.max(0, now - lastRefreshAtMs) : Number.POSITIVE_INFINITY;
      if (cacheAge > maxStaleMs || state.severity !== "critical") {
        return null;
      }
      if (light) return null;
      return buildCriticalGuard(
        state.reason,
        describeCachedPressure({
          signals: lastSignals,
          recoveryStreak: state.recoveryStreak,
          cacheAgeMs: cacheAge,
        }),
        resourcePressureRetryAfterSeconds(state, now)
      );
    },
    getObservation: () => ({ signals: lastSignals, state }),
    whenRefreshSettled: async () => {
      if (scheduled) await new Promise<void>((resolve) => setImmediate(resolve));
      if (inFlight) await inFlight;
    },
    dispose() {
      disposed = true;
      scheduled = false;
    },
  };
}

let defaultRuntime = createResourcePressureRuntime();

/**
 * Chat-pipeline pressure fuse (fail-open on any sampling error).
 *
 * `requestWeight` lets the caller declare a LIGHT request (see
 * `src/shared/middleware/chatPressureWeight.ts`: a small declared body, few
 * messages/tools, a small structure-token estimate). Light requests fail OPEN
 * here: one that cannot measurably grow the heap must not burn an agent worker's
 * retry budget while the gateway is merely nursing its own working set — that
 * blanket refusal was killing workers mid-task. Heavy requests, and any request
 * whose weight the caller did not establish, are refused exactly as before.
 *
 * ⚠️ A light request still runs the FULL `check()` — never short-circuit before
 * it. `check()` is the ONLY thing that pumps the pressure sampler
 * (`scheduleRefresh()` is called from exactly one place, inside it; there is no
 * timer). If light-request paths returned early, a period of purely light
 * traffic would stop refreshing the observation entirely: `state` would freeze
 * at `critical`, `getResourcePressureObservation()` (which never samples) would
 * keep reporting it, and the structural gate would shed heavy requests forever
 * with no path back to `normal` — turning a self-clearing episode into a
 * permanent one. The weight is therefore passed INTO `check()`, which drops the
 * verdict at its return sites; discarding a built guard here instead would log a
 * `returning 503` warn line for a request that was actually admitted.
 */
export function checkResourcePressureGuard(
  options: { requestWeight?: ChatPressureWeight } = {}
): ResourcePressureGuardResult | null {
  // The weight goes INTO check() — the call always runs (it is the sampler's
  // only pump) and the runtime drops the verdict for a light request before a
  // 503 is built or logged.
  return defaultRuntime.check(options);
}

export function getResourcePressureObservation(): ResourcePressureObservation {
  return defaultRuntime.getObservation();
}

/** Honest `Retry-After` (seconds) for the CURRENT pressure state, for callers
 * that answer a pressure rejection outside this module (the chat-admission
 * gate). */
export function getResourcePressureRetryAfterSeconds(nowMs = Date.now()): number {
  return resourcePressureRetryAfterSeconds(defaultRuntime.getObservation().state, nowMs);
}

/** Replaces and disposes the process singleton when configuration is reloaded. */
export function reloadResourcePressureRuntime(
  options: ResourcePressureRuntimeOptions = {}
): ResourcePressureRuntime {
  defaultRuntime.dispose();
  defaultRuntime = createResourcePressureRuntime(options);
  return defaultRuntime;
}

export type {
  ChatPressureWeight,
  PressureReason,
  PressureSeverity,
  ResourceMetricBytes,
  ResourcePressureState,
  ResourcePressureThresholds,
  ResourcePressureTracker,
  ResourceSignals,
} from "./resourcePressurePolicy.ts";
export {
  classifyAdaptiveResourcePressure as classifyResourcePressure,
  createResourcePressureTracker,
  resolveResourcePressureThresholds,
  resourcePressureRetryAfterSeconds,
  RESOURCE_PRESSURE_RETRY_AFTER_MAX_SECONDS,
  RESOURCE_PRESSURE_RETRY_AFTER_MIN_SECONDS,
} from "./resourcePressurePolicy.ts";
export {
  sampleResourceSignals,
  sanitizeMemoryBytes,
  type ResourcePressureFs,
  type SampleResourceSignalsDeps,
} from "./resourcePressureSampler.ts";
