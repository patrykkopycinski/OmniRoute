"use strict";
import assert from "node:assert";
import { test } from "node:test";
import {
  shouldSwallowUncaught,
  isRequestScopedError,
} from "../../src/shared/utils/httpClientAbortGuard.mjs";

// Confirmed production fatal 2026-09-20: 29 gateway deaths. proxyFetch wraps
// an upstream proxy's ECONNREFUSED in a PROXY_UNREACHABLE error whose own
// `.code` matches nothing in the legacy isClientAbortError switch, and the
// real ECONNREFUSED lives one level down in `.cause`.
test("shouldSwallowUncaught absorbs the exact PROXY_UNREACHABLE/ECONNREFUSED production shape (2026-09-20)", () => {
  const cause = Object.assign(new Error("connect ECONNREFUSED 100.125.172.75:30003"), {
    errno: -111,
    code: "ECONNREFUSED",
    syscall: "connect",
    address: "100.125.172.75",
    port: 30003,
  });
  const err = Object.assign(new TypeError("fetch failed"), {
    proxyFetchDetail:
      "dispatcher=[TypeError fetch failed code=PROXY_UNREACHABLE | connect ECONNREFUSED 100.125.172.75:30003]",
    code: "PROXY_UNREACHABLE",
    errorCode: "proxy_unreachable",
    cause,
  });
  assert.equal(isRequestScopedError(err), true);
  assert.equal(shouldSwallowUncaught(err, "uncaughtException"), true);
});

test("shouldSwallowUncaught absorbs a bare ECONNREFUSED with no wrapper", () => {
  const err = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
    errno: -111,
    code: "ECONNREFUSED",
    syscall: "connect",
  });
  assert.equal(shouldSwallowUncaught(err, "uncaughtException"), true);
});

test("shouldSwallowUncaught walks a deeply nested cause chain (2-3 levels) to find ECONNRESET", () => {
  const root = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const mid = Object.assign(new Error("upstream request failed"), { code: "EUPSTREAMWRAP", cause: root });
  const outer = Object.assign(new Error("fetch failed"), { code: "FETCH_FAILED", cause: mid });
  assert.equal(isRequestScopedError(outer), true);
  assert.equal(shouldSwallowUncaught(outer, "uncaughtException"), true);
});

test("isRequestScopedError terminates on a self-referential cause cycle instead of hanging/overflowing", () => {
  const err = Object.assign(new Error("cyclic"), { code: "SOMETHING_UNRECOGNISED" });
  err.cause = err; // self-reference
  let result;
  assert.doesNotThrow(() => {
    result = isRequestScopedError(err);
  });
  assert.equal(result, false, "the cycle contains no recognised transport signature, so it stays fatal");
});

test("isRequestScopedError terminates on a mutually-referential cause cycle", () => {
  const a = Object.assign(new Error("a"), { code: "ECONNRESET" });
  const b = Object.assign(new Error("b"), { code: "UNRECOGNISED" });
  a.cause = b;
  b.cause = a;
  let result;
  assert.doesNotThrow(() => {
    result = isRequestScopedError(b);
  });
  // b -> a (ECONNRESET, recognised) -> found before the cycle closes.
  assert.equal(result, true);
});

// Confirmed production fatal 2026-09-17 (killed container omniroute-canary9).
test("shouldSwallowUncaught absorbs the ERR_INVALID_THIS ReadableStreamBYOBReader teardown shape (2026-09-17)", () => {
  const err = Object.assign(new TypeError('Value of "this" must be of type ReadableStreamBYOBReader'), {
    code: "ERR_INVALID_THIS",
  });
  assert.equal(isRequestScopedError(err), true);
  assert.equal(shouldSwallowUncaught(err, "uncaughtException"), true);
});

test("shouldSwallowUncaught absorbs the ERR_INVALID_THIS ReadableStreamDefaultReader variant too", () => {
  const err = Object.assign(new TypeError('Value of "this" must be of type ReadableStreamDefaultReader'), {
    code: "ERR_INVALID_THIS",
  });
  assert.equal(shouldSwallowUncaught(err, "uncaughtException"), true);
});

// HARD BOUNDARY: a genuine programming bug must still crash.
test("shouldSwallowUncaught still rethrows a genuine programming bug (TypeError: x is not a function)", () => {
  const err = new TypeError("x is not a function");
  assert.equal(isRequestScopedError(err), false);
  assert.equal(shouldSwallowUncaught(err, "uncaughtException"), false);
});

// Proves the ERR_INVALID_THIS swallow is narrow: an ERR_INVALID_THIS on some
// OTHER brand (not a stream reader) must still be treated as a real bug.
test("shouldSwallowUncaught still rethrows ERR_INVALID_THIS when the message does not name a stream reader", () => {
  const err = Object.assign(new TypeError('Value of "this" must be of type Map'), {
    code: "ERR_INVALID_THIS",
  });
  assert.equal(isRequestScopedError(err), false);
  assert.equal(shouldSwallowUncaught(err, "uncaughtException"), false);
});

test("shouldSwallowUncaught still rethrows ERR_INVALID_THIS with no message reference at all", () => {
  const err = Object.assign(new TypeError("Value of \"this\" must be of internal type"), {
    code: "ERR_INVALID_THIS",
  });
  assert.equal(shouldSwallowUncaught(err, "uncaughtException"), false);
});

// A PROXY_UNREACHABLE/ECONNREFUSED-shaped error must still respect the
// existing origin gating in shouldSwallowUncaught (unrelated subsystem throw
// should not silently swallow just because the shape matches).
test("shouldSwallowUncaught respects origin gating for request-scoped errors", () => {
  const err = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:1"), { code: "ECONNREFUSED" });
  assert.equal(shouldSwallowUncaught(err, "someOtherOrigin"), false);
});
