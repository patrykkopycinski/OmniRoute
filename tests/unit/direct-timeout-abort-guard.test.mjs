import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isClientAbortError,
  shouldSwallowUncaught,
} from "../../src/shared/utils/httpClientAbortGuard.mjs";

const timeoutErr = Object.assign(
  new Error("Direct response did not start within 30000ms — retrying on a fresh socket"),
  { name: "TimeoutError", code: "DIRECT_RESPONSE_START_TIMEOUT" }
);
test("fresh-socket response-start timeout is classified benign", () => {
  assert.equal(isClientAbortError(timeoutErr), true);
  assert.equal(shouldSwallowUncaught(timeoutErr, "unhandledRejection"), true);
  assert.equal(shouldSwallowUncaught(timeoutErr, "uncaughtException"), true);
});
test("unrelated errors still fatal", () => {
  assert.equal(isClientAbortError(new Error("genuine bug")), false);
});
