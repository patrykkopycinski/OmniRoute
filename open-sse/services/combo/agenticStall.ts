/**
 * Agentic-stall failover guard (kanban t_1ebaf474).
 *
 * Live defect: some providers (confirmed: devin/swe-2-max; same symptom from
 * openrouter/deepseek-v4-pro-0813 in Hermes session 20260910_093408_0934ad)
 * answer a MID-AGENTIC-TURN request — tools present, conversation tail a tool
 * result — with `finish: stop` + a summary/narration as content and ZERO tool
 * calls. Agent harnesses (Hermes, Cursor) read stop+no-tool-call as turn-over;
 * the user re-prompts "continue"; the model summarizes again — an infinite
 * loop with zero progress. Every quality gate passes the response because it
 * is a syntactically valid, non-empty completion.
 *
 * Classification (ALL required, conservative — a false positive costs one
 * retry, a false negative costs the loop):
 *  1. The request had `tools` AND the conversation tail is a tool result
 *     (OpenAI: last message role "tool"; Anthropic: last user message carries
 *     a tool_result block) — i.e. a tool call was expected next.
 *  2. The response finished with stop ("stop" / "end_turn") and contains NO
 *     tool calls.
 *  3. The text content matches the stall shape: a summary/narration block
 *     (`<summary>…`, `# Summary`, `Summary: …`) or short structureless prose
 *     with no actionable payload ("Nothing to save.").
 *
 * The guard is provider-agnostic: it keys on request/response SHAPE, never on
 * model id (same lesson as the kimiToolCallNarration recovery — a model-id
 * gate silently skips every future imitator).
 *
 * The classifier reads the response via clone() ONLY — never disturbs the
 * body the client pipeline still needs (same contract as
 * applyComboStepResponseGuards). It must NEVER throw or break the request
 * path: every failure mode returns null (not a stall).
 *
 * Kill switch: OMNIROUTE_AGENTIC_STALL_FAILOVER=0 disables classification
 * (default: enabled).
 */

export const AGENTIC_STALL_SIGNATURE = "agentic_stall_no_toolcall";

/** Cap on bytes read from a cloned body while classifying — a pathological
 *  multi-MB stream must not stall the combo loop on inspection. */
const MAX_STALL_INSPECT_BYTES = 1024 * 1024;

export function isAgenticStallFailoverEnabled(): boolean {
  return process.env.OMNIROUTE_AGENTIC_STALL_FAILOVER !== "0";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Condition 1: tools were offered AND the conversation tail is a tool result,
 * so the next model action was expected to be a tool call (or a substantive
 * answer informed by one) — not a bare summary.
 */
export function requestExpectsToolCall(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return false;
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (!isRecord(last)) return false;
  // OpenAI chat shape: tool results arrive as role:"tool" messages.
  if (last.role === "tool") return true;
  // Anthropic shape: tool results are tool_result blocks inside a user message.
  if (last.role === "user" && Array.isArray(last.content)) {
    return last.content.some((blk) => isRecord(blk) && blk.type === "tool_result");
  }
  return false;
}

/** Summary/narration openers observed in the wild ("<summary>…" context-
 *  compaction blocks, markdown "Summary" headings, "Summary: …" prose). */
const SUMMARY_PREFIX =
  /^\s*(?:<summary[\s>]|#{1,6}\s+(?:conversation\s+|context\s+)?summary\b|summary\s*[:—–-])/i;

/** Structure that marks a substantive answer (code, lists, tables, headings).
 *  Its presence keeps the short-prose heuristic from firing. */
const STRUCTURE_MARKERS = /```|^\s*(?:[-*•+]|\d+[.)])\s|^\s*#{1,6}\s|\|\s*-{2,}/m;

/** Max length for the "short structureless narration" branch ("Nothing to
 *  save." — 16 chars). Kept small: longer prose is a legitimate final answer
 *  unless it opens as a summary. */
const SHORT_NARRATION_MAX_CHARS = 240;

/** Terminal blocked-state openers: the model did its tool work and is reporting
 *  a genuine blocker as its final answer ("Blocked: #291310 still OPEN...",
 *  "Cannot proceed — CI red"). This is turn-over BY DESIGN, not a stall;
 *  failing over re-runs the same blocked task on the next member and each
 *  member re-verifies and re-reports (live: 3 members × gh verification on
 *  elastic/kibana#291310, 2026-09-16). Exempt before the short-prose branch. */
const BLOCKED_STATE_OPENER =
  /^\s*(?:still\s+|attempt\s+\d+[^\w\s]*(?:\s+blocked)?[.:]?\s+|blocked\s+again[.:]?\s+|blocked[.:,\s]|cannot\s+proceed[\s:—–-]|unable\s+to\s+(?:proceed|continue|complete)[\s:—–-]|no\s+(?:path|way)\s+forward[\s:—–-])/i;

export function contentLooksLikeStallNarration(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  if (SUMMARY_PREFIX.test(t)) return true;
  if (BLOCKED_STATE_OPENER.test(t)) return false; // terminal answer, not a stall
  if (t.length <= SHORT_NARRATION_MAX_CHARS && !STRUCTURE_MARKERS.test(t) && !t.includes("\n\n")) {
    return true;
  }
  return false;
}

type StallSignal = {
  finishReason: string | null;
  hasToolCalls: boolean;
  text: string;
};

function extractFromOpenAiJson(parsed: unknown): StallSignal | null {
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return null;
  const choice = parsed.choices[0];
  if (!isRecord(choice)) return null;
  const message = isRecord(choice.message) ? choice.message : null;
  const toolCalls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  let text = "";
  if (message) {
    if (typeof message.content === "string") text = message.content;
    else if (Array.isArray(message.content)) {
      text = message.content
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("");
    }
  }
  return {
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    hasToolCalls: toolCalls.length > 0,
    text,
  };
}

function extractFromAnthropicJson(parsed: unknown): StallSignal | null {
  if (!isRecord(parsed) || !Array.isArray(parsed.content)) return null;
  if (parsed.type !== "message" && typeof parsed.stop_reason !== "string") return null;
  let text = "";
  let hasToolCalls = false;
  for (const blk of parsed.content) {
    if (!isRecord(blk)) continue;
    if (blk.type === "tool_use") hasToolCalls = true;
    if (blk.type === "text" && typeof blk.text === "string") text += blk.text;
  }
  return {
    finishReason: typeof parsed.stop_reason === "string" ? parsed.stop_reason : null,
    hasToolCalls,
    text,
  };
}

/** Assemble the terminal assistant message from a buffered SSE payload,
 *  handling both OpenAI chat chunks and Anthropic message events. Returns
 *  null when nothing recognizable was seen (cannot classify). */
function extractFromSse(payload: string): StallSignal | null {
  let finishReason: string | null = null;
  let hasToolCalls = false;
  let text = "";
  let recognized = false;
  for (const rawLine of payload.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    // OpenAI chat chunks.
    if (Array.isArray(parsed.choices)) {
      const choice = parsed.choices[0];
      if (isRecord(choice)) {
        recognized = true;
        const delta = isRecord(choice.delta) ? choice.delta : null;
        if (delta) {
          if (typeof delta.content === "string") text += delta.content;
          if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
            hasToolCalls = true;
          }
        }
        if (typeof choice.finish_reason === "string" && choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
      continue;
    }
    // Anthropic message events.
    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type === "content_block_start") {
      recognized = true;
      const block = isRecord(parsed.content_block) ? parsed.content_block : null;
      if (block && block.type === "tool_use") hasToolCalls = true;
    } else if (type === "content_block_delta") {
      recognized = true;
      const delta = isRecord(parsed.delta) ? parsed.delta : null;
      if (delta && delta.type === "text_delta" && typeof delta.text === "string") {
        text += delta.text;
      }
    } else if (type === "message_delta") {
      recognized = true;
      const delta = isRecord(parsed.delta) ? parsed.delta : null;
      if (delta && typeof delta.stop_reason === "string" && delta.stop_reason) {
        finishReason = delta.stop_reason;
      }
    } else if (type === "message_start" || type === "message_stop") {
      recognized = true;
    }
  }
  if (!recognized) return null;
  return { finishReason, hasToolCalls, text };
}

async function readClonedBodyText(clone: Response): Promise<string | null> {
  try {
    if (!clone.body) return null;
    const reader = clone.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        bytes += value.byteLength;
        if (bytes > MAX_STALL_INSPECT_BYTES) {
          await reader.cancel().catch(() => {});
          return null; // too large to safely classify — treat as not-a-stall
        }
        text += decoder.decode(value, { stream: true });
      }
    }
    text += decoder.decode();
    return text;
  } catch {
    return null;
  }
}

export type AgenticStallVerdict = {
  signature: typeof AGENTIC_STALL_SIGNATURE;
  detail: string;
};

/**
 * Classify a successful (HTTP 200, quality-valid) combo-member response as an
 * agentic stall. Returns the verdict (with a log/audit-safe detail string —
 * no credentials, no full bodies) or null when the response is fine or cannot
 * be classified. Never throws.
 */
export async function classifyAgenticStallResponse(args: {
  body: unknown;
  response: Response;
}): Promise<AgenticStallVerdict | null> {
  try {
    if (!isAgenticStallFailoverEnabled()) return null;
    const { body, response } = args;
    if (!requestExpectsToolCall(body)) return null;
    if (!response || typeof response.clone !== "function") return null;
    let clone: Response;
    try {
      clone = response.clone();
    } catch {
      return null;
    }
    const ct = clone.headers?.get?.("content-type") || "";
    let signal: StallSignal | null = null;
    if (ct.includes("text/event-stream")) {
      const text = await readClonedBodyText(clone);
      if (text == null) return null;
      signal = extractFromSse(text);
    } else if (ct.includes("application/json")) {
      let parsed: unknown;
      try {
        parsed = await clone.json();
      } catch {
        return null;
      }
      signal = extractFromOpenAiJson(parsed) ?? extractFromAnthropicJson(parsed);
    } else {
      return null;
    }
    if (!signal) return null;
    const finish = (signal.finishReason || "").toLowerCase();
    if (finish !== "stop" && finish !== "end_turn") return null;
    if (signal.hasToolCalls) return null;
    if (!contentLooksLikeStallNarration(signal.text)) return null;
    const head = signal.text.trim().slice(0, 120).replace(/\s+/g, " ");
    return {
      signature: AGENTIC_STALL_SIGNATURE,
      detail: `finish=${signal.finishReason}, no tool_calls on tool-result tail, narration="${head}"`,
    };
  } catch {
    return null;
  }
}
