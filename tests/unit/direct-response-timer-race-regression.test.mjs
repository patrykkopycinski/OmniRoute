/**
 * Regression: directResponseStartTimeout timer/abort race must not throw
 * uncaught from inside the timer callback.
 *
 * Incident 2026-09-13 23:28: gateway killed by
 *   uncaughtException: Error [TimeoutError] code=DIRECT_RESPONSE_START_TIMEOUT
 *   at Timeout._onTimeout -> undici — abort() landed on an already-settled
 *   undici request and threw synchronously inside the timer callback, where
 *   no user catch frame exists. clearTimeout cannot cancel a callback that is
 *   already queued, so the race window is real in production.
 *
 * Fix: try/catch around attemptController.abort() inside the timer callback.
 *
 * Discriminator: we patch setTimeout to fire the callback synchronously and
 * AbortController.abort to throw synchronously (undici-style). With the guard,
 * the call completes normally; with the guard reverted, the throw escapes the
 * timer callback and node:test reports an uncaught exception (file goes red).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { directFetchWithBoundedResponseStart } from "../../open-sse/utils/directResponseStartTimeout.ts";

test("sync-firing timer + sync-throwing abort must not escape (incident shape)", async () => {
  // 1) timer fires synchronously the moment it is scheduled
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => {
    fn(...args);
    return { unref() {}, [Symbol.dispose]() {} };
  };
  // 2) abort throws synchronously, as undici can post-settle
  const origAbort = AbortController.prototype.abort;
  let abortCalled = false;
  AbortController.prototype.abort = function () {
    abortCalled = true;
    throw new Error("Request is destroyed");
  };
  try {
    const fetchImpl = () =>
      new Promise((resolve) => origSetTimeout(() => resolve({ ok: true, settled: true }), 5));
    const res = await directFetchWithBoundedResponseStart("http://x/", {}, fetchImpl, 30);
    assert.equal(res.settled, true);
    assert.ok(abortCalled, "discriminator: abort must have been invoked");
  } finally {
    globalThis.setTimeout = origSetTimeout;
    AbortController.prototype.abort = origAbort;
  }
});

test("timeout still aborts a slow fetch (guard must not swallow the real timeout)", async () => {
  const fetchImpl = (_input, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
    });
  await assert.rejects(
    directFetchWithBoundedResponseStart("http://x/", {}, fetchImpl, 25),
    (e) => e.code === "DIRECT_RESPONSE_START_TIMEOUT"
  );
});

test("timeoutMs <= 0 bypasses the wrapper", async () => {
  const fetchImpl = async () => ({ ok: true, passthrough: true });
  const res = await directFetchWithBoundedResponseStart("http://x/", {}, fetchImpl, 0);
  assert.equal(res.passthrough, true);
});
