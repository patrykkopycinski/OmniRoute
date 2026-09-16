// #13627: composer kv_after_text soft-terminator race.
//
// Composer turns end speculatively on kv_after_text (Phase 8). Under load an
// exec_mcp frame can arrive in the same h2 buffer behind the KV checkpoint;
// settling immediately would splice it off as leftover bytes and drop the
// tool call entirely — client sees finish_reason:"stop", content:null, zero
// tool_calls (#10215 follow-up family, live-reproduced intermittently).
//
// Fix: kv_after_text is a *soft* terminator. If more bytes are already
// buffered when it fires, keep scanning instead of settling — a completing
// exec_mcp upgrades the turn to tool_calls. Only settle right away on a
// clean frame boundary. A bounded grace window (CURSOR_KV_GRACE_MS, default
// 2000ms) still ends the turn if nothing else completes, so plain-chat
// latency can't regress to the full stream safety timeout.

const KV_GRACE_MS = (() => {
  const parsed = parseInt(process.env.CURSOR_KV_GRACE_MS || "2000", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 2000;
})();

export interface KvGraceState {
  timer: NodeJS.Timeout | null;
}

export function createKvGraceState(): KvGraceState {
  return { timer: null };
}

export function clearKvGraceTimer(state: KvGraceState): void {
  if (state.timer) clearTimeout(state.timer);
}

export function shouldSettleNow(
  state: KvGraceState,
  endReason: string | undefined,
  nextFrameStarted: boolean,
  onExpire: () => void
): boolean {
  if (!endReason) return false;
  return !armOrShouldSettle(state, endReason, nextFrameStarted, onExpire);
}

/**
 * Decide whether the caller should keep waiting on `endReason` rather than
 * settle now. Returns true (and arms the grace timer, idempotently) when
 * `endReason` is the speculative "kv_after_text" terminator AND more bytes
 * are already buffered (`nextFrameStarted`) — the exact condition under
 * which an exec_mcp could still be sitting right behind the checkpoint.
 * `onExpire` fires once, after KV_GRACE_MS, if nothing else has settled by
 * then. Any other endReason (hard terminator, or kv_after_text with no
 * trailing bytes) returns false — the caller settles immediately, as
 * before this fix.
 */
function armOrShouldSettle(
  state: KvGraceState,
  endReason: string,
  nextFrameStarted: boolean,
  onExpire: () => void
): boolean {
  if (endReason === "kv_after_text" && nextFrameStarted) {
    if (!state.timer) state.timer = setTimeout(onExpire, KV_GRACE_MS);
    return true;
  }
  return false;
}
