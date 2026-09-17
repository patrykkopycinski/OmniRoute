/**
 * Bounded WORKING-SET budget for large-context chat requests.
 *
 * Why this exists: the gateway's resource-pressure guard is a V8-heap threshold
 * (`heapUsed >= max(heap_size_limit * 0.85, 400 MB)` — `open-sse/utils/heapPressure.ts`), which
 * trips only once the heap has ALREADY reached the guard. The existing admission gates count
 * the wrong quantity for that failure mode:
 *
 *  - the legacy heavyweight count cap counts REQUESTS (`OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT`),
 *    so N large-context turns and N one-line turns are priced identically;
 *  - the auto-derived ingest byte budget (`admissionBudget.ts`) counts RAW BODY BYTES against a
 *    25%-of-ceiling / 8x-amplification budget, so on an 8 GiB heap it is ~256 MB — far above the
 *    6-12 MB of bodies six 1-2 MB coding-agent turns actually declare, i.e. it never binds;
 *  - nothing anywhere answers "how many megabytes of large-context work are in flight right now?".
 *
 * This module adds that missing quantity: a process-wide (plus per-lane) budget over the
 * ESTIMATED WORKING SET of in-flight large-context requests, priced from the buffered body size
 * and/or the structural token estimate, and held for the whole request — including the SSE
 * stream lifetime, because the stream is what keeps the translated payload and its buffers
 * resident.
 *
 * Non-goals: this is not a heap-pressure reaction (see the resource-pressure tracker for that),
 * and it does not replace the byte-stage ingest bound. It is a capacity ceiling that keeps the
 * concurrency of large-context work inside the heap the process actually has, so a sweep plus a
 * worker fan-out cannot drive `heapUsed` to the absolute guard on their own.
 *
 * Honesty rules baked into the design:
 *  - the shed decision reports the real numbers (`workBytesInFlight`, `requestWorkBytes`,
 *    `effectiveBudgetBytes`, `lane`, occupancy-derived `Retry-After`) instead of only a severity;
 *  - a request whose size is UNKNOWN is not charged (no invented number). Its true byte size is
 *    still bounded by the byte-stage hard cap, and its message/tool shape by the structural gate.
 *  - `OMNIROUTE_CHAT_WORK_AMPLIFICATION` is the one empirical constant: retained working-set bytes
 *    per raw request byte. It is BENCHMARK-DERIVED, not guessed: `npm run bench:heap-body`
 *    measures the real production helpers (entry-point log clone, bounded log clone, per-combo-target
 *    attempt bodies, token-estimate serialization) and reported 5.2x wire for a 1.3 MB / 480-message
 *    agent body and 5.2x for the 3.1 MB / 729-message #7847 shape; the default rounds that up to 8.
 *    Recipe and numbers: `docs/architecture/admission-lanes.md` §5.
 *  - It prices the REQUEST-BODY copies only. It does not price the rest of the per-request heap
 *    (translated payloads, compression copies, upstream/SSE buffers), so §5 also records the live
 *    concurrency measurement and the arithmetic showing at what offered load this ceiling binds.
 *    Read §5 before treating a green run as "large-context load is now capped": at the concurrency
 *    this deployment was measured at (<=13 concurrent >=100k-token requests, <=7 MB of prompt text
 *    in flight) the derived ceiling is ~5% occupied and never sheds.
 */
import v8 from "node:v8";
import { createLogger } from "../utils/logger";
import { CORS_HEADERS } from "../utils/cors";
import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";
import {
  getResourcePressureObservation,
  type PressureSeverity,
} from "@omniroute/open-sse/utils/resourcePressure.ts";
import { CHAT_HEAVY_ESTIMATED_TOKENS, CHAT_LARGE_BODY_BYTES } from "./chatBodyAdmission";

const workLog = createLogger("chat-work-budget");

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Share of the effective memory ceiling that in-flight large-context work may occupy.
 * The absolute heap guard trips at 0.85 * heap_size_limit, so a 0.5 * ceiling working-set
 * budget leaves the guard ~35% of the ceiling for garbage, non-request state and the
 * transient copies a single request makes on its way to dispatch.
 */
export const WORK_HEAP_FRACTION = 0.5;
/** Floor keeps ordinary agent traffic alive on small hosts. */
export const MIN_WORK_BUDGET_BYTES = 64 * 1024 * 1024;
export const MAX_WORK_BUDGET_BYTES = 4 * 1024 * 1024 * 1024;
/**
 * Default per-lane share of the process budget. One lane (a sweep run, a fan-out of workers
 * sharing a key) can never hold more than half the process working-set budget, so it cannot
 * starve the other lanes out of the heap by itself.
 */
export const DEFAULT_LANE_SHARE = 0.5;

/**
 * Retained working-set bytes per raw request byte (benchmark-derived, see the module docblock).
 * 5.2x measured for the production body-copy helpers; rounded up to 8 for translation, compression
 * and dispatch copies the benchmark does not model. Override per deployment once measured on its
 * own payload mix.
 */
export const CHAT_WORK_AMPLIFICATION = parsePositiveNumber(
  process.env.OMNIROUTE_CHAT_WORK_AMPLIFICATION,
  8
);

/** Bounded wait for working-set capacity before the retryable 503. */
export const CHAT_WORK_QUEUE_MAX_MS = parseNonNegativeInt(
  process.env.OMNIROUTE_CHAT_WORK_QUEUE_MS,
  5000
);

export type ChatWorkShedReason = "work_budget" | "lane_work_budget" | "queue_timeout";

/**
 * Parse a caller-declared `Content-Length` into a byte count. Returns `null` for a missing or
 * dishonest value: a request whose size is unknown is deliberately NOT priced (no invented
 * number) — the byte stage still hard-bounds it, and the structural gate bounds its shape.
 */
export function declaredBodyBytes(
  headers: { get(name: string): string | null } | null | undefined
): number | null {
  return parseDeclaredBodyBytes(headers?.get("content-length") ?? null);
}

/** Same parse for a caller that already holds the raw header value. */
export function parseDeclaredBodyBytes(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^(0|[1-9]\d*)$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export interface ChatWorkBudgetOptions {
  maxWorkBytes: number;
  maxLaneWorkBytes?: number;
  amplification?: number;
  largeBodyBytes?: number;
  heavyEstimatedTokens?: number;
  checkPressureSeverity?: () => PressureSeverity;
}

export interface ReleasableLease {
  readonly released: boolean;
  release(): void;
}

export interface ChatWorkLease extends ReleasableLease {
  readonly bytes: number;
  readonly lane: string;
}

const NULL_WORK_LEASE: ChatWorkLease = {
  released: true,
  bytes: 0,
  lane: "none",
  release() {
    /* nothing reserved */
  },
};

export function nullChatWorkLease(): ChatWorkLease {
  return NULL_WORK_LEASE;
}

function parsePositiveFinite(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Pure budget calculation — no I/O, no env reads. `25%`-style fractions belong to the ingest
 * budget (transient amplification); this one prices a *resident* working set, so it uses the
 * ceiling directly with the fraction above.
 */
export function computeWorkByteBudget(input: {
  heapSizeLimitBytes: number;
  constrainedMemoryBytes?: number | null;
  override?: string | number | null;
}): { bytes: number; source: "override" | "cgroup" | "v8_heap"; effectiveCeilingBytes: number } {
  const override = parsePositiveFinite(input.override);
  if (override !== null) {
    const bytes = Math.min(MAX_WORK_BUDGET_BYTES, Math.max(MIN_WORK_BUDGET_BYTES, Math.floor(override)));
    return { bytes, source: "override", effectiveCeilingBytes: bytes };
  }
  const heapLimit = parsePositiveFinite(input.heapSizeLimitBytes) ?? MIN_WORK_BUDGET_BYTES;
  const constrained = parsePositiveFinite(input.constrainedMemoryBytes ?? null);
  const ceiling = constrained !== null ? Math.min(heapLimit, constrained) : heapLimit;
  const source = constrained !== null && constrained <= heapLimit ? "cgroup" : "v8_heap";
  const raw = Math.floor(ceiling * WORK_HEAP_FRACTION);
  return {
    bytes: Math.min(MAX_WORK_BUDGET_BYTES, Math.max(MIN_WORK_BUDGET_BYTES, raw)),
    source,
    effectiveCeilingBytes: Math.floor(ceiling),
  };
}

function readConstrainedMemoryBytes(): number | null {
  try {
    const proc = process as NodeJS.Process & { constrainedMemory?: () => number };
    if (typeof proc.constrainedMemory !== "function") return null;
    const value = proc.constrainedMemory();
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

let cachedBudget: ReturnType<typeof computeWorkByteBudget> | null = null;

export function resolveWorkByteBudget(
  override: string | number | null | undefined = process.env.OMNIROUTE_CHAT_MAX_WORK_BYTES
): ReturnType<typeof computeWorkByteBudget> {
  if (cachedBudget) return cachedBudget;
  cachedBudget = computeWorkByteBudget({
    heapSizeLimitBytes: v8.getHeapStatistics().heap_size_limit,
    constrainedMemoryBytes: readConstrainedMemoryBytes(),
    override,
  });
  return cachedBudget;
}

/** Test seam: force the next `resolveWorkByteBudget()` call to recompute. */
export function reloadWorkBudgetForTests(): void {
  cachedBudget = null;
}

/** Retryable 503 with an occupancy-derived Retry-After; the numbers live in the log line. */
export function workBudgetRejectionResponse(input: {
  workBytesInFlight: number;
  effectiveBudgetBytes: number;
  maxLaneWorkBytes: number;
  retryAfterSeconds: number;
  reason: ChatWorkShedReason;
}): Response {
  const budgetMiB = Math.max(1, Math.floor(input.effectiveBudgetBytes / (1024 * 1024)));
  const inflightMiB = Math.max(1, Math.round(input.workBytesInFlight / (1024 * 1024)));
  return new Response(
    JSON.stringify(
      buildErrorBody(
        503,
        `Local large-context working-set budget is exhausted (${inflightMiB} MB in flight of ${budgetMiB} MB); upstream routing was not attempted. Retry shortly.`,
        undefined,
        { type: "server_error", code: "chat_work_budget", reason: input.reason }
      )
    ),
    {
      status: 503,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
        "Retry-After": String(Math.max(1, Math.ceil(input.retryAfterSeconds))),
      },
    }
  );
}

interface WorkWaiter {
  readonly bytes: number;
  readonly lane: string;
  readonly resolve: (lease: ChatWorkLease | null) => void;
  settled: boolean;
}

/**
 * Process-local working-set reservation. Acquisition and accounting run in one synchronous turn,
 * so the budget cannot be oversubscribed by interleaved awaits.
 */
export class ChatWorkBudget {
  readonly #maxWorkBytes: number;
  readonly #maxLaneWorkBytes: number;
  readonly #amplification: number;
  readonly #largeBodyBytes: number;
  readonly #heavyEstimatedTokens: number;
  readonly #checkPressureSeverity: () => PressureSeverity;

  #inflightBytes = 0;
  #inflightRequests = 0;
  #peakInflightBytes = 0;
  readonly #laneBytes = new Map<string, number>();
  #waiters: WorkWaiter[] = [];
  readonly #sheds = new Map<ChatWorkShedReason, number>();

  constructor(options: ChatWorkBudgetOptions) {
    this.#maxWorkBytes = Math.max(1, Math.floor(options.maxWorkBytes));
    const lane = options.maxLaneWorkBytes ?? this.#maxWorkBytes * DEFAULT_LANE_SHARE;
    this.#maxLaneWorkBytes = Math.min(this.#maxWorkBytes, Math.max(1, Math.floor(lane)));
    this.#amplification = options.amplification ?? CHAT_WORK_AMPLIFICATION;
    this.#largeBodyBytes = options.largeBodyBytes ?? CHAT_LARGE_BODY_BYTES;
    this.#heavyEstimatedTokens = options.heavyEstimatedTokens ?? CHAT_HEAVY_ESTIMATED_TOKENS;
    this.#checkPressureSeverity = options.checkPressureSeverity ?? defaultPressureSeverity;
  }

  get maxWorkBytes(): number {
    return this.#maxWorkBytes;
  }

  get maxLaneWorkBytes(): number {
    return this.#maxLaneWorkBytes;
  }

  get amplification(): number {
    return this.#amplification;
  }

  get inflightBytes(): number {
    return this.#inflightBytes;
  }

  get inflightRequests(): number {
    return this.#inflightRequests;
  }

  get waitingCount(): number {
    return this.#waiters.length;
  }

  get peakInflightBytes(): number {
    return this.#peakInflightBytes;
  }

  laneBytes(lane: string): number {
    return this.#laneBytes.get(lane) ?? 0;
  }

  /** True when this request would be charged at all (small pings are never priced). */
  isLargeContext(bodyBytes: number | null | undefined, estimatedTokens: number | null | undefined): boolean {
    if (typeof bodyBytes === "number" && bodyBytes >= this.#largeBodyBytes) return true;
    if (typeof estimatedTokens === "number" && estimatedTokens >= this.#heavyEstimatedTokens) return true;
    return false;
  }

  /**
   * Honest price for one request. Bodies with a known size are priced from bytes; otherwise the
   * structural token estimate is used (4 bytes/token is the conservative ASCII ratio the
   * structural estimator itself assumes). Unknown size → 0, i.e. NOT charged.
   */
  priceWork(input: {
    bodyBytes?: number | null;
    estimatedTokens?: number | null;
  }): number {
    const bytes = parsePositiveFinite(input.bodyBytes);
    if (bytes !== null) return Math.ceil(bytes * this.#amplification);
    const tokens = parsePositiveFinite(input.estimatedTokens);
    if (tokens !== null) return Math.ceil(tokens * 4 * this.#amplification);
    return 0;
  }

  /** Pressure lowers the effective ceiling so the guard is reached strictly later, if ever. */
  effectiveBudgetBytes(severity: PressureSeverity = this.#checkPressureSeverity()): number {
    const factor = severity === "critical" ? 0.5 : severity === "high" ? 0.75 : 1;
    return Math.max(1, Math.floor(this.#maxWorkBytes * factor));
  }

  canFit(bytes: number, lane: string, effectiveBudgetBytes = this.effectiveBudgetBytes()): boolean {
    if (bytes <= 0) return true;
    if (this.#inflightBytes + bytes > effectiveBudgetBytes) return false;
    return this.laneBytes(lane) + bytes <= this.#maxLaneWorkBytes;
  }

  /** Which ceiling refused the reservation — the honest shed reason. */
  refusalReason(bytes: number, lane: string, effectiveBudgetBytes = this.effectiveBudgetBytes()): ChatWorkShedReason {
    if (this.laneBytes(lane) + bytes > this.#maxLaneWorkBytes) return "lane_work_budget";
    void effectiveBudgetBytes;
    return "work_budget";
  }

  tryAcquire(bytes: number, lane: string): ChatWorkLease | null {
    if (bytes <= 0) return nullChatWorkLease();
    if (!this.canFit(bytes, lane)) return null;
    return this.#reserve(bytes, lane);
  }

  /**
   * Bounded wait for working-set capacity. A parked waiter holds no reservation (its buffered
   * body is already counted by the byte-stage budget), so the wait cannot itself grow the
   * working set; waiters are woken FIFO when capacity frees.
   */
  acquireWithin(
    bytes: number,
    lane: string,
    waitMs: number,
    signal?: AbortSignal
  ): Promise<ChatWorkLease | null> {
    if (bytes <= 0) return Promise.resolve(nullChatWorkLease());
    if (this.canFit(bytes, lane)) return Promise.resolve(this.#reserve(bytes, lane));
    if (waitMs <= 0) return Promise.resolve(null);
    if (signal?.aborted) return Promise.resolve(null);

    return new Promise<ChatWorkLease | null>((resolve) => {
      const waiter: WorkWaiter = { bytes, lane, resolve, settled: false };
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (lease: ChatWorkLease | null) => {
        if (waiter.settled) return;
        waiter.settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#waiters = this.#waiters.filter((candidate) => candidate !== waiter);
        resolve(lease);
      };
      const onAbort = () => settle(null);
      timer = setTimeout(() => settle(null), waitMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
      // A release that raced with this registration must not strand the waiter.
      this.#drainWaiters();
    });
  }

  /** Retry-After hint derived from how full the budget is (never a bare constant). */
  retryAfterSeconds(effectiveBudgetBytes = this.effectiveBudgetBytes()): number {
    const ratio = Math.min(1, this.#inflightBytes / Math.max(1, effectiveBudgetBytes));
    return Math.max(2, Math.ceil(ratio * 30));
  }

  recordShed(reason: ChatWorkShedReason): void {
    this.#sheds.set(reason, (this.#sheds.get(reason) ?? 0) + 1);
  }

  snapshot(): {
    workBytesInFlight: number;
    maxWorkBytes: number;
    maxLaneWorkBytes: number;
    effectiveBudgetBytes: number;
    inflightRequests: number;
    waiting: number;
    peakWorkBytes: number;
    amplification: number;
    lanes: Array<{ lane: string; bytes: number }>;
    shedsByReason: Record<string, number>;
  } {
    return {
      workBytesInFlight: this.#inflightBytes,
      maxWorkBytes: this.#maxWorkBytes,
      maxLaneWorkBytes: this.#maxLaneWorkBytes,
      effectiveBudgetBytes: this.effectiveBudgetBytes(),
      inflightRequests: this.#inflightRequests,
      waiting: this.#waiters.length,
      peakWorkBytes: this.#peakInflightBytes,
      amplification: this.#amplification,
      lanes: Array.from(this.#laneBytes, ([lane, bytes]) => ({ lane, bytes })),
      shedsByReason: Object.fromEntries(this.#sheds),
    };
  }

  #reserve(bytes: number, lane: string): ChatWorkLease {
    this.#inflightBytes += bytes;
    this.#inflightRequests += 1;
    this.#laneBytes.set(lane, this.laneBytes(lane) + bytes);
    if (this.#inflightBytes > this.#peakInflightBytes) this.#peakInflightBytes = this.#inflightBytes;
    let released = false;
    return {
      bytes,
      lane,
      get released() {
        return released;
      },
      release: () => {
        if (released) return;
        released = true;
        this.#inflightBytes = Math.max(0, this.#inflightBytes - bytes);
        this.#inflightRequests = Math.max(0, this.#inflightRequests - 1);
        const remaining = this.laneBytes(lane) - bytes;
        if (remaining > 0) this.#laneBytes.set(lane, remaining);
        else this.#laneBytes.delete(lane);
        this.#drainWaiters();
      },
    };
  }

  #drainWaiters(): void {
    if (this.#waiters.length === 0) return;
    const effective = this.effectiveBudgetBytes();
    for (const waiter of this.#waiters) {
      if (waiter.settled) continue;
      if (!this.canFit(waiter.bytes, waiter.lane, effective)) continue;
      const lease = this.#reserve(waiter.bytes, waiter.lane);
      waiter.settled = true;
      this.#waiters = this.#waiters.filter((candidate) => candidate !== waiter);
      waiter.resolve(lease);
      return; // one wakeup per release keeps the accounting monotone
    }
  }
}

export function defaultPressureSeverity(): PressureSeverity {
  try {
    return getResourcePressureObservation().state.severity;
  } catch {
    return "normal";
  }
}

const productionWorkBudget = resolveWorkByteBudget();

export const chatWorkBudget = new ChatWorkBudget({
  maxWorkBytes: productionWorkBudget.bytes,
  maxLaneWorkBytes: process.env.OMNIROUTE_CHAT_MAX_WORK_BYTES_PER_LANE
    ? parsePositiveNumber(
        process.env.OMNIROUTE_CHAT_MAX_WORK_BYTES_PER_LANE,
        productionWorkBudget.bytes * DEFAULT_LANE_SHARE
      )
    : undefined,
});

export type ChatWorkAdmission =
  | { admit: true; lease: ChatWorkLease }
  | { admit: false; response: Response };

/**
 * Price + reserve the working set for one large-context chat request.
 * Small requests always pass (no reservation, no pricing) — a blanket refusal is exactly the
 * failure mode this is meant to avoid.
 */
export async function admitChatWork(input: {
  lane: string;
  bodyBytes?: number | null;
  estimatedTokens?: number | null;
  waitMs?: number;
  signal?: AbortSignal;
  budget?: ChatWorkBudget;
}): Promise<ChatWorkAdmission> {
  const budget = input.budget ?? chatWorkBudget;
  if (!budget.isLargeContext(input.bodyBytes, input.estimatedTokens)) {
    return { admit: true, lease: nullChatWorkLease() };
  }
  const bytes = budget.priceWork({ bodyBytes: input.bodyBytes, estimatedTokens: input.estimatedTokens });
  if (bytes <= 0) return { admit: true, lease: nullChatWorkLease() };

  const effective = budget.effectiveBudgetBytes();
  const waitMs = input.waitMs ?? CHAT_WORK_QUEUE_MAX_MS;
  const lease = await budget.acquireWithin(bytes, input.lane, waitMs, input.signal);
  if (lease) return { admit: true, lease };

  const reason: ChatWorkShedReason = budget.canFit(bytes, input.lane)
    ? "queue_timeout"
    : budget.refusalReason(bytes, input.lane, effective);
  budget.recordShed(reason);
  const retryAfterSeconds = budget.retryAfterSeconds(effective);
  workLog.warn(
    {
      reason,
      lane: input.lane,
      requestWorkBytes: bytes,
      workBytesInFlight: budget.inflightBytes,
      effectiveBudgetBytes: effective,
      maxWorkBytes: budget.maxWorkBytes,
      maxLaneWorkBytes: budget.maxLaneWorkBytes,
      laneWorkBytes: budget.laneBytes(input.lane),
      inflightRequests: budget.inflightRequests,
      amplification: budget.amplification,
      bodyBytes: input.bodyBytes ?? null,
      estimatedTokens: input.estimatedTokens ?? null,
      retryAfterSeconds,
    },
    "large-context working-set budget exhausted (chat_work_budget)"
  );
  return {
    admit: false,
    response: workBudgetRejectionResponse({
      workBytesInFlight: budget.inflightBytes,
      effectiveBudgetBytes: effective,
      maxLaneWorkBytes: budget.maxLaneWorkBytes,
      retryAfterSeconds,
      reason,
    }),
  };
}

/**
 * Compose the working-set lease with whatever lease the caller already holds (the byte-stage
 * admission lease has the same `{released, release}` shape but no size fields), so a single
 * `release()` (bound to the SSE stream lifetime) frees both.
 */
export function composeChatWorkLease(
  ...leases: Array<ReleasableLease | null | undefined>
): ReleasableLease | null {
  const active = leases.filter((lease): lease is ReleasableLease => Boolean(lease));
  if (active.length === 0) return null;
  if (active.length === 1) return active[0];
  let released = false;
  return {
    get released() {
      return released;
    },
    release: () => {
      if (released) return;
      released = true;
      for (const lease of active) lease.release();
    },
  };
}