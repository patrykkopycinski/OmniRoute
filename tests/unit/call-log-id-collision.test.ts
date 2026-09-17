import test from "node:test";
import assert from "node:assert/strict";
import {
  generateLogId,
  __resetLogIdCounterForTest,
} from "../../src/lib/usage/callLogs.ts";

// Regression for the cross-process id collision seen in prod: multiple omniroute
// containers (canary fleet) share one storage.sqlite. Each process keeps its own
// in-memory logIdCounter starting at 0. Two processes restarting near the same
// millisecond both auto-generate their first id from `${Date.now()}-${logIdCounter}`
// and land on the identical string, so the second INSERT fails the call_logs.id
// UNIQUE constraint (68 collisions/6h observed in prod logs during canary churn).
//
// __resetLogIdCounterForTest() simulates a fresh process's counter (a container
// restart) without needing to spawn a real child process.
test("generateLogId ids never collide across simulated process restarts at the same millisecond", () => {
  const realNow = Date.now;
  try {
    const frozen = realNow();
    Date.now = () => frozen;

    const ids = new Set<string>();
    // Simulate 5 "processes" each restarting (counter reset to 0) and each
    // generating its first 3 ids, all within the same frozen millisecond —
    // the exact prod scenario (near-simultaneous canary restarts).
    for (let proc = 0; proc < 5; proc++) {
      __resetLogIdCounterForTest();
      for (let i = 0; i < 3; i++) {
        ids.add(generateLogId());
      }
    }

    assert.equal(
      ids.size,
      15,
      "every id must be unique even when logIdCounter resets to 0 across simulated process restarts at the same timestamp"
    );
  } finally {
    Date.now = realNow;
  }
});
