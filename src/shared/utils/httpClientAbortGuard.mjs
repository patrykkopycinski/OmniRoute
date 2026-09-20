"use strict";
/**
 * HTTP client-abort / recoverable-upstream-timeout crash guard
 * (#fix-dev-server-aborted, #12861).
 *
 * Node's http.Server turns an 'error' event on an IncomingMessage/ServerResponse
 * into an uncaughtException (and therefore a process exit) WHENEVER the emitter
 * has no listener. The single most common such error is a *client* abort: the
 * browser closes the TCP socket (navigation, Back/Forward cache, HMR reconnect,
 * cancelling a fetch) while the server is still streaming the response. Node
 * emits `Error: aborted` / `ERR_STREAM_PREMATURE_CLOSE` / `ECONNRESET` on the
 * request stream, and absent a handler it kills the whole server process.
 *
 * That surfaced as "login succeeds, then the dashboard hangs with a wall of
 * `net::ERR_CONNECTION_REFUSED`": after auth the SPA opens many polling
 * connections + a live WebSocket; stray client-side socket closes during
 * navigation/HMR were taking the dev server down.
 *
 * Two more categories were added after the 2026-09-14 agnes-cn upstream storm
 * produced two sibling escapes in production: an intentional combo hedge
 * cancellation (`AbortError: hedge-cancelled` — the sibling leg already won,
 * so the cancellation is expected, not a fault) and undici fetch failures
 * (`TypeError: fetch failed` with a socket-level code) against a flapping
 * upstream. Both are runtime/environmental conditions the request layer
 * already handles; neither is a process-fatal logic bug.
 *
 * A further, unrelated category covers #12861: `directFetchWithBoundedResponseStart`'s
 * response-start timeout (`DIRECT_RESPONSE_START_TIMEOUT`) is a *recoverable*
 * signal `proxyFetch.ts` already retries on a fresh socket — but a narrow
 * timer/promise-settlement race can still deliver its abort reason to a
 * promise nobody is awaiting anymore, which otherwise kills the whole process
 * over a single upstream stall that the retry path was built to handle.
 *
 * Two layers:
 *   1. `attachRequestStreamGuards(req, res)` — per-request listeners that absorb
 *      client-abort errors so they never bubble to the process level. Call it
 *      inside every `http.createServer((req, res) => …)` request listener.
 *   2. `installProcessCrashGuard()` — a last-resort safety net on
 *      `process.on('uncaughtException' | 'unhandledRejection')` that swallows
 *      request-scoped transport failures but otherwise preserves the existing
 *      crash semantics (so genuine bugs still surface). Idempotent.
 *
 * Kept as a `.mjs` module (no build step) so it is importable both from the
 * Node-only dev server (`scripts/dev/run-next.mjs`) and from the TypeScript
 * servers under `src/` (tsconfig `allowJs: true`).
 *
 * @module
 */
/**
 * Abort reasons raised by combo target dispatch. Mirror of
 * open-sse/services/combo/comboAbortReasons.ts — keep the two in sync.
 */
const COMBO_ABORT_REASONS = new Set(["hedge-cancelled", "combo-per-model-timeout"]);

/**
 * Raw string reasons open-sse/utils/streamHandler.ts passes to
 * handleDisconnect() / abortController.abort() when the client goes away.
 */
const CLIENT_DISCONNECT_REASONS = new Set(["request_signal_aborted", "client_closed", "cancelled"]);

/**
 * @param {unknown} err
 * @returns {boolean} true when `err` represents a client closing the
 *   connection rather than a server-side fault.
 */
export function isClientAbortError(err) {
  // open-sse/utils/streamHandler.ts aborts the stream controller with a RAW
  // STRING reason (getClientAbortReason / handleDisconnect), and undici rejects
  // with signal.reason verbatim, so a cancellation can surface at the process
  // level as a bare string rather than an Error object.
  if (typeof err === "string") {
    return COMBO_ABORT_REASONS.has(err) || CLIENT_DISCONNECT_REASONS.has(err);
  }
  if (!err || typeof err !== "object") return false;
  const e = /** @type {NodeJS.ErrnoException} */ (err);
  // Node emits `Error: aborted` (no code) from http.Server#abortIncoming.
  if (e.message === "aborted" || e.message === "Aborted") return true;
  // OmniRoute's SSE teardown aborts in-flight legs with
  // `Error [AbortError]: request_signal_aborted` on client disconnects
  // (open-sse/utils/streamHandler.ts), and fetch/DOM cancellation surfaces as
  // `AbortError` with an abort-flavoured message. Same benign class as
  // `Error: aborted` — an emitter-left 'error' event on any of these used to
  // kill the process (#fix-dev-server-aborted).
  if (e.name === "AbortError" && /abort/i.test(String(e.message))) return true;
  // OmniRoute's own deliberate combo-dispatch abort reasons (see
  // open-sse/services/combo/comboAbortReasons.ts). They surface as AbortError
  // but their messages do not contain "abort", so the regex above misses them;
  // classifying them as fatal killed the whole gateway on every hedge cancel
  // during a client disconnect (memory-combo incident 2026-09-11/12).
  // Historical: a leaked abort listener in chatCore/upstreamTimeouts.ts once
  // rebuilt these as an unhandledRejection (production exit 2026-08-31) — the
  // leak is fixed at the source upstream; this stays as the last-resort net.
  if (
    COMBO_ABORT_REASONS.has(String(e.message)) ||
    e.message === "request_signal_aborted"
  ) {
    return true;
  }
  // DIRECT_RESPONSE_START_TIMEOUT: proxyFetch's direct path aborts a stalled
  // fetch with a fresh-socket TimeoutError after 30s and retries on a new
  // dispatcher. The retried attempt is awaited and handled by the combo
  // dispatcher, but when the timeout fires on the FINAL attempt (or a
  // caller-side promise was dropped mid-flight) the rejection has no handler
  // in that frame and Next.js escalates it to a process kill (2026-09-14
  // 07:0x restarts). A response-start timeout is an upstream-slow condition,
  // not a gateway fault — swallowing keeps parity with the other deliberate
  // combo-dispatch abort reasons above.
  if (e.code === "DIRECT_RESPONSE_START_TIMEOUT") return true;
  switch (e.code) {
    case "ERR_STREAM_PREMATURE_CLOSE":
    case "ECONNRESET":
    case "EPIPE":
    case "ECONNABORTED":
    case "ETIMEDOUT":
    case "ENOTCONN":
    case "ECANCELED":
      return true;
    default:
      return false;
  }
}
/**
 * Transport-layer error codes that indicate an UPSTREAM (or upstream's proxy)
 * refused/dropped the connection for THIS request only — never a reason to
 * kill a multi-tenant gateway process.
 *
 * `ECONNREFUSED`: the far end (or, per PROXY_UNREACHABLE below, the configured
 *   egress proxy) is not accepting connections at all. Confirmed production
 *   fatal 2026-09-20: 29 gateway deaths when an upstream proxy dropped off
 *   the network — every retry attempt threw a fresh ECONNREFUSED that was
 *   never in this switch.
 * `PROXY_UNREACHABLE`: OmniRoute's own proxyFetch wraps the above ECONNREFUSED
 *   in `{ code: 'PROXY_UNREACHABLE', errorCode: 'proxy_unreachable', cause }`.
 *   The outer code alone doesn't match anything in `isClientAbortError`'s
 *   switch (by design — that function only classifies the error AT hand, it
 *   does not walk `.cause`), so recognising this code directly is required in
 *   addition to the cause-chain walk in `isRequestScopedError` below: either
 *   one on its own would have missed a variant of this incident (a future
 *   caller could reject with a bare PROXY_UNREACHABLE with no `.cause`, or a
 *   bare ECONNREFUSED several layers deep with no PROXY_UNREACHABLE wrapper).
 *
 * @param {unknown} code
 * @returns {boolean}
 */
function isSheddableTransportCode(code) {
  switch (code) {
    case "ECONNREFUSED":
    case "PROXY_UNREACHABLE":
      return true;
    default:
      return false;
  }
}
// Matches Node's whatwg-streams internal brand-check message, e.g.
//   Value of "this" must be of type ReadableStreamBYOBReader
//   Value of "this" must be of type ReadableStreamDefaultReader
// Deliberately narrow — see `isStreamReaderTeardownError` below.
const STREAM_READER_BRAND_RE = /ReadableStream(?:BYOB|Default)Reader/;
/**
 * Confirmed production fatal 2026-09-17 (killed container omniroute-canary9):
 *   TypeError: Value of "this" must be of type ReadableStreamBYOBReader
 *   code: 'ERR_INVALID_THIS'
 *
 * `ERR_INVALID_THIS` is Node's generic "you called a method on an object that
 * isn't the right internal type" brand-check failure. It is NOT swallowed
 * unconditionally: calling, say, `Map.prototype.get.call(notAMap, k)` is a
 * genuine programming bug and must still crash so it gets fixed. The teardown
 * race that actually happened here is narrower — a stream reader's internal
 * method (release/read/cancel) gets invoked after the reader has already been
 * detached/replaced during response-stream teardown on a client disconnect,
 * which is a request-scoped timing issue, not a code defect.
 *
 * TRADEOFF (deliberate): this predicate only swallows `ERR_INVALID_THIS`
 * errors whose message names a WHATWG stream reader type
 * (ReadableStreamBYOBReader / ReadableStreamDefaultReader). It does
 * deliberately NOT swallow:
 *   - ERR_INVALID_THIS on any other brand (Map, Set, URL, other Node
 *     internals, a custom class) — those stay fatal.
 *   - ERR_INVALID_THIS whose message doesn't mention a reader type at all
 *     (e.g. a future refactor changes Node's wording) — fails closed
 *     (crashes) rather than silently widening the net.
 * If Node ever changes this error's wording, this guard undercorrects (still
 * crashes) rather than overcorrects (swallows something new) — that is the
 * intended failure mode for a narrow, judgement-call swallow.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isStreamReaderTeardownError(err) {
  if (!err || typeof err !== "object") return false;
  const e = /** @type {NodeJS.ErrnoException} */ (err);
  return e.code === "ERR_INVALID_THIS" && STREAM_READER_BRAND_RE.test(String(e.message));
}
/**
 * True when `node` alone (no cause traversal) is a request-scoped transport
 * failure: a client abort (see `isClientAbortError`), a sheddable transport
 * code (`ECONNREFUSED` / `PROXY_UNREACHABLE`), or a stream-reader teardown
 * race (`ERR_INVALID_THIS` on a WHATWG reader brand check).
 *
 * @param {unknown} node
 * @returns {boolean}
 */
function isRequestScopedNode(node) {
  if (!node || typeof node !== "object") return false;
  if (isClientAbortError(node)) return true;
  const e = /** @type {NodeJS.ErrnoException} */ (node);
  if (isSheddableTransportCode(e.code)) return true;
  if (isStreamReaderTeardownError(node)) return true;
  return false;
}
/**
 * Composes `isClientAbortError` (and the sheddable-transport-code / stream-
 * reader-teardown checks above) with a bounded, cycle-safe walk of the
 * `.cause` chain. This is the fix for the recurring bug class in this file's
 * history: every past incident (hedge-cancelled, request_signal_aborted,
 * DIRECT_RESPONSE_START_TIMEOUT) bolted on ONE more special case to
 * `isClientAbortError` because the classification only ever looked at the
 * error handed to it — never at what it wrapped. `proxyFetch`'s
 * `PROXY_UNREACHABLE` wrapper (code that matches nothing) around a genuine
 * `ECONNREFUSED` (`.cause`, which DOES match) is exactly that shape, and the
 * next wrapper library to come along will produce another one. Walking the
 * chain once, generically, closes the whole class instead of the one instance
 * in front of us.
 *
 * Depth is capped (default 5) and visited objects are tracked in a `Set` so a
 * self-referential or circular `.cause` chain terminates instead of hanging
 * or blowing the stack.
 *
 * `isClientAbortError` itself is left untouched (and still exported with its
 * original behaviour) so its existing callers/tests are unaffected; this
 * function is the new decision point for the process-level guard.
 *
 * @param {unknown} err
 * @param {{ maxDepth?: number }} [options]
 * @returns {boolean}
 */
export function isRequestScopedError(err, { maxDepth = 5 } = {}) {
  const seen = new Set();
  /** @type {unknown} */
  let node = err;
  let depth = 0;
  while (node && typeof node === "object" && depth < maxDepth) {
    if (seen.has(node)) break;
    seen.add(node);
    if (isRequestScopedNode(node)) return true;
    node = /** @type {NodeJS.ErrnoException} */ (node).cause;
    depth += 1;
  }
  return false;
}
/**
 * #12861: a recoverable upstream-fetch timeout that `proxyFetch.ts` already
 * retries on a fresh socket (see `open-sse/utils/directResponseStartTimeout.ts`).
 * A narrow timer/promise-settlement race can still deliver its abort reason to
 * a promise nobody is awaiting anymore, which otherwise surfaces here as an
 * unhandledRejection/uncaughtException — even though the retry path already
 * handles this exact condition and normally logs it as a plain 504.
 *
 * Kept as a bare string-code check (no import of the `.ts` source of truth)
 * because this file has to stay build-free/plain-JS-loadable — see the module
 * docstring. `DIRECT_RESPONSE_START_TIMEOUT_CODE` in
 * `open-sse/utils/directResponseStartTimeout.ts` is the canonical definition;
 * keep this string literal in sync with it.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRecoverableUpstreamTimeoutError(err) {
  // Same reason-shape tolerance as isIntentionalComboAbort: a bare string
  // reason rejects waiters with the string itself, not an Error object.
  if (err === "DIRECT_RESPONSE_START_TIMEOUT") return true;
  if (!err || typeof err !== "object") return false;
  return /** @type {NodeJS.ErrnoException} */ (err).code === "DIRECT_RESPONSE_START_TIMEOUT";
}

/**
 * Intentional combo-leg cancellation. When a combo dispatches hedged targets,
 * the losing legs are aborted with a distinctive reason once a sibling wins
 * (`hedge-cancelled`) or exceeds its per-model budget (`combo-per-model-timeout`)
 * — see `COMBO_HEDGE_CANCELLED_REASON` / `COMBO_PER_MODEL_TIMEOUT_REASON` in
 * `open-sse/services/combo/comboAbortReasons.ts` (bare literals duplicated here
 * because this file must stay build-free; keep in sync). On 2026-09-14 such a
 * cancellation escaped its promise chain and killed production with
 * `Error [AbortError]: hedge-cancelled` — the request it belonged to had
 * already completed 200 via the winning leg.
 *
 * Distinct from a *client* abort: only these exact reasons qualify, so an
 * AbortError from an unknown subsystem still crashes loudly.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isIntentionalComboAbort(err) {
  const reasons = new Set(["hedge-cancelled", "combo-per-model-timeout"]);
  // AbortSignal.reason is whatever was handed to abort(): a raw string
  // reason rejects waiters with the string itself, not an Error object.
  if (typeof err === "string") return reasons.has(err);
  if (!err || typeof err !== "object") return false;
  const e = /** @type {NodeJS.ErrnoException} */ (err);
  if (e.name !== "AbortError") return false;
  if (reasons.has(String(e.message))) return true;
  const cause = /** @type {{ cause?: unknown }} */ (err).cause;
  return typeof cause === "string" && reasons.has(cause);
}

/**
 * A network/IO failure against an upstream or its proxy — undici surfaces it
 * as `TypeError: fetch failed` (fixed message; the syscall code rides on
 * `cause`) or as an error carrying a `PROXY_UNREACHABLE` / `UND_ERR_*` code.
 * On 2026-09-14 one of these (`PROXY_UNREACHABLE` / ECONNRESET to
 * api.agnes-ai.cn) escaped as an uncaughtException and killed production.
 * The request that triggered the fetch already fails through the normal
 * error path; the stray copy delivered to nobody must not be process-fatal.
 *
 * The "fetch failed" message match is exact on purpose: it is undici's fixed
 * wrapping message, so arbitrary TypeErrors still crash loudly.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isUpstreamNetworkError(err) {
  if (!err || typeof err !== "object") return false;
  const e = /** @type {NodeJS.ErrnoException} */ (err);
  if (e.name === "TypeError" && e.message === "fetch failed") return true;
  switch (e.code) {
    case "PROXY_UNREACHABLE":
    case "UND_ERR_SOCKET":
    case "UND_ERR_CONNECT_TIMEOUT":
    case "UND_ERR_HEADERS_TIMEOUT":
    case "UND_ERR_BODY_TIMEOUT":
    case "ECONNREFUSED":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EAI_AGAIN":
      return true;
    default:
      return false;
  }
}

/**
 * Decide whether a process-level uncaughtException/unhandledRejection should be
 * swallowed (benign, request-scoped: a client abort, an upstream transport
 * failure, or a recoverable upstream timeout a retry path already handles —
 * #12861) or allowed to surface (genuine bug).
 *
 * Pure + exported so it can be unit-tested without poking process listeners.
 *
 * @param {unknown} err
 * @param {string | undefined} origin  Node's uncaughtException origin (e.g.
 *   "uncaughtException" / "unhandledRejection"); absent/empty for rejections.
 * @returns {boolean} true => swallow (log only), false => re-throw / let crash.
 */
export function shouldSwallowUncaught(err, origin) {
  if (
    !isRequestScopedError(err) &&
    !isRecoverableUpstreamTimeoutError(err) &&
    !isIntentionalComboAbort(err) &&
    !isUpstreamNetworkError(err)
  ) {
    return false;
  }
  // Only swallow when the origin matches what the guard installed for. If some
  // other subsystem raised it (e.g. a deliberate `throw` in a domain), keep the
  // existing crash semantics.
  return !origin || origin === "uncaughtException" || origin === "unhandledRejection";
}
/**
 * Attach `error` listeners to a request/response pair that swallow client-abort
 * errors. Idempotent per (req, res) pair via a Symbol flag.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
export function attachRequestStreamGuards(req, res) {
  const flag = Symbol.for("omniroute.requestAbortGuard");
  if (req[flag] || res[flag]) return;
  req[flag] = true;
  res[flag] = true;
  req.on("error", (err) => {
    if (!isClientAbortError(err)) {
      // Re-emit a genuine request error through the normal channel so it is
      // still observable in logs, but never as an uncaughtException.
      console.error("[server] request stream error:", err);
    }
  });
  res.on("error", (err) => {
    if (!isClientAbortError(err)) {
      console.error("[server] response stream error:", err);
    }
  });
}
let crashGuardInstalled = false;
/**
 * Install process-level safety nets. Idempotent. Benign, request-scoped
 * errors are logged once and swallowed; everything else is re-thrown on a
 * fresh stack so the process keeps its current crash semantics (genuine bugs
 * still crash/hang loudly, and a supervisor or test harness sees them).
 *
 * @param {(level: "warn" | "error", ...args: unknown[]) => void} [log]
 */
export function installProcessCrashGuard(log) {
  if (crashGuardInstalled) return;
  crashGuardInstalled = true;
  // `console` is an object, not a callable: `log ?? console` followed by
  // `logger("warn", ...)` throws TypeError and kills the process on the very
  // abort the guard exists to swallow. Default to console.warn as a function.
  const logger = typeof log === "function" ? log : console.warn.bind(console);
  process.prependListener("uncaughtException", (err, origin) => {
    if (shouldSwallowUncaught(err, origin)) {
      // The warn line is the only evidence a swallowed error ever happened;
      // pass the full error object so the stack survives.
      logger("warn", "[server] swallowed benign uncaughtException:", err);
      return;
    }
    throw err;
  });
  process.prependListener("unhandledRejection", (reason) => {
    if (shouldSwallowUncaught(reason, "unhandledRejection")) {
      logger("warn", "[server] swallowed benign unhandledRejection:", reason);
      return;
    }
    throw reason;
  });
}
