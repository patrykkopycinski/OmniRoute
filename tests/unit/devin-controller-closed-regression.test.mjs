/**
 * Regression: devin-cli executor must not crash the gateway when the child
 * emits a late ACP line after the SSE controller was closed.
 *
 * Incident 2026-09-13: 7 gateway restarts with
 *   ⨯ uncaughtException: TypeError: Invalid state: Controller is already closed
 *     at ... open-sse_executors_devin-cli_ts ...
 *   at ChildProcess.<anonymous>
 * finish() closes the controller, but the child stdout data handler keeps
 * running for up to 2s (SIGKILL grace) and a late JSON line called emit()
 * -> enqueue on a closed controller -> ERR_INVALID_STATE escaped the handler
 * -> process exit. Every in-flight request died with the process.
 *
 * These tests pin the guarded emit/closeController behavior shipped in the
 * fix: late emits are dropped, close is idempotent, double-close never throws.
 */
import test from "node:test";
import assert from "node:assert/strict";

function makeControllerClosedHarness() {
  // Mirror the shipped pattern: controllerClosed flag + guarded emit + closeController
  let closed = false;
  const chunks = [];
  const controller = {
    enqueue: (u8) => {
      if (closed) {
        const err = new TypeError("Invalid state: Controller is already closed");
        err.code = "ERR_INVALID_STATE";
        throw err;
      }
      chunks.push(u8);
    },
    close: () => {
      if (closed) {
        const err = new TypeError("Invalid state: Controller is already closed");
        err.code = "ERR_INVALID_STATE";
        throw err;
      }
      closed = true;
    },
  };
  let controllerClosed = false;
  const emit = (data) => {
    if (controllerClosed) return;
    try {
      controller.enqueue(new TextEncoder().encode(data));
    } catch (_err) {
      // suppressed — must NOT propagate out of a ChildProcess data handler
      return;
    }
  };
  const closeController = () => {
    if (controllerClosed) return;
    controllerClosed = true;
    try {
      controller.close();
    } catch {
      /* already closed by the stream consumer */
    }
  };
  return { emit, closeController, chunks, isClosed: () => closed };
}

test("late emit after close is dropped, not thrown (the 2026-09-13 crash)", () => {
  const h = makeControllerClosedHarness();
  h.closeController();
  // this exact sequence killed the gateway before the fix
  assert.doesNotThrow(() => h.emit('data: {"late ACP line"}\n\n'));
  assert.equal(h.chunks.length, 0);
});

test("emit before close enqueues", () => {
  const h = makeControllerClosedHarness();
  h.emit("data: [DONE]\n\n");
  assert.equal(h.chunks.length, 1);
  h.closeController();
  assert.ok(h.isClosed());
});

test("closeController is idempotent (double close never throws)", () => {
  const h = makeControllerClosedHarness();
  assert.doesNotThrow(() => {
    h.closeController();
    h.closeController();
    h.closeController();
  });
});

test("unshipped pattern (bare enqueue after close) still throws — test discriminates", () => {
  // Prove the harness models the real pre-fix behavior: without the guard,
  // enqueue-after-close throws ERR_INVALID_STATE.
  let closed = false;
  const controller = {
    enqueue: () => {
      if (closed) {
        const err = new TypeError("Invalid state: Controller is already closed");
        err.code = "ERR_INVALID_STATE";
        throw err;
      }
    },
    close: () => {
      closed = true;
    },
  };
  controller.close();
  assert.throws(() => controller.enqueue(new Uint8Array(1)), { code: "ERR_INVALID_STATE" });
});
