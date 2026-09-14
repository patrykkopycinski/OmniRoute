/**
 * Per-combo-step request params — "one deployment, per-combo shapes".
 *
 * A combo model step may carry an optional `params` object that rewrites the
 * outbound request body for THAT step only: token caps, thinking control, and
 * arbitrary extra_body merges (e.g. SGLang `chat_template_kwargs`).
 *
 * Semantics (design contract, see tests/unit/combo-step-params.test.ts):
 *  - `params.maxTokens` — an UPPER BOUND. It clamps the client's max_tokens
 *    downward but never raises it. The client's explicit limit wins upward;
 *    per-step params only constrain (mirrors the #9507 never-enlarge contract).
 *  - `params.thinking: "off"` — disables thinking for step execution via the
 *    OpenAI-compatible `chat_template_kwargs.enable_thinking=false` body shape
 *    (SGLang/Qwen3 family). NOT `reasoning_effort` — SGLang ignores that knob
 *    entirely (live-verified 2026-09-14 against qwen3.8-27b cells).
 *  - `params.extraBody` — shallow-merged into `body.extra_body` (per-key,
 *    step value wins; client keys preserved otherwise).
 *  - `params.mergeReasoningIntoContent` — response-side: when a non-streaming
 *    same-format response comes back with empty `content` but non-empty
 *    `reasoning_content`, merge reasoning into content. Required for
 *    thinking-off SGLang requests: with thinking disabled the qwen3
 *    reasoning-parser classifies the WHOLE answer as reasoning_content
 *    (no `</think>` marker ever appears), so downstream readers would
 *    otherwise starve and retry-loop.
 *
 * Everything here is additive and off-by-default: a step without `params`
 * takes the exact pre-existing path (schema default = field absent).
 */

export type ComboStepParams = {
  maxTokens?: number;
  thinking?: "off";
  extraBody?: Record<string, unknown>;
  mergeReasoningIntoContent?: boolean;
};

const TEMPLATE_KWARGS = "chat_template_kwargs";

/** Apply per-step params to a per-attempt request body (copy-on-write safe:
 *  callers pass their per-attempt copy; we mutate it in place and return it). */
export function applyComboStepParams(
  body: Record<string, unknown>,
  params: ComboStepParams | null | undefined
): Record<string, unknown> {
  if (!params || typeof params !== "object") return body;

  // 1. Token cap — clamp-down-only, never enlarge.
  if (typeof params.maxTokens === "number" && params.maxTokens > 0) {
    const current = body.max_tokens ?? body.max_completion_tokens;
    // No client limit set: impose the step cap so generation cannot outrun
    // every downstream timer (the 64k-default memory-extraction class).
    if (current == null) {
      body.max_tokens = params.maxTokens;
    } else if (typeof current === "number" && current > params.maxTokens) {
      if (body.max_tokens != null) body.max_tokens = params.maxTokens;
      else body.max_completion_tokens = params.maxTokens;
    }
  }

  // 2. Thinking off — SGLang chat_template_kwargs, never reasoning_effort.
  if (params.thinking === "off") {
    const extra = (body.extra_body as Record<string, unknown> | undefined) ?? {};
    const kwargs = (extra[TEMPLATE_KWARGS] as Record<string, unknown> | undefined) ?? {};
    kwargs.enable_thinking = false;
    extra[TEMPLATE_KWARGS] = kwargs;
    body.extra_body = extra;
    // Drop any client effort knob for this step: an explicit effort on the body
    // could re-enable provider-side thinking on effort-aware upstreams.
    delete body.reasoning_effort;
  }

  // 3. Arbitrary extra_body merge — step value wins per key.
  if (params.extraBody && typeof params.extraBody === "object") {
    const extra = (body.extra_body as Record<string, unknown> | undefined) ?? {};
    for (const [k, v] of Object.entries(params.extraBody)) {
      if (v !== undefined) extra[k] = v;
    }
    body.extra_body = extra;
  }

  return body;
}

/**
 * Response-side guard: merge reasoning into content when content is empty.
 * Only applies when the step opted in via `mergeReasoningIntoContent` AND the
 * parsed non-streaming response carries the reasoning_content shape.
 * Returns the (possibly new) message object; null = not applicable.
 */
export function mergeReasoningIntoContentIfEmpty(
  parsed: { content?: unknown; reasoning_content?: unknown } | null | undefined,
  enabled: boolean | undefined
): Record<string, unknown> | null {
  if (!enabled || !parsed || typeof parsed !== "object") return null;
  const content = parsed.content;
  const reasoning = parsed.reasoning_content;
  const contentEmpty = content == null || (typeof content === "string" && content.trim() === "");
  const reasoningPresent = typeof reasoning === "string" && reasoning.trim().length > 0;
  if (!contentEmpty || !reasoningPresent) return null;
  const merged: Record<string, unknown> = { ...parsed, content: reasoning };
  delete merged.reasoning_content;
  return merged;
}

/**
 * Response-side guard for per-step params: on a successful NON-streaming
 * response, when the step opted into mergeReasoningIntoContent and the parsed
 * body has empty content + non-empty reasoning_content, return a re-wrapped
 * Response with reasoning merged into content. Otherwise returns the original.
 *
 * Trap this exists for (live-verified 2026-09-14, qwen3.8-27b cells with
 * --reasoning-parser qwen3-thinking): with enable_thinking=false no
 * </think> marker ever appears, so the parser classifies the WHOLE answer as
 * reasoning_content and content comes back empty — downstream readers starve
 * and retry-loop. Merging keeps them fed without touching the translator
 * (same-format openai→openai responses pass through untouched by design).
 */
export async function applyComboStepResponseGuards(
  result: Response,
  params: ComboStepParams | null | undefined,
  clientRequestedStream: boolean
): Promise<Response> {
  if (!params?.mergeReasoningIntoContent) return result;
  if (clientRequestedStream) return result;
  if (!result || typeof result.json !== "function") return result;
  const ct = result.headers?.get?.("content-type") || "";
  if (!ct.includes("application/json")) return result;
  let parsed: unknown;
  try {
    parsed = await result.json();
  } catch {
    return result; // not JSON — leave untouched
  }
  const record = parsed as Record<string, unknown> | null;
  const choices = record?.choices as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0]?.message as
    { content?: unknown; reasoning_content?: unknown } | undefined;
  const merged = mergeReasoningIntoContentIfEmpty(choice, true);
  if (!merged || !choices) return result;
  choices[0].message = merged;
  return new Response(JSON.stringify(parsed), {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
}
