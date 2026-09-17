---
title: "Admission lanes — two lane systems, what gates each, where each reports"
status: active
lastUpdated: 2026-08-10
---

# Admission lanes (#9654) — two lane systems, what gates each, where each reports

OmniRoute has **two** process-local lane systems with different scopes. They are
complementary; operators should know which one they are looking at.

## 1. Byte-level process-wide admission (`chatBodyAdmission.ts`)

- **Scope:** the buffered-body/heap path for `POST /v1/chat/completions`,
  `/v1/messages`, `/v1/responses`, and the other chat-shaped routes. Guards
  against heap amplification from large coding-agent bodies (#4380).
- **One process-global controller, not per-key lanes (#10110).** Every API key
  (hashed) or `anonymous` session admits against the **same** shared budget —
  the hashed session id is used ONLY as a fairness scheduling key (round-robin
  dispatch across waiters), never as a capacity shard. A prior version of this
  doc described per-key lanes with independent capacity; that model was
  removed in #10110 because it let unauthenticated fake credentials multiply
  the process-wide bound.
- **Gate (#503-fanout): an auto-derived ingest BYTE budget, not a fixed request
  count.** The legacy `CHAT_MAX_HEAVY_IN_FLIGHT` request-count cap (default `1`
  before this fix) collapsed coding-agent fan-out (multiple subagents/CLIs,
  bodies routinely > 256 KB) to an effective concurrency of ~1, which 503'd
  under completely normal load. It now binds only when an operator explicitly
  sets `OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT`. Left unset, admission is instead
  gated by `OMNIROUTE_CHAT_MAX_INFLIGHT_BYTES` — a budget auto-derived from the
  process's real memory ceiling (`src/shared/middleware/admissionBudget.ts`):
  25% of the tighter of the V8 heap limit and any cgroup/container limit,
  divided by an 8x transient-amplification factor, clamped between 8 MiB and
  2 GiB. Explicit overrides use the same clamps. This scales itself from a
  512 MB container to a 32 GB desktop with no env tuning. A body that cannot
  fit within the effective budget fails immediately with `413 body_exceeds_budget`;
  only contention among individually serviceable bodies enters the bounded
  fairness queue. A live multi-signal resource-pressure tracker (V8 heap ratio,
  cgroup, PSI, OOM events — `open-sse/utils/resourcePressurePolicy.ts`) shortens
  the bounded wait under `high` pressure and sheds immediately with
  `503 resource_pressure` under `critical` pressure, before any bytes are even
  ingested.
- **Under `critical` pressure only HEAVY requests are shed.** The gate used to
  refuse every chat request, including a health ping, which burned agent
  workers' retry budgets on 5xx while the cgroup ceiling still had headroom
  above the V8 line that tripped the guard. "Heavy" is now one shared
  definition (`src/shared/middleware/chatPressureWeight.ts`): a request whose
  declared/serialized size, message count, tool count, or conservative
  structure-token estimate reaches its bound. A request with no established
  weight — notably an undeclared/chunked body — counts as heavy, because it
  cannot be proven small. The same classifier bounds **every** pressure gate on
  the chat path, so a light request admitted at one is not 503'd by the next:
  the adaptive-admission runtime's own fuse
  (`AdaptiveAdmissionRuntimeImpl.acquire`, which runs FIRST, before the handler
  is even entered) and the post-parse provider-work guards (`chatCore`,
  `executeChatWithBreaker`).
- **A light request still runs the full pressure `check()`.** The weight is
  passed INTO `checkResourcePressureGuard`, which drops the verdict at its
  return sites — no gate may short-circuit before calling it. `check()` is the
  only pump of the pressure sampler (`scheduleRefresh()` lives inside it; there
  is no timer), so a gate that returned early for light requests would freeze
  the observation at `critical` during light-only traffic and shed heavy
  requests forever with no path back to `normal`. Passing the weight down also
  keeps the `[resourcePressure] … returning 503` warn line off requests that
  were in fact admitted.
- **`Retry-After` is derived, not constant.** A pressure 503 reports how long
  the episode has actually lasted since the state transition
  (`resourcePressureRetryAfterSeconds`, floored at 5s and capped at 120s), so a
  client that honours it does not hot-loop against a multi-minute episode.
- **Tuning:**
  - `OMNIROUTE_CHAT_MAX_INFLIGHT_BYTES` — override for the auto-derived byte budget
  - `OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT` — legacy request-count cap, opt-in only
  - `OMNIROUTE_CHAT_ADMISSION_QUEUE_MS` — queue-wait before 503 (default 2000)
  - `OMNIROUTE_CHAT_ADMISSION_MAX_QUEUED_BYTES` — queued-bytes heap valve (default 4 MB)
  - `OMNIROUTE_CHAT_VIRTUAL_TTL_MS` / `OMNIROUTE_CHAT_VIRTUAL_MAX_SESSIONS` — deprecated
    no-ops since #10110 (accepted for config compatibility, ignored)
- **Reports:** `GET /api/monitoring/health` → `chatAdmission` (#11244) — including
  the #503-fanout additions `inflightBytes`, `maxInflightBytes`, `budgetSource`
  (`v8_heap` | `cgroup` | `override`), `pressureSeverity`, and `countCapEnabled`
  (false on a default deployment — confirms the byte budget, not the legacy
  count cap, is what is actually binding).

## 2. Adaptive runtime virtual lanes (`open-sse/services/admission`)

- **Scope:** tenant-key admission for provider dispatch — queue cost, latency-guided
  limit adaptation, lane queueing, and lane metrics.
- **Gate:** **opt-in.** Disabled unless `OMNIROUTE_CHAT_VIRTUAL_LANES=true`. Without it,
  the adaptive controller keeps the shared queue behavior (criterion 1 of #9654 only
  holds once an operator enables lanes).
- **Tuning:** `OMNIROUTE_CHAT_VIRTUAL_LANES` + adaptive config (`maxQueueCount`,
  `maxQueueCost`, `defaultMaxWaitMs`, …).
- **Reports:** `GET /api/monitoring/health` → `adaptiveAdmission` → `laneCount`,
  `laneQueuedCount`, `laneQueuedCost`, `laneTenants` (opaque lane IDs, never raw
  keys), and `virtualLanes` — the authoritative "lanes are on" flag in the snapshot.

## 3. Fan-out probes — per-target admission for combo/fusion (#9654 Wave 2)

Combo (priority / round-robin) and fusion fan out N model targets under one parent
request. Since #9654 Wave 2, **each fan-out target is gated before dispatch** by a
per-target probe (`PerTargetAdmissionHook`, built by `createPerTargetAdmissionHook`)
against the **parent's** tenant lane.

- **Scope:** every fan-out target dispatched by combo, fusion, and the chaos engine.
  System 1 (byte-level) is unaffected — it never probes fan-out targets.
- **Gate:** **opt-in with system 2.** A no-op when `OMNIROUTE_CHAT_VIRTUAL_LANES`
  is unset — the parent request already holds the shared-queue lease in that mode,
  so probing would double-count and reject combo targets.
- **Semantics:**
  - **Strictly non-blocking — skip, never queue.** `maxWaitMs 0`: a full lane
    skips the target and the combo's fallback machinery (or fusion's survivor
    panel) serves instead. This is deliberate: a fan-out target is redundant
    work, and queueing it piles more load onto the exact congestion lanes exist
    to stop. `defaultMaxWaitMs` therefore applies to the **parent request only**;
    fan-out probes never wait, and there is intentionally **no knob** to make
    them wait (issue history shows wait knobs produced the mass-502/504 class
    #9654 prevents — revisit only if an operator reports skipped fan-out targets
    hurting response quality).
  - **Release-on-admit.** An admitted probe releases its lease immediately: it is
    a capacity gate, not a hold. The parent's lease covers the fan-out; holding N
    more would inflate shared active cost and reject other tenants. Best-effort,
    not a reservation: the lane can refill between probe and dispatch, so under
    heavy contention the gate may admit into a lane that is full again by the
    time the target dispatches.
  - **Priced from the real fan-out body.** The probe estimates cost from the
    target's actual body — including the request class derived from its `stream`
    flag, exactly like the parent path — so fusion panel members (`stream: false`)
    are priced at the non-streaming class they will truly occupy, and priority/RR
    targets at whatever the user requested.
- **Reports:** a probe skip after the first target bumps combo's per-request
  `fallbackCount` (mirroring the existing fallback semantics; visible in combo
  logs); fusion returns 503 when every panel member is skipped. There is
  **no aggregate counter** (e.g. `virtualFanoutSkipped`) on the snapshot today —
  if an operator reports they cannot tell how often the lane gate skips fan-out
  targets, that is the trigger to add one.

## Which one is showing in a dashboard

- `adaptiveAdmission.laneCount` / `laneTenants` → **adaptive virtual lanes** (system 2).
- `adaptiveAdmission.virtualLanes === true` → the fan-out probes of section 3 are
  also active. A payload with `virtualLanes` missing or `false` means
  `OMNIROUTE_CHAT_VIRTUAL_LANES` is unset — the byte-level lanes (system 1) are
  still active, but nothing under `adaptiveAdmission` (and no fan-out gating) is
  in effect until it is enabled.

## Why both exist

The byte-level lanes bound the memory-heavy parse/compress path; the adaptive lanes
bound dispatch cost per tenant. #9654's criterion 1 ("one session's burst does not 503
another") is enforced by system 1 unconditionally and by system 2 once opt-in is enabled.

## 4. One-process long `/v1/responses` (healthy-headroom)

[#10437](https://github.com/diegosouzapw/OmniRoute/pull/10437) added
`tryAcquireHealthyHeadroom` so a second structurally-heavy request is admitted
when the heap is below `OMNIROUTE_CHAT_ADMISSION_HEAP_SHED_RATIO`. The BYTE
path used by `admitChatRequest` (bodies ≥ `OMNIROUTE_CHAT_LARGE_BODY_BYTES`,
default 256 KiB, including `POST /v1/responses`) uses the **same** escape.

This is the supported **one-process** recipe for more than two concurrent long
SSE `/v1/responses`: raise primary + healthy-headroom only as far as the heap
and the process-wide inflight-byte budget (`OMNIROUTE_CHAT_MAX_INFLIGHT_BYTES`
/ #10110) allow. Tens of long SSE clients (40–50) is that memory-budget
question, not a hard “max 2” product limit. A pressured heap still sheds with
retryable `503` so #7849 does not return.

To **multiply heaps**, run N independent `DATA_DIR`s (#11024). Never
`replicas > 1` on one SQLite file (#10350). This section is not a reopen of
the DATA_DIR scale-out recipe.

## 5. Working-set ceiling sizing, from heap evidence

This section records the **measured** basis for the working-set knobs
(`OMNIROUTE_CHAT_WORK_AMPLIFICATION`, `OMNIROUTE_CHAT_MAX_WORK_BYTES`) and for
`--max-old-space-size`, and the two ceiling semantics that must not be confused
with each other (the in-app heap gate of section 1 vs. the m1max watchdog's
RSS rung).

### 5.1 What actually binds — measured 2026-09-17, rev `f69ca7819`

Measurement window: 48 samples @30 s on the serving gateway (`omniroute`,
image `omniroute:stream-readiness-cause-f69ca7819`, `--memory 14g`,
`--max-old-space-size=8192` ⇒ `heap_size_limit` 8,384 MB), read through the
app's own state route (no inspector, no forced GC, no restart of our own).

- **The byte path is not the binding limit at live load.** Over 26 h of real
  traffic (15,238 calls) max concurrency was **27**, max concurrent
  `tokens_in >= 100k` requests **13**, and peak concurrent prompt text
  **7.0 MB**. At the measured **5.20–5.25x wire** amplification
  (`npm run bench:heap-body`: entry clone 1.05x + token-estimate stringify
  1.00x + per-target attempt bodies 3.12x), peak in-flight work is
  ~**37 MB** — under 1% of the 7,126 MB heap gate. A work-bytes gate cannot
  bind there; it stays a *concurrency safety net* only.
- **RSS must never size a per-request ceiling.** `RSS - heapUsed` is a fixed
  **3.5–3.6 GB** on this host (mean 3,570 MB, range 598 MB at boot to
  4,001 MB), because of a single ~2.6–3.1 GB fully-dirty anonymous mapping
  (V8 pointer-cage address class) plus glibc arenas — present while the heap is
  nearly idle. Any "RSS / concurrent requests" figure (e.g. 5.5 GB / 27 ≈
  204 MB per request) is measuring that constant, not request cost.
- **What binds is a load-independent, time-proportional accumulation.**
  Measured rate once warm: **+572 MB over 444 s = 77 MB/min** of true
  `heapUsed` (RSS +65 MB/min) at 37–73 calls/min with only 0–5 MB in flight;
  **~2.0–3.1 MB retained per call**. The same gateway's canary, under sustained
  synthetic load with identical 1.45 MB bodies, retains ~0.03 MB/call. A forced
  GC on the live heap reclaimed 6.5% (91–95% live), so this is retention, not
  lazy collection.
- **The effective ceiling today is the watchdog, not the app's shed trip.**
  `heapPressure.ts` trips at `SHED_RATIO 0.85 x heap_size_limit` = **7,126 MB**,
  but `~/bin/omniroute-watchdog.sh` restarts the container when
  `VmRSS - 3000 >= 6800 MB` for 120 s, which on this host is
  **heapUsed ≈ 6.25 GB**. Observed: at `heapUsed` 6,490 MB / RSS 10,029 MB
  (`VmRSS-3000 = 7,029`) the watchdog restarted the gateway — while
  **`shed_total = 0`, `pressure_guard_rejects = 0`, `severity = normal` in all
  48 samples**. Max observed heap was **91.1% of the shed trip**: the app's own
  shed path is unreachable at the current thresholds, and the ~900 MB between
  the two limits is dead headroom.

**Chosen values** (recorded here; applied to the recreate spec, inert until the
work-budget code is in the image):

| knob | value | basis |
| --- | --- | --- |
| `OMNIROUTE_CHAT_WORK_AMPLIFICATION` | `5.25` | measured upper bound, `bench:heap-body` |
| `OMNIROUTE_CHAT_MAX_WORK_BYTES` | `536870912` (512 MiB) | ≥10x the measured live peak (5.25 x 7.0 MB ≈ 37 MB) so it never sheds real traffic; caps catastrophe at 512 MiB / (5.25 x 1.45 MB) ≈ 67 concurrent full-size bodies = 2.5x the observed max concurrency (27) |
| `--max-old-space-size` (recommendation) | `6144` | yields `heap_size_limit` ≈ 6,336 MB ⇒ in-app trip **5,386 MB**, ~840 MB below the watchdog's ~6.25 GB rung, so the app degrades with a retryable 503 *before* the watchdog kills it |

The last row is a **capacity decision for the operator, not applied by this
change**: `NODE_OPTIONS` only takes effect at container create, and lowering the
heap limit trades shed-frequency for restart-frequency. Raising the watchdog's
`HEAP_RESTART_MB` instead has the same effect without touching the app.

**Growth curve by band** (deliverable shape; band = `activeHeavy` at sample
time, `calls/min` from the app's own 30 s call window):

- `c0` (idle): negative (~-650 MB/min in the 2 idle intervals) — the heap does
  release when nothing is running.
- `c1–c2` (≤2 large in flight): **+105 MB/min** at 37 calls/min.
- `c3+` (3 large in flight): **+266 to +896 MB/min** at 74 calls/min.
- Cold boot: 479 MB @22 s → 962 MB @189 s; RSS reaches its ~4.4–4.7 GB plateau
  only after ~4 min (the cage mapping is populated lazily), so **boot-ramp
  samples must be excluded** from any rate fit.

**Confound, stated explicitly:** on this gateway call rate and concurrency
co-vary (the load is agent traffic, which arrives in bursts), so the c-band
spread above is **call-rate, not concurrency**. The defensible summary is:
heap grows **+40–80 MB/min** at 20–75 calls/min once warm, i.e. **~2–3 MB per
call, independent of how many are concurrent**.

### 5.2 Do not census the serving process (`queryObjects` kills it)

Two independent reproductions on 2026-09-17 show that a `Runtime.queryObjects`
census with property reads **terminates the gateway**:

- `09:02:05.788Z` on the serving container (exit code 7, no OOM, no watchdog
  involvement) and `09:59:06Z` on an idle canary (same exit code) — identical
  stack:

```
TypeError: Value of "this" must be of type ReadableStreamBYOBReader
    at get closed (node:internal/webstreams/readablestream:1126:28)
    at shallow (<anonymous>:23:68)
    at Array.<anonymous> (<anonymous>:44:15)
    at Object.all (/app/.build/next/server/chunks/src_0_qfvn_._.js:1:3554)
  code: 'ERR_INVALID_THIS'
```

`<anonymous>` frames are the injected aggregator; line 23 col 68 is its
`o[ks[i]]` property read, and the app's stream-close path is what it trips.
**Rule:** attribution work against the live process must use only
V8-internal instruments (`HeapProfiler.startSampling`,
`getHeapSpaceStatistics`, `process.memoryUsage`) — never an object census, and
never a forced GC on a container serving traffic. That is also why the
shed-time snapshot rig (`omniheap-capture.sh`) is left **unloaded**: a
stop-the-world snapshot on this process is the same hazard class, and the
in-app shed trip it was supposed to observe is unreachable anyway (5.1).
