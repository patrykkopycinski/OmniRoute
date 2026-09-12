/**
 * Regression: hedge-cancelled abort must not kill the process.
 *
 * Incident 2026-09-11/12: every `memory`-combo call for two days died as 499
 * "Client disconnected" at exactly ~120s, and the gateway logged
 * `uncaughtException: Error [AbortError]: hedge-cancelled` then restarted
 * (15+ restarts on 2026-09-12). Mechanism: client disconnects at its own
 * timeout while a hedged sibling target is still in flight;
 * streamHandler.handleDisconnect -> abortController.abort(reason) fires
 * listeners synchronously; one throws the hedge-cancelled AbortError into
 * uncaughtException; httpClientAbortGuard.isClientAbortError did not
 * recognize OmniRoute's own deliberate combo abort reasons (messages lack
 * "abort"), so installProcessCrashGuard let the process die.
 *
 * Fix: (1) streamHandler catches synchronous throws from abort listeners,
 * (2) the guard classifies hedge-cancelled / combo-per-model-timeout /
 * request_signal_aborted as benign client-abort errors.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isClientAbortError,
  shouldSwallowUncaught,
} from "../../src/shared/utils/httpClientAbortGuard.mjs";

function comboAbortError(message) {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

test("isClientAbortError: hedge-cancelled is benign", () => {
  assert.equal(isClientAbortError(comboAbortError("hedge-cancelled")), true);
});

test("isClientAbortError: combo-per-model-timeout is benign", () => {
  assert.equal(isClientAbortError(comboAbortError("combo-per-model-timeout")), true);
});

test("isClientAbortError: request_signal_aborted is benign", () => {
  assert.equal(isClientAbortError(comboAbortError("request_signal_aborted")), true);
});

test("shouldSwallowUncaught: hedge-cancelled uncaughtException is swallowed", () => {
  assert.equal(
    shouldSwallowUncaught(comboAbortError("hedge-cancelled"), "uncaughtException"),
    true
  );
});

test("genuine errors stay fatal", () => {
  assert.equal(isClientAbortError(new Error("database corrupted")), false);
  assert.equal(shouldSwallowUncaught(new Error("database corrupted"), "uncaughtException"), false);
});

test("null/undefined stay non-benign", () => {
  assert.equal(isClientAbortError(null), false);
  assert.equal(isClientAbortError(undefined), false);
});
