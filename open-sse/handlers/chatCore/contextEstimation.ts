import { adaptBodyForCompression } from "../../services/compression/bodyAdapter.ts";
import { estimateTokens } from "../../services/contextManager.ts";
import {
  applyEstimatorCalibration,
  recordEstimatorCalibrationFromUsage,
} from "../../services/estimatorCalibration.ts";

type JsonRecord = Record<string, unknown>;

function asJsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

/**
 * Chars-per-token divisor for the pre-dispatch input gate. Measured agent
 * bodies (JSON-serialized messages + tools, code-heavy) tokenize at 3.27–3.83
 * chars/token against a Qwen3 tokenizer, so the generic char/4 estimate
 * undercounts by up to ~1.22x. The divisor must be <= 3.268 so the densest
 * measured body (118,318 real tokens, jsonLen 386,749) is not undercounted, and
 * >= 3.223 so that same body still fits a 120k cap on a cold calibration factor.
 * 3.25 sits inside that window.
 */
export const GATE_CHARS_PER_TOKEN = 3.25;

const COMPRESS_CHARS_PER_TOKEN = 4; // units compressContext/estimateTokens default to

/** Gate divisor, overridable via OMNIROUTE_GATE_CHARS_PER_TOKEN (finite, in [1, 8]). Read per call. */
export function getGateCharsPerToken(): number {
  const raw = process.env.OMNIROUTE_GATE_CHARS_PER_TOKEN;
  if (raw === undefined || raw.trim() === "") return GATE_CHARS_PER_TOKEN;
  // Number(raw) for strict parsing: parseFloat would accept "3.25abc" as 3.25.
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 8 ? parsed : GATE_CHARS_PER_TOKEN;
}

/**
 * Convert a budget expressed in gate (dense) tokens into the char/4 units
 * compressContext measures against. Floors, so compaction never under-shoots
 * the gate budget.
 */
export function gateBudgetToCompressionTokens(gateBudgetTokens: number): number {
  return Math.floor((gateBudgetTokens * getGateCharsPerToken()) / COMPRESS_CHARS_PER_TOKEN);
}

export type FinalInputTokenBreakdown = {
  messages: number;
  tools: number;
  system: number;
  instructions: number;
  total: number;
};

export function estimateFinalInputTokenBreakdown(
  requestBody: JsonRecord | null | undefined
): FinalInputTokenBreakdown {
  const adapted = requestBody ? adaptBodyForCompression(requestBody).body : null;
  const nestedRequest = asJsonRecord(requestBody?.request);
  const messages =
    adapted?.messages ||
    requestBody?.contents ||
    nestedRequest?.contents ||
    (Array.isArray(requestBody?.input)
      ? requestBody.input
      : requestBody?.input && typeof requestBody.input === "object"
        ? requestBody.input
        : []);
  const divisor = getGateCharsPerToken();
  const breakdown = {
    messages: estimateTokens(messages, divisor),
    tools: Array.isArray(requestBody?.tools) ? estimateTokens(requestBody.tools, divisor) : 0,
    system: estimateTokens(requestBody?.system, divisor),
    instructions: estimateTokens(requestBody?.instructions, divisor),
  };
  return { ...breakdown, total: Object.values(breakdown).reduce((sum, value) => sum + value, 0) };
}

export function estimateFinalInputTokens(requestBody: JsonRecord | null | undefined): number {
  return estimateFinalInputTokenBreakdown(requestBody).total;
}

function toolsPresentIn(requestBody: JsonRecord | null | undefined): boolean {
  const tools = requestBody?.tools;
  return Array.isArray(tools) && tools.length > 0;
}

/**
 * #14931: the raw gate estimate (chars / GATE_CHARS_PER_TOKEN) scaled by the learned actual/estimated
 * ratio for this provider/model × tools shape (services/estimatorCalibration).
 * The factor is 1.0 on cold start, so callers see the raw estimate until
 * trusted observations exist. Sits next to estimateFinalInputTokens so the
 * calibrated and raw numbers share one code path (same breakdown, same basis).
 *
 * `precomputedBreakdown` lets a caller that already computed the breakdown for
 * this exact body snapshot (chatCore reuses it for the tools reserve and the
 * compaction log) skip the re-scan. It must belong to the same requestBody —
 * a stale snapshot silently shifts the context guard.
 */
export function estimateCalibratedFinalInputTokens(
  requestBody: unknown,
  provider: string | null | undefined,
  model: string | null | undefined,
  precomputedBreakdown?: FinalInputTokenBreakdown
): number {
  const record = asJsonRecord(requestBody);
  const estimated = precomputedBreakdown
    ? precomputedBreakdown.total
    : estimateFinalInputTokens(record);
  if (estimated <= 0) return estimated;
  return applyEstimatorCalibration(provider, model, estimated, toolsPresentIn(record));
}

/**
 * #14931: pair a guard-acted estimate with the provider's own prompt_tokens so
 * the calibration keeps learning. Thin adapter so the streaming and
 * non-streaming completion paths share one call shape; a no-op when the usage
 * carries no token count or the observation is rejected by the service.
 */
export function recordFinalInputCalibration(
  requestBody: unknown,
  provider: string | null | undefined,
  model: string | null | undefined,
  estimatedTokens: number,
  usage: unknown,
  aggregatedUsage = false
): void {
  recordEstimatorCalibrationFromUsage({
    provider,
    model,
    estimatedTokens,
    usage,
    toolsPresent: toolsPresentIn(asJsonRecord(requestBody)),
    aggregatedUsage,
  });
}
