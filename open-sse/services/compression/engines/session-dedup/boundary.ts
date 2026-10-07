// open-sse/services/compression/engines/session-dedup/boundary.ts
/**
 * Current-turn boundary (t_f53bc5fd), shared by the exact-dedup pass
 * (index.ts) and the fuzzy pass (fuzzy.ts) so the two can never drift apart.
 *
 * The latest real user message and everything after it (assistant tool calls,
 * tool results) belong to the live turn and are never dedup-eligible.
 * Tool-result messages arrive as role:"user" with only tool_result parts —
 * they are current-turn traffic, not a new user turn, so they do not move
 * the boundary.
 */

type MessageLike = { role?: string; content?: unknown; [key: string]: unknown };

export function isToolResultMsg(m: MessageLike): boolean {
  return (
    Array.isArray(m.content) &&
    m.content.length > 0 &&
    m.content.every((p) => p && (p as Record<string, unknown>)["type"] === "tool_result")
  );
}

/** Index of the latest real user message, or -1 when there is none. */
export function currentTurnBoundary(messages: MessageLike[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && !isToolResultMsg(messages[i])) {
      return i;
    }
  }
  return -1;
}
