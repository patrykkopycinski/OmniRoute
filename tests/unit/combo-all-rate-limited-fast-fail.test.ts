import test from "node:test";
import assert from "node:assert/strict";
import { handleComboChat } from "../../open-sse/services/combo.ts";

const log = { info: (...a: unknown[]) => console.log("I", ...a), warn: (...a: unknown[]) => console.log("W", ...a), debug: () => {}, error: () => {} };

function limited(retryAfterIso: string | null, opts: { code?: string } = {}) {
  return new Response(
    JSON.stringify({
      error: { message: "rate limited", ...(opts.code ? { code: opts.code } : {}) },
      ...(retryAfterIso ? { retryAfter: retryAfterIso } : {}),
    }),
    { status: 429, headers: { "Content-Type": "application/json" } }
  );
}

async function run(handle: (b: unknown, m: string) => Promise<Response>, name: string) {
  const t0 = Date.now();
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "hi" }], stream: true },
    combo: { name, strategy: "priority", models: ["openai/gpt-4", "anthropic/claude-opus-5"] },
    handleSingleModel: handle as never,
    isModelAvailable: async () => true,
    log,
    settings: null,
    relayOptions: null,
    allCombos: null,
  } as never);
  return { res, elapsedMs: Date.now() - t0 };
}

test("all targets 429 with long resets: fast typed error carrying the SOONEST Retry-After", async () => {
  const resets = [3600, 1800]; // seconds; soonest = 1800
  const calls: string[] = [];
  const { res, elapsedMs } = await run(async (_b, modelStr) => {
    calls.push(modelStr);
    const secs = modelStr.startsWith("openai") ? resets[0] : resets[1];
    return limited(new Date(Date.now() + secs * 1000).toISOString());
  }, "fast-fail-all-429");

  assert.ok(elapsedMs < 3000, `must fail fast, took ${elapsedMs}ms`);
  assert.equal(res.status, 429);
  const retryAfter = Number(res.headers.get("retry-after"));
  assert.ok(retryAfter >= 1700 && retryAfter <= 1800, `Retry-After=${retryAfter}`);
  const body = await res.json();
  assert.equal(body.error.code, "ALL_TARGETS_RATE_LIMITED");
  assert.ok(Math.abs(body.error.retry_after - retryAfter) <= 1);
  assert.equal(calls.length, 2, "each target tried once, no retry loop");
});

test("all targets 429 with NO per-target hint: still typed error with a Retry-After header", async () => {
  const { res, elapsedMs } = await run(async () => limited(null), "fast-fail-no-hint");
  // A hint-less 429 keeps the one bounded same-model retry (default 2s x 2 targets).
  assert.ok(elapsedMs < 6000, `took ${elapsedMs}ms`);
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error.code, "ALL_TARGETS_RATE_LIMITED");
  assert.ok(Number(res.headers.get("retry-after")) >= 1);
});

test("local token-limit 429 carrying a window reset contributes to the soonest Retry-After", async () => {
  const soon = new Date(Date.now() + 120_000).toISOString();
  const later = new Date(Date.now() + 7200_000).toISOString();
  const { res } = await run(async (_b, modelStr) => {
    return modelStr.startsWith("openai")
      ? limited(soon, { code: "TOKEN_LIMIT_EXCEEDED" })
      : limited(later);
  }, "fast-fail-token-limit");
  assert.equal(res.status, 429);
  const retryAfter = Number(res.headers.get("retry-after"));
  assert.ok(retryAfter >= 100 && retryAfter <= 120, `Retry-After=${retryAfter}`);
  assert.equal((await res.json()).error.code, "ALL_TARGETS_RATE_LIMITED");
});
