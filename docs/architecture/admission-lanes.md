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

## 5. Working-set budget for large-context requests (`chatWorkBudget.ts`)

Sections 1 and 4 bound ONE request: its bytes, its structural estimate, and how
many heavyweight requests may be in flight. Neither bounds the SUM of in-flight
large-context working sets, and every shed decision above is taken from a
heap-used threshold (`heapUsed / heap_size_limit`). Both are the wrong
instrument for the failure this deployment actually sees: a few concurrent
agent requests with ~200k-token histories (1–6 MB bodies) that each retain tens
of MB across parsing, compression, transcript construction and provider
dispatch. The heap therefore climbs across many requests and only crosses the
shed ratio once the memory is already committed — at which point the guard sheds
a request that did not cause the growth, while the process keeps climbing
between shed decisions.

The working-set budget adds the missing metric:

- **What it bounds** — reserved bytes, not request counts. A large-context
  request reserves `declared body bytes × OMNIROUTE_CHAT_WORK_AMPLIFICATION`
  (or the structural token estimate when `Content-Length` is unusable), and the
  lease is held for the whole response lifetime, SSE streams included — the
  window in which the working set is actually retained.
- **Who is priced** — only requests at or above
  `OMNIROUTE_CHAT_LARGE_BODY_BYTES` or
  `OMNIROUTE_CHAT_HEAVY_ESTIMATED_TOKENS`. Small requests take no lease: they
  cannot be shed by this budget and their latency is unchanged.
- **Where the ceiling comes from** — half of the process memory ceiling (V8 heap
  limit, or the tighter cgroup limit), clamped to 64 MiB–4 GiB; under heap
  pressure the effective ceiling is halved instead of waiting for the 0.75 shed
  ratio to trip.
- **Fairness** — a per-lane share
  (`OMNIROUTE_CHAT_MAX_WORK_BYTES_PER_LANE`, default half the process budget)
  so one agent session cannot occupy the whole budget and starve another.
- **Shedding** — excess large-context requests park for a bounded wait and are
  woken as soon as a lease is released (stream completion); past the window they
  receive a retryable `503` + `Retry-After` with
  `error.code=chat_work_budget` (`work_budget`, `lane_work_budget`,
  `queue_timeout`), so a capacity shed is distinguishable from a policy
  rejection in `call_logs`.

Composition, not a second gate: `withChatAdmission` runs the shipped
`admitChatRequest` (sections 1 and 4) first and the working-set budget second,
and `composeChatWorkLease` merges both leases so a single release bound to the
response lifecycle frees the byte lease and the working-set reservation
together. `POST /v1/chat/completions` and `POST /v1/responses` both use it.

### 5.1 What it binds, measured (2026-09-17)

The amplification constant is not a guess. `npm run bench:heap-body`
(`scripts/perf/request-body-heap.ts`, `--expose-gc`, real production helpers,
DATA_DIR redirected to a temp dir) reports retained bytes per mechanism:

| shape | wire | entry log clone | bounded log clone | combo attempt bodies x3 | token-estimate stringify | per request |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 480 msgs / 36 tools | 1.33 MB | 1.43 MB (1.05x) | 0.08 MB | 4.30 MB (3.15x) | 1.37 MB (1.00x) | 7.18 MB (**5.25x**) |
| 729 msgs / 86 tools (#7847) | 3.06 MB | 3.33 MB (1.04x) | 0.14 MB | 9.99 MB (3.12x) | 3.21 MB (1.00x) | 16.67 MB (**5.20x**) |

So `OMNIROUTE_CHAT_WORK_AMPLIFICATION=8` prices the request-body copies with
headroom. Two honest limitations, because they decide whether a green run means
anything:

1. **It prices body copies, not the whole per-request heap.** Translated
   payloads, compression copies, upstream/SSE buffers and per-hop retries are not
   in the number. The live heap has held ~1.0 GB in V8 large-object space
   (objects > 128 KB — big strings/buffers) out of 3.4 GB `heapUsed`, which is
   the shape those copies produce, but no measurement yet attributes the rest.
2. **At the concurrency this deployment actually runs, this ceiling does not
   bind.** Measured from `call_logs` overlap over 26 h (15,238 calls, duration =
   stream lifetime): max 27 concurrent requests overall, **max 13 concurrent
   requests with `tokens_in >= 100k`**, and the peak sum of concurrent prompt
   text was **7.0 MB**. At 1.3-2 MB bodies x 8, that is ~200 MB against a
   4,192 MB ceiling — ~5% occupied, i.e. the gate stays silent. Doing the
   arithmetic the other way: to trip a 4,192 MB budget with 1.3 MB bodies, ~400
   large-context requests must be in flight simultaneously.

Practical consequence: this budget is the missing *quantity* and the right
backstop for pathological fan-out, but it is **not** the lever that fixes a 7 GB
heap high-water at ~13 concurrent requests. That gap is the open question, and it
is a heap-*retainer* question: ~13 concurrent requests cannot explain 3.4 GB of
live heap, so the resident set is accumulating somewhere that is not proportional
to in-flight bodies. Answering it needs `HeapProfiler`/snapshot data taken from a
process with the inspector enabled — the live container has **no** inspector
(`/proc/net/tcp` has no 9229 listener, `NODE_OPTIONS` carries no `--inspect`), so
`gc-probe.mjs` / `heap-sample.mjs` / `obj-census.mjs` cannot run there until it is
re-enabled. Before sizing the ceiling down to something that binds, measure
`heapUsed` at a shed and price from that; do not tune it from the body-copy
number alone.
