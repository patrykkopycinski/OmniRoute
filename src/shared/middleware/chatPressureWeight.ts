/**
 * Which chat requests may still be admitted once the process is under CRITICAL
 * resource pressure (`resourcePressurePolicy` severity `critical`).
 *
 * The pressure gates used to refuse EVERY chat request — including a 5-token
 * health ping that cannot meaningfully grow the heap. That blanket refusal is
 * what kills agent workers: they burn their retry budget on 503s while the
 * container's cgroup ceiling still has headroom above the V8 line that tripped
 * the guard. This module is the ONE definition of "small enough to admit under
 * pressure" — the pre-read admission gate (`chatBodyAdmission.admitChatRequest`)
 * and the post-parse provider-work guards (`checkResourcePressureGuard` via
 * `chatCore` / `chatHelpers` / `chat.ts`) all classify through here. Without a
 * shared definition, a small request admitted at the gate would still be 503'd
 * one layer up.
 *
 * A request is HEAVY — shed or queued, never admitted — when any KNOWN
 * dimension reaches its threshold: declared/serialized body bytes, message
 * count, tool count, or the conservative structure-token estimate. A request
 * whose weight cannot be established is also HEAVY: an undeclared (chunked)
 * body cannot be proven small, and the point of the guard is to bound the
 * allocation-heavy path rather than to guess.
 */

import { estimateStructureTokens } from "./chatAdmissionStructureEstimate";
import type { ChatPressureWeight } from "@omniroute/open-sse/utils/resourcePressurePolicy.ts";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Body size at/above which a request takes the heavyweight admission path. */
export const CHAT_LARGE_BODY_BYTES = parsePositiveInt(
  process.env.OMNIROUTE_CHAT_LARGE_BODY_BYTES,
  256 * 1024
);

export const CHAT_HEAVY_MESSAGE_COUNT = parsePositiveInt(
  process.env.OMNIROUTE_CHAT_HEAVY_MESSAGE_COUNT,
  200
);

export const CHAT_HEAVY_TOOL_COUNT = parsePositiveInt(
  process.env.OMNIROUTE_CHAT_HEAVY_TOOL_COUNT,
  64
);

export const CHAT_HEAVY_ESTIMATED_TOKENS = parsePositiveInt(
  process.env.OMNIROUTE_CHAT_HEAVY_ESTIMATED_TOKENS,
  32_000
);

/**
 * Canonical weight vocabulary lives beside the pressure policy
 * (`open-sse/utils/resourcePressurePolicy.ts`) because the open-sse pressure
 * guards exchange it too; re-exported here so admission-side callers import one
 * module.
 */
export type { ChatPressureWeight };

/** Thresholds that decide heavy vs light. Injectable so tests need no env wiring. */
export interface ChatPressureBounds {
  largeBodyBytes: number;
  heavyMessages: number;
  heavyTools: number;
  heavyTokens: number;
}

export const DEFAULT_CHAT_PRESSURE_BOUNDS: ChatPressureBounds = {
  largeBodyBytes: CHAT_LARGE_BODY_BYTES,
  heavyMessages: CHAT_HEAVY_MESSAGE_COUNT,
  heavyTools: CHAT_HEAVY_TOOL_COUNT,
  heavyTokens: CHAT_HEAVY_ESTIMATED_TOKENS,
};

/**
 * Every dimension a caller may know about a request. Only the ones actually
 * supplied count as evidence — see the module header for why "no evidence" is
 * HEAVY rather than light. `bodyBytes` is the declared `Content-Length` before
 * the body is read, and the serialized size afterwards.
 */
export interface ChatPressureFacts {
  bodyBytes?: number | null;
  messageCount?: number | null;
  toolCount?: number | null;
  tokens?: number | null;
}

export function classifyChatPressureWeight(
  facts: ChatPressureFacts,
  bounds: ChatPressureBounds = DEFAULT_CHAT_PRESSURE_BOUNDS
): ChatPressureWeight {
  if (facts.bodyBytes != null && facts.bodyBytes >= bounds.largeBodyBytes) return "heavy";
  if (facts.messageCount != null && facts.messageCount >= bounds.heavyMessages) return "heavy";
  if (facts.toolCount != null && facts.toolCount >= bounds.heavyTools) return "heavy";
  if (facts.tokens != null && facts.tokens >= bounds.heavyTokens) return "heavy";
  const hasEvidence =
    facts.bodyBytes != null ||
    facts.messageCount != null ||
    facts.toolCount != null ||
    facts.tokens != null;
  return hasEvidence ? "light" : "heavy";
}

/**
 * Extract the structure dimensions from a PARSED chat body (OpenAI
 * `messages`/`tools`, Responses `input`). Byte size is deliberately not derived
 * here: the caller knows it better than a re-serialization does (the admission
 * gate has the declared `Content-Length`, the provider-work guards sit on an
 * already-parsed body whose allocation cost has been paid).
 */
export function chatPressureFacts(
  body: unknown,
  bounds: ChatPressureBounds = DEFAULT_CHAT_PRESSURE_BOUNDS
): ChatPressureFacts {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  // Only a body that actually exposes the chat shape can be measured. Without
  // this, an unrecognized envelope (a `prompt`-style payload, a future
  // protocol) would report zero messages / zero tools / zero tokens and read as
  // LIGHT no matter how large it is — the exact opposite of what a pressure
  // guard wants. Unmeasurable ⇒ no facts ⇒ heavy.
  const hasChatShape =
    "messages" in record || "input" in record || Array.isArray(record.tools);
  if (!hasChatShape) return {};
  const messages = [record.messages, record.input].flat().filter((item) => item != null);
  const tools = Array.isArray(record.tools) ? record.tools : [];
  const messageEstimate = estimateStructureTokens(messages, bounds.heavyTokens);
  const toolEstimate = messageEstimate.exhausted
    ? { tokens: 0, exhausted: true }
    : estimateStructureTokens(tools, bounds.heavyTokens - messageEstimate.tokens);
  // An exhausted estimate means "at least `heavyTokens`" — pin it to the bound
  // instead of carrying a partial sum that would read as light.
  const tokens =
    messageEstimate.exhausted || toolEstimate.exhausted
      ? bounds.heavyTokens
      : Math.min(bounds.heavyTokens, messageEstimate.tokens + toolEstimate.tokens);
  return { messageCount: messages.length, toolCount: tools.length, tokens };
}

/** Weight of an already-parsed request body — the post-parse guards' entry point. */
export function classifyParsedRequestBodyWeight(
  body: unknown,
  bounds: ChatPressureBounds = DEFAULT_CHAT_PRESSURE_BOUNDS
): ChatPressureWeight {
  return classifyChatPressureWeight(chatPressureFacts(body, bounds), bounds);
}
