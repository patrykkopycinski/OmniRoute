import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-db-quota-snapshots-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const quotaSnapshotsDb = await import("../../src/lib/db/quotaSnapshots.ts");

async function resetStorage() {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  quotaSnapshotsDb.resetSnapshotCleanupThrottle();
  await resetStorage();
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("quotaSnapshots save and query rows with provider and connection filters", () => {
  quotaSnapshotsDb.saveQuotaSnapshot({
    provider: "openai",
    connection_id: "conn-1",
    window_key: "hourly",
    remaining_percentage: 60,
    is_exhausted: 0,
    next_reset_at: "2026-01-01T01:00:00.000Z",
    window_duration_ms: 3600000,
    raw_data: JSON.stringify({ source: "first" }),
  });
  quotaSnapshotsDb.saveQuotaSnapshot({
    provider: "anthropic",
    connection_id: "conn-2",
    window_key: "daily",
    remaining_percentage: 30,
    is_exhausted: 1,
    next_reset_at: "2026-01-02T00:00:00.000Z",
    window_duration_ms: 86400000,
    raw_data: JSON.stringify({ source: "second" }),
  });

  const openaiRows = quotaSnapshotsDb.getQuotaSnapshots({
    provider: "openai",
    connectionId: "conn-1",
    since: "2000-01-01T00:00:00.000Z",
  });

  assert.equal(openaiRows.length, 1);
  assert.equal(openaiRows[0].provider, "openai");
  assert.equal(openaiRows[0].connectionId, "conn-1");
});

test("quotaSnapshots aggregates by provider or connection and rejects invalid buckets", () => {
  quotaSnapshotsDb.saveQuotaSnapshot({
    provider: "openai",
    connection_id: "conn-a",
    window_key: "hourly",
    remaining_percentage: 50,
    is_exhausted: 0,
    next_reset_at: "2026-01-01T01:00:00.000Z",
    window_duration_ms: 3600000,
    raw_data: "{}",
  });
  quotaSnapshotsDb.saveQuotaSnapshot({
    provider: "openai",
    connection_id: "conn-a",
    window_key: "hourly",
    remaining_percentage: 70,
    is_exhausted: 0,
    next_reset_at: "2026-01-01T01:10:00.000Z",
    window_duration_ms: 3600000,
    raw_data: "{}",
  });

  const providerAgg = quotaSnapshotsDb.getAggregatedSnapshots({
    provider: "openai",
    since: "2000-01-01T00:00:00.000Z",
    bucketMinutes: 60,
  });
  const connectionAgg = quotaSnapshotsDb.getAggregatedSnapshots({
    since: "2000-01-01T00:00:00.000Z",
    bucketMinutes: 60,
    aggregateBy: "connection",
  });

  assert.equal(providerAgg.length, 1);
  assert.equal(providerAgg[0].remainingPct, 60);
  assert.equal(connectionAgg[0].provider, "openai:conn-a");

  assert.throws(
    () =>
      quotaSnapshotsDb.getAggregatedSnapshots({
        since: "2000-01-01T00:00:00.000Z",
        bucketMinutes: 0,
      }),
    /Invalid bucket size/
  );
});

test("quotaSnapshots cleanup removes old rows and throttles repeated execution", () => {
  const db = coreDb.getDbInstance();
  db.prepare(
    `
    INSERT INTO quota_snapshots
    (provider, connection_id, window_key, remaining_percentage, is_exhausted, next_reset_at, window_duration_ms, raw_data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    "openai",
    "old-conn",
    "hourly",
    20,
    1,
    "2000-01-01T01:00:00.000Z",
    3600000,
    "{}",
    "2000-01-01T00:00:00.000Z"
  );

  const deleted = quotaSnapshotsDb.cleanupOldSnapshots(1);
  const throttled = quotaSnapshotsDb.cleanupOldSnapshots(1);

  assert.equal(deleted, 1);
  assert.equal(throttled, 0);
});

function withRetentionEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.QUOTA_SNAPSHOT_RETENTION_DAYS;
  if (value === undefined) delete process.env.QUOTA_SNAPSHOT_RETENTION_DAYS;
  else process.env.QUOTA_SNAPSHOT_RETENTION_DAYS = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.QUOTA_SNAPSHOT_RETENTION_DAYS;
    else process.env.QUOTA_SNAPSHOT_RETENTION_DAYS = prev;
  }
}

function insertSnapshotAt(createdAt: string, connectionId: string) {
  const db = coreDb.getDbInstance();
  db.prepare(
    `INSERT INTO quota_snapshots
     (provider, connection_id, window_key, remaining_percentage, is_exhausted, next_reset_at, window_duration_ms, raw_data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("openai", connectionId, "hourly", 20, 0, null, 3600000, "{}", createdAt);
}

function countSnapshots(): number {
  const row = coreDb.getDbInstance().prepare("SELECT COUNT(*) AS n FROM quota_snapshots").get() as {
    n: number;
  };
  return row.n;
}

test("resolveSnapshotRetentionDays defaults to 90 and honors the env override", () => {
  withRetentionEnv(undefined, () =>
    assert.equal(quotaSnapshotsDb.resolveSnapshotRetentionDays(), 90)
  );
  withRetentionEnv("", () => assert.equal(quotaSnapshotsDb.resolveSnapshotRetentionDays(), 90));
  withRetentionEnv("365", () => assert.equal(quotaSnapshotsDb.resolveSnapshotRetentionDays(), 365));
  withRetentionEnv(" 30 ", () => assert.equal(quotaSnapshotsDb.resolveSnapshotRetentionDays(), 30));
});

test("resolveSnapshotRetentionDays caps oversized windows at 36500 days", () => {
  withRetentionEnv("999999999", () =>
    assert.equal(quotaSnapshotsDb.resolveSnapshotRetentionDays(), 36500)
  );
  withRetentionEnv("36501", () =>
    assert.equal(quotaSnapshotsDb.resolveSnapshotRetentionDays(), 36500)
  );
  withRetentionEnv("36500", () =>
    assert.equal(quotaSnapshotsDb.resolveSnapshotRetentionDays(), 36500)
  );
});

test("resolveSnapshotRetentionDays returns null (disabled) for 0", () => {
  withRetentionEnv("0", () => assert.equal(quotaSnapshotsDb.resolveSnapshotRetentionDays(), null));
});

test("resolveSnapshotRetentionDays falls back to 90 for invalid values", () => {
  for (const bad of ["abc", "-5", "1.5", "30days", "NaN", "Infinity", "99999999999999999999"]) {
    withRetentionEnv(bad, () =>
      assert.equal(quotaSnapshotsDb.resolveSnapshotRetentionDays(), 90, bad)
    );
  }
});

test("cleanupOldSnapshots with no argument uses the env retention window", () => {
  const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
  insertSnapshotAt(old, "old");
  insertSnapshotAt(recent, "recent");
  withRetentionEnv("365", () => assert.equal(quotaSnapshotsDb.cleanupOldSnapshots(), 0));
  assert.equal(countSnapshots(), 2);
});

test("cleanupOldSnapshots default (90d) deletes only rows older than the window", () => {
  const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
  insertSnapshotAt(old, "old");
  insertSnapshotAt(recent, "recent");
  withRetentionEnv(undefined, () => assert.equal(quotaSnapshotsDb.cleanupOldSnapshots(), 1));
  assert.equal(countSnapshots(), 1);
});

test("cleanupOldSnapshots deletes nothing when QUOTA_SNAPSHOT_RETENTION_DAYS=0", () => {
  insertSnapshotAt("2000-01-01T00:00:00.000Z", "ancient");
  withRetentionEnv("0", () => assert.equal(quotaSnapshotsDb.cleanupOldSnapshots(), 0));
  assert.equal(countSnapshots(), 1);
});

test("cleanupOldSnapshots with an oversized env window does not throw and keeps recent rows", () => {
  const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
  const decadeOld = new Date(Date.now() - 3650 * 24 * 60 * 60 * 1000).toISOString();
  insertSnapshotAt(recent, "recent");
  insertSnapshotAt(decadeOld, "decade-old");
  withRetentionEnv("999999999", () => assert.equal(quotaSnapshotsDb.cleanupOldSnapshots(), 0));
  assert.equal(countSnapshots(), 2);
});

test("cleanupOldSnapshots caps an oversized explicit argument instead of throwing", () => {
  insertSnapshotAt(new Date(Date.now() - 3650 * 24 * 60 * 60 * 1000).toISOString(), "decade-old");
  assert.equal(quotaSnapshotsDb.cleanupOldSnapshots(999999999), 0);
  assert.equal(countSnapshots(), 1);
});

test("cleanupOldSnapshots treats an explicit retentionDays <= 0 as a no-op", () => {
  insertSnapshotAt("2000-01-01T00:00:00.000Z", "ancient");
  assert.equal(quotaSnapshotsDb.cleanupOldSnapshots(0), 0);
  assert.equal(quotaSnapshotsDb.cleanupOldSnapshots(-5), 0);
  assert.equal(quotaSnapshotsDb.cleanupOldSnapshots(Number.NaN), 0);
  assert.equal(countSnapshots(), 1);
});

test("quotaSnapshots aggregation returns one row per bucket with the tightest window", () => {
  const db = coreDb.getDbInstance();
  const insert = db.prepare(
    `INSERT INTO quota_snapshots
     (provider, connection_id, window_key, remaining_percentage, is_exhausted, next_reset_at, window_duration_ms, raw_data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const row = (windowKey: string, remaining: number, exhausted: number, createdAt: string) =>
    insert.run("claude", "conn-1", windowKey, remaining, exhausted, null, null, "{}", createdAt);

  // 10:00 bucket: the 5h session is almost full but the weekly window is exhausted.
  row("session (5h)", 97, 0, "2026-01-01T10:05:00.000Z");
  row("weekly (7d)", 20, 0, "2026-01-01T10:10:00.000Z");
  row("weekly (7d)", 0, 1, "2026-01-01T10:40:00.000Z");
  // 11:00 bucket: both windows have headroom, the weekly one is still the tightest.
  row("session (5h)", 90, 0, "2026-01-01T11:05:00.000Z");
  row("weekly (7d)", 40, 0, "2026-01-01T11:10:00.000Z");

  const byProvider = quotaSnapshotsDb.getAggregatedSnapshots({
    since: "2000-01-01T00:00:00.000Z",
    bucketMinutes: 60,
  });

  assert.equal(byProvider.length, 2, "one row per bucket, not one per quota window");
  assert.deepEqual(
    byProvider.map((point) => point.timestamp),
    ["2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z"]
  );
  // Window samples are still averaged inside a bucket (weekly: (20 + 0) / 2 = 10), then the tightest wins.
  assert.equal(byProvider[0].remainingPct, 10);
  assert.equal(byProvider[0].isExhausted, true);
  assert.equal(byProvider[0].windowKey, "weekly (7d)");
  assert.equal(byProvider[1].remainingPct, 40);
  assert.equal(byProvider[1].isExhausted, false);
  assert.equal(byProvider[1].windowKey, "weekly (7d)");

  const byConnection = quotaSnapshotsDb.getAggregatedSnapshots({
    since: "2000-01-01T00:00:00.000Z",
    bucketMinutes: 60,
    aggregateBy: "connection",
  });
  assert.equal(byConnection.length, 2);
  assert.equal(byConnection[0].provider, "claude:conn-1");
  assert.equal(byConnection[0].remainingPct, 10);
});
