/**
 * Parsing for the openai→cursor translator's converted tool-result form.
 *
 * `translator/request/openai-to-cursor.ts` deliberately represents tool outputs
 * as `<tool_result>` TEXT BLOCKS inside user messages rather than as protobuf
 * `tool_results` (its header documents why: the protobuf form made cursor loop).
 * That conversion runs before the executor, so by the time a request reaches
 * `open-sse/executors/cursor.ts` the original `role:"tool"` message is no longer
 * last, and a naive `lastMessage.role === "tool"` check can never fire.
 *
 * Lives in its own module because `cursorAgentProtobuf.ts` is at its frozen
 * file-size baseline (scripts/check/check-file-size.mjs) and may only shrink.
 *
 * INLINE RESUME IS ON BY DEFAULT (set OMNIROUTE_CURSOR_INLINE_RESUME=0 to disable):
 * an earlier 2026-08-24 run concluded the resumed h2 stream wedged (no bytes for
 * ~180s). That was re-tested on 2026-08-25 against live cursor-grok-4.6 with the
 * gate on and did NOT reproduce: `sendToolResult` wrote the ExecMcpResult frame and
 * cursor answered with 206 inbound frames. Four consecutive tool follow-ups resumed
 * inline in 3.7-7.4s, and a 40-turn history resumed in 7.5-8.2s. The earlier hang
 * was not reproducible and the wedge hypothesis is retired.
 */

/**
 * Inverse of the translator's `escapeXml` (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`).
 * `&amp;` is decoded last so an escaped `&amp;lt;` survives as the literal `&lt;`.
 */
export function unescapeXml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * Parse the converted form back out so the executor can still recognise a tool
 * follow-up and reuse the open h2 session. Returns the tool_call_id/result pairs
 * carried by a converted user message, or an empty array when this is not one.
 */
export function parseConvertedToolResults(
  content: unknown
): Array<{ toolCallId: string; result: string }> {
  if (typeof content !== "string" || !content.includes("<tool_result>")) return [];
  const out: Array<{ toolCallId: string; result: string }> = [];
  const blocks = content.matchAll(/<tool_result>([\s\S]*?)<\/tool_result>/g);
  for (const [, block] of blocks) {
    const toolCallId = block.match(/<tool_call_id>([\s\S]*?)<\/tool_call_id>/)?.[1] ?? "";
    const result = block.match(/<result>([\s\S]*?)<\/result>/)?.[1] ?? "";
    if (toolCallId) out.push({ toolCallId: unescapeXml(toolCallId), result: unescapeXml(result) });
  }
  return out;
}

/**
 * Collect every tool result carried by a request, in both shapes: raw OpenAI
 * `role:"tool"` messages and the translator's converted `<tool_result>` blocks.
 */
export function collectPendingToolResults(
  messages: Array<{ role?: string; content?: unknown; tool_call_id?: string }>,
  converted: Array<{ toolCallId: string; result: string }>
): Array<{ toolCallId: string; result: string }> {
  const pending: Array<{ toolCallId: string; result: string }> = [];
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    pending.push({
      toolCallId: msg.tool_call_id ?? "",
      result: typeof msg.content === "string" ? msg.content : "",
    });
  }
  pending.push(...converted);
  return pending;
}
