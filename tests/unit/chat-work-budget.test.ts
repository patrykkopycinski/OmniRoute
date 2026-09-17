// Large-context WORKING-SET budget (src/shared/middleware/chatWorkBudget.ts).
//
// What these tests pin:
//  (a) the budget is DERIVED from the process memory ceiling (override wins, clamps hold) —
//      a fixed MB constant is the mistake the ingest-budget module already documents;
//  (b) pricing is honest: bytes when declared, structural tokens when not, ZERO (never charged)
//      when the size is unknown;
//  (c) small requests are never priced or reserved — the blanket-refusal failure mode stays fixed;
//  (d) the reservation is held per lane + process-wide, released on completion, woken FIFO, and
//      its shed reports real occupancy numbers plus an occupancy-derived Retry-After;
//  (e) pressure lowers the effective ceiling, so the absolute heap guard is reached strictly later;
//  (f) the route wiring actually reserves a large-context request and refuses the next one with
//      503 chat_work_budget while small requests keep being served.
import { test } from "node:test";
import assert from "node:assert/strict";

import { ChatAdmissionController } from "../../src/shared/middleware/chatBodyAdmission";
import {
  admitChatWork,
  ChatWorkBudget,
  composeChatWorkLease,
  computeWorkByteBudget,
  declaredBodyBytes,
  MAX_WORK_BUDGET_BYTES,
  MIN_WORK_BUDGET_BYTES,
  parseDeclaredBodyBytes,
  WORK_HEAP_FRACTION,
} from "../../src/shared/middleware/chatWorkBudget";
import { withChatAdmission } from "../../src/shared/middleware/withChatAdmission";

const MB = 1024 * 1024;

function budgetFor(options: Partial<ConstructorParameters<typeof ChatWorkBudget>[0]> = {}) {
  return new ChatWorkBudget({
    maxWorkBytes: 8 * MB,
    maxLaneWorkBytes: 8 * MB,
    amplification: 1,
    largeBodyBytes: 1024,
    heavyEstimatedTokens: 1000,
    checkPressureSeverity: () => "normal",
    ...options,
  });
}

test("computeWorkByteBudget derives from the ceiling, honours overrides and clamps", () => {
  const heap = computeWorkByteBudget({ heapSizeLimitBytes: 8192 * MB });
  assert.equal(heap.source, "v8_heap");
  assert.equal(heap.bytes, Math.floor(8192 * MB * WORK_HEAP_FRACTION));

  // The tighter container ceiling wins over the V8 heap limit.
  const cgroup = computeWorkByteBudget({ heapSizeLimitBytes: 8192 * MB, constrainedMemoryBytes: 2048 * MB });
  assert.equal(cgroup.source, "cgroup");
  assert.equal(cgroup.bytes, 1024 * MB);

  // An explicit override wins over both, and is clamped into the documented range.
  const override = computeWorkByteBudget({ heapSizeLimitBytes: 8192 * MB, override: "512" });
  assert.equal(override.source, "override");
  assert.equal(override.bytes, MIN_WORK_BUDGET_BYTES);
  const huge = computeWorkByteBudget({ heapSizeLimitBytes: 8192 * MB, override: String(99 * 1024 * MB) });
  assert.equal(huge.bytes, MAX_WORK_BUDGET_BYTES);

  // A tiny host still gets a usable floor rather than a zero budget.
  const tiny = computeWorkByteBudget({ heapSizeLimitBytes: 32 * MB });
  assert.equal(tiny.bytes, MIN_WORK_BUDGET_BYTES);
});

test("pricing: declared bytes, structural tokens, and never an invented number", () => {
  const budget = budgetFor({ amplification: 4 });
  assert.equal(budget.priceWork({ bodyBytes: 1000 }), 4000);
  // 4 bytes/token is the ratio the structural estimator itself assumes.
  assert.equal(budget.priceWork({ estimatedTokens: 500 }), 8000);
  // Unknown size is NOT priced — no guessed multiple enters the accounting.
  assert.equal(budget.priceWork({}), 0);
  assert.equal(budget.priceWork({ bodyBytes: null, estimatedTokens: null }), 0);
  // Bytes win over tokens when both are known (they describe the same request).
  assert.equal(budget.priceWork({ bodyBytes: 1000, estimatedTokens: 500 }), 4000);
});

test("only large-context requests are priced; small ones always pass", async () => {
  const budget = budgetFor({ largeBodyBytes: 4096, heavyEstimatedTokens: 2000 });
  assert.equal(budget.isLargeContext(1024, null), false);
  assert.equal(budget.isLargeContext(4096, null), true);
  assert.equal(budget.isLargeContext(null, 2000), true);
  assert.equal(budget.isLargeContext(null, null), false);

  // A budget with no free capacity at all still admits a small request: no reservation, no 503.
  const full = budgetFor({ maxWorkBytes: 1024, maxLaneWorkBytes: 1024, largeBodyBytes: 4096 });
  const held = full.tryAcquire(1024, "lane-a");
  assert.ok(held);
  const small = await admitChatWork({ lane: "lane-b", bodyBytes: 512, budget: full, waitMs: 0 });
  assert.equal(small.admit, true);
  held!.release();
});

test("reservation accounting: process-wide, per lane, released on completion", () => {
  const budget = budgetFor({ maxWorkBytes: 3000, maxLaneWorkBytes: 2000 });
  const first = budget.tryAcquire(1500, "lane-a");
  assert.ok(first);
  assert.equal(budget.inflightBytes, 1500);
  assert.equal(budget.inflightRequests, 1);
  assert.equal(budget.laneBytes("lane-a"), 1500);

  // The process budget still has room, but lane-a is over its own share -> refused.
  assert.equal(budget.tryAcquire(1000, "lane-a"), null);
  // A different lane may use the remaining process-wide room.
  const other = budget.tryAcquire(1000, "lane-b");
  assert.ok(other);
  assert.equal(budget.inflightBytes, 2500);
  // Now the process-wide budget is the binding constraint.
  assert.equal(budget.tryAcquire(1000, "lane-c"), null);
  assert.equal(budget.refusalReason(1000, "lane-c"), "work_budget");
  assert.equal(budget.refusalReason(1000, "lane-a"), "lane_work_budget");

  first!.release();
  first!.release(); // idempotent
  assert.equal(budget.inflightBytes, 1000);
  assert.equal(budget.laneBytes("lane-a"), 0);
  other!.release();
  assert.equal(budget.inflightBytes, 0);
  assert.equal(budget.inflightRequests, 0);
  assert.equal(budget.peakInflightBytes, 2500);
});

test("bounded wait: wakes on release, honours timeout and abort", async () => {
  const budget = budgetFor({ maxWorkBytes: 1000, maxLaneWorkBytes: 1000 });
  const held = budget.tryAcquire(1000, "lane-a");
  assert.ok(held);

  const waited = budget.acquireWithin(1000, "lane-b", 2000);
  assert.equal(budget.waitingCount, 1);
  held!.release();
  const acquired = await waited;
  assert.ok(acquired, "a released slot wakes the parked waiter");
  assert.equal(budget.inflightBytes, 1000);
  acquired!.release();

  const held2 = budget.tryAcquire(1000, "lane-a");
  assert.ok(held2);
  assert.equal(await budget.acquireWithin(1000, "lane-b", 30), null, "timeout sheds instead of waiting forever");
  assert.equal(budget.waitingCount, 0);

  const controller = new AbortController();
  const aborted = budget.acquireWithin(1000, "lane-c", 5000, controller.signal);
  controller.abort();
  assert.equal(await aborted, null, "a client abort drops the waiter");
  assert.equal(budget.waitingCount, 0);
  held2!.release();
});

test("shed verdict reports real occupancy and an occupancy-derived Retry-After", async () => {
  const budget = budgetFor({ maxWorkBytes: 4000, maxLaneWorkBytes: 4000, largeBodyBytes: 1024 });
  const held = budget.tryAcquire(4000, "lane-a");
  assert.ok(held);

  const shed = await admitChatWork({
    lane: "lane-b",
    bodyBytes: 2000,
    budget,
    waitMs: 0,
  });
  assert.equal(shed.admit, false);
  if (shed.admit !== false) return;
  assert.equal(shed.response.status, 503);
  assert.equal(shed.response.headers.get("retry-after"), String(budget.retryAfterSeconds()));
  const body = JSON.parse(await shed.response.text());
  assert.equal(body.error.code, "chat_work_budget");
  assert.equal(body.error.reason, "work_budget");
  // The message carries the real numbers, not a severity.
  assert.match(body.error.message, /MB in flight of/);
  assert.deepEqual(budget.snapshot().shedsByReason, { work_budget: 1 });
  held!.release();
});

test("pressure lowers the effective ceiling", async () => {
  let severity: "normal" | "high" | "critical" = "normal";
  const budget = budgetFor({
    maxWorkBytes: 4000,
    maxLaneWorkBytes: 4000,
    largeBodyBytes: 1,
    checkPressureSeverity: () => severity,
  });
  assert.equal(budget.effectiveBudgetBytes(), 4000);
  severity = "high";
  assert.equal(budget.effectiveBudgetBytes(), 3000);
  severity = "critical";
  assert.equal(budget.effectiveBudgetBytes(), 2000);

  // A request that fits comfortably at normal pressure is refused once the tracker is critical.
  const fitsNormally = await admitChatWork({ lane: "lane-a", bodyBytes: 3000, budget, waitMs: 0 });
  assert.equal(fitsNormally.admit, false, "critical pressure halves the ceiling");
  severity = "normal";
  const thenFits = await admitChatWork({ lane: "lane-a", bodyBytes: 3000, budget, waitMs: 0 });
  assert.equal(thenFits.admit, true);
  if (thenFits.admit) thenFits.lease.release();
});

test("composeChatWorkLease releases every composing lease exactly once", () => {
  const budget = budgetFor();
  const first = budget.tryAcquire(1000, "lane-a");
  const second = budget.tryAcquire(2000, "lane-a");
  assert.ok(first && second);
  const composed = composeChatWorkLease(first, second, null);
  assert.ok(composed);
  assert.equal(budget.inflightBytes, 3000);
  composed!.release();
  composed!.release();
  assert.equal(budget.inflightBytes, 0);

  // A single lease is passed through unchanged so its size metadata survives.
  const single = composeChatWorkLease(first);
  assert.equal(single, first);
});

test("declaredBodyBytes only trusts a well-formed header", () => {
  assert.equal(parseDeclaredBodyBytes("1024"), 1024);
  assert.equal(parseDeclaredBodyBytes("0"), 0);
  assert.equal(parseDeclaredBodyBytes(null), null);
  assert.equal(parseDeclaredBodyBytes(""), null);
  assert.equal(parseDeclaredBodyBytes("12KB"), null);
  assert.equal(parseDeclaredBodyBytes("-5"), null);
  assert.equal(declaredBodyBytes(new Headers({ "content-length": "2048" })), 2048);
  assert.equal(declaredBodyBytes(new Headers()), null);
});

function largeRequest(fillBytes: number, lane = "lane-a") {
  const body = JSON.stringify({
    model: "test-model",
    messages: [{ role: "user", content: "x".repeat(fillBytes) }],
  });
  return new Request("http://127.0.0.1:20128/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(body.length),
      authorization: `Bearer ${lane}`,
    },
    body,
  });
}

test("route wiring: a large-context request reserves the working set, the next one sheds, small ones pass", async () => {
  const workBudget = budgetFor({
    maxWorkBytes: 64 * 1024,
    maxLaneWorkBytes: 64 * 1024,
    amplification: 8,
    largeBodyBytes: 1024,
  });
  const controller = new ChatAdmissionController(
    Number.MAX_SAFE_INTEGER,
    0,
    0,
    () => {},
    { maxInflightBytes: Number.MAX_SAFE_INTEGER }
  );
  const handler = withChatAdmission(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    { controller, workBudget, workQueueMs: 0, queueMs: 0 }
  );

  // The budget is held by another lane: a large request must shed with the retryable 503, and a
  // small request must still be served (it needs no reservation).
  const held = workBudget.tryAcquire(workBudget.maxWorkBytes, "holder");
  assert.ok(held);

  const shed = await handler(largeRequest(4000, "lane-b"));
  assert.equal(shed.status, 503);
  const shedBody = JSON.parse(await shed.text());
  assert.equal(shedBody.error.code, "chat_work_budget");

  const tiny = await handler(
    new Request("http://127.0.0.1:20128/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer lane-c" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
    })
  );
  assert.equal(tiny.status, 200);
  assert.equal(workBudget.inflightRequests, 1, "a small request never takes a working-set reservation");

  // Capacity freed -> the same large request is admitted, and its reservation is released with
  // the (non-streaming) response lifecycle.
  held!.release();
  const admitted = await handler(largeRequest(4000, "lane-b"));
  assert.equal(admitted.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(workBudget.inflightBytes, 0, "the reservation is released with the response lifecycle");
  assert.equal(workBudget.inflightRequests, 0);
});