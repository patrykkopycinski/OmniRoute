import { test } from "node:test";
import assert from "node:assert/strict";
import { deduplicate, clearInflight } from "../../open-sse/services/requestDedup.ts";

// A failing leader with no joiners used to reject the shared in-flight promise
// that nobody awaited. That surfaced as an unhandledRejection, which the
// process crash guard rethrows for non-abort errors (e.g. SEMAPHORE_TIMEOUT),
// taking the whole server down.

const collectUnhandled = async (run: () => Promise<void>): Promise<unknown[]> => {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await run();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return seen;
};

test("leader failure with no joiners does not raise an unhandledRejection", async () => {
  clearInflight();
  const err = Object.assign(new Error("Semaphore timeout"), { code: "SEMAPHORE_TIMEOUT" });

  const seen = await collectUnhandled(async () => {
    await assert.rejects(
      deduplicate("hash-no-joiners", async () => {
        throw err;
      }),
      (thrown) => thrown === err
    );
  });

  assert.deepEqual(seen, []);
});

test("leader failure still propagates to a waiting joiner", async () => {
  clearInflight();
  const err = new Error("upstream failed");
  let fail!: () => void;
  const gate = new Promise<void>((resolve) => {
    fail = resolve;
  });

  const seen = await collectUnhandled(async () => {
    const leader = deduplicate("hash-with-joiner", async () => {
      await gate;
      throw err;
    });
    const joiner = deduplicate("hash-with-joiner", async () => "never runs");
    fail();
    const [leaderResult, joinerResult] = await Promise.allSettled([leader, joiner]);
    assert.equal(leaderResult.status, "rejected");
    assert.equal(joinerResult.status, "rejected");
    assert.equal((joinerResult as PromiseRejectedResult).reason, err);
  });

  assert.deepEqual(seen, []);
});
