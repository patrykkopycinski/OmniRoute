/**
 * kimiToolCallNarration.ts — recover structured tool calls from Kimi models
 * that mimic the executor's own history-narration format instead of emitting
 * a native Cursor tool call.
 *
 * Root cause
 * ----------
 * Cursor's agent API accepts ONE user message per Run, so `flattenMessages`
 * (cursorAgentProtobuf.ts) serializes prior `assistant.tool_calls` into plain
 * text for the model to read as context:
 *
 *     Assistant called tool <name> (<id>) with arguments: <json>
 *
 * Kimi-k3 / kimi-k3-high imitate that narration when they decide to call a
 * tool. Instead of a structured tool call the model emits the narration as
 * visible text, appends the complete JSON arguments, then closes with its
 * native generation-grammar delimiters:
 *
 *     <|close|>argument<|sep|><|close|>call<|sep|><|close|>tools<|sep|>
 *
 * Cursor's protobuf backend passes the whole thing through verbatim as text
 * with `finish_reason: "stop"`. The client then renders the raw narration
 * plus delimiters instead of a tool card, and — because the bad turn is
 * re-sent in history — the leak compounds on every subsequent turn.
 *
 * This module detects that narration + delimiter tail and converts it into a
 * structured OpenAI `tool_calls` entry so the leak never reaches the client.
 */

export interface RecoveredToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface NarrationRecoveryResult {
  /** Visible content with the narration line and delimiter tail removed. */
  content: string;
  toolCalls: RecoveredToolCall[];
}

// The narration line that flattenMessages emits for prior assistant tool
// calls. Kimi reproduces it verbatim when it wants to call a tool. The id is
// wrapped in parens and may itself contain parens (the "(unknown)" placeholder
// is emitted as "((unknown))"), so the id group tolerates one nested level.
const NARRATION_RE =
  /Assistant called tool ([\w.\-:]+) \(((?:[^()]|\([^()]*\))*)\) with arguments: /;

// A single fragment of the Kimi closing grammar: a delimiter token
// (<|close|> / <|sep|>) or one of the grammar keywords that sit between
// delimiter tokens (argument / call / tools / name).
const TAIL_FRAGMENT = "<\\|(?:close|sep)\\|>|argument|call|tools|name";

// Matches the whole closing-grammar chain wherever it appears (used when the
// delimiters sit mid-string, before residual trailing prose).
const DELIM_CHAIN_RE = new RegExp("(?:\\s*(?:" + TAIL_FRAGMENT + "))+", "gu");

// Balanced-JSON scan: starting at `start`, return the end index (exclusive) of
// the first complete {...} object, honoring strings and escapes. -1 if the
// object never closes (truncated).
function scanJsonObjectEnd(text: string, start: number): number {
  if (text[start] !== "{") return -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Attempt to recover tool calls from Kimi narration text.
 * Returns null when the text does not match the narration shape (caller leaves
 * the response untouched).
 */
export function recoverKimiToolCallNarration(text: string): NarrationRecoveryResult | null {
  if (!text) return null;
  const m = NARRATION_RE.exec(text);
  if (!m) return null;

  const jsonStart = m.index + m[0].length;
  const jsonEnd = scanJsonObjectEnd(text, jsonStart);
  if (jsonEnd < 0) return null; // truncated arguments — nothing reliable to emit

  const argsJson = text.slice(jsonStart, jsonEnd);
  try {
    JSON.parse(argsJson);
  } catch {
    return null;
  }

  // Everything after the JSON: remove the delimiter-grammar chain wherever it
  // appears (the model may append trailing prose after the delimiters).
  const rawTail = text.slice(jsonEnd);
  const tail = rawTail.replace(DELIM_CHAIN_RE, " ").replace(/\s+/gu, " ").trim();

  // Visible content = prose before the narration line, plus any residual
  // non-delimiter tail text.
  const before = text.slice(0, m.index).replace(/[\s\n]+$/u, "");
  const content = tail ? (before ? before + "\n" + tail : tail) : before;

  const name = m[1];
  const rawId = m[2];
  const id = rawId && rawId !== "(unknown)" && rawId !== "unknown" ? rawId : genId();

  return {
    content,
    toolCalls: [{ id, type: "function", function: { name, arguments: argsJson } }],
  };
}

function genId(): string {
  return "call_" + Math.random().toString(36).slice(2, 14);
}
