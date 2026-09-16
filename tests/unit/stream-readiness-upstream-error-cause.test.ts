import test from "node:test";
import assert from "node:assert/strict";

import { ensureStreamReadiness } from "../../open-sse/utils/streamReadiness.ts";

const encoder = new TextEncoder();

const PING = 'event: ping\ndata: {"type":"ping"}\n\n';

/** Emits a keepalive ping, then fails the stream the way a dying socket does. */
function pingThenErrorStream(error: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(PING));
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.error(error);
    },
  });
}

/** Emits a keepalive ping and then stays silent forever (a genuine stall). */
function silentAfterPingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(PING));
    },
  });
}

test("reader failure is reported as an upstream error, not as an idle-window stall", async () => {
  const result = await ensureStreamReadiness(
    new Response(pingThenErrorStream(new Error("socket hang up")), { status: 200 }),
    { timeoutMs: 5_000, provider: "cursor", model: "kimi-k3-high" }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "STREAM_UPSTREAM_ERROR");
  assert.equal(result.type, "stream_upstream_error");
  assert.equal(result.response.status, 502);
  assert.match(result.reason, /socket hang up/);
  assert.equal(result.upstreamDiagnostic, "socket hang up");
});

test("a sub-second upstream abort never claims the configured idle window elapsed", async () => {
  // Regression: the read-error branch used to reuse the timeout message, so a
  // 107ms socket abort was reported as "no non-ping SSE event within 90000ms"
  // and sent triage chasing a stall that never happened.
  const result = await ensureStreamReadiness(
    new Response(pingThenErrorStream(new Error("aborted")), { status: 200 }),
    { timeoutMs: 90_000, provider: "cursor", model: "kimi-k3-high" }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "STREAM_UPSTREAM_ERROR");
  assert.doesNotMatch(result.reason, /within \d+ms/);
  assert.doesNotMatch(result.reason, /non-ping SSE event within/);
});

test("an error cause and a non-default error name are preserved in the diagnostic", async () => {
  const cause = new Error("ECONNRESET");
  const error = new Error("terminated", { cause });
  error.name = "AbortError";

  const result = await ensureStreamReadiness(
    new Response(pingThenErrorStream(error), { status: 200 }),
    { timeoutMs: 5_000, provider: "cursor", model: "kimi-k3-high" }
  );

  assert.equal(result.code, "STREAM_UPSTREAM_ERROR");
  assert.match(result.reason, /AbortError/);
  assert.match(result.reason, /terminated/);
  assert.match(result.reason, /ECONNRESET/);
});

test("a genuine silent stall still reports the idle window as a 504", async () => {
  const result = await ensureStreamReadiness(
    new Response(silentAfterPingStream(), { status: 200 }),
    { timeoutMs: 60, provider: "cursor", model: "kimi-k3-high" }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "STREAM_READINESS_TIMEOUT");
  assert.equal(result.type, "stream_timeout");
  assert.equal(result.response.status, 504);
  assert.match(result.reason, /no non-ping SSE event within \d+ms/);
});
