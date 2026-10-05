/**
 * Input-aware tier router (Laya / JEV classifier → named combo), in-process.
 *
 * Ported verbatim from the standalone `laya-router` sidecar
 * (https://github.com/patrykkopycinski/laya-router, `laya-router.py`):
 * a 3-class head (reasoning / coding / fast) over frozen Laya English encoder
 * CLS embeddings. This module owns the **client** half only — the classifier
 * itself stays a provider-abstract HTTP contract so JEV (or any other model)
 * can replace Laya behind the same endpoint without touching OmniRoute:
 *
 *   POST  {CLASSIFY_URL}   {"state": "<classifier input string>"}
 *   200   {"tier": "reasoning|coding|fast", "confidence": 0.0-1.0,
 *          "probabilities": [p_reasoning, p_coding, p_fast],
 *          "fallback": boolean}
 *
 * Safety contract (non-negotiable, mirrors the sidecar):
 *  - CLOSED SET: a tier maps to a literal allowlist of named combos
 *    (`reasoning→best-reasoning-paid`, `coding→best-coding-paid`, `fast→fast`).
 *    `auto/*` is rejected — Laya picks the TIER (which combo), the combo's own
 *    scorer picks the model.
 *  - Any failure (unknown tier, confidence below the per-tier floor, empty
 *    state, non-2xx, timeout, malformed body) falls back to the default combo.
 *    A gateway request to the virtual router model is always rewritten — it must
 *    never be forwarded with the virtual name and become a black hole.
 *
 * Flag-gated by `MODEL_ROUTER_INPROCESS` (default OFF): with the flag off this
 * module is never consulted and routing is byte-identical to today.
 */

import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";
import * as log from "../utils/logger";

export const MODEL_ROUTER_INPROCESS_FLAG = "MODEL_ROUTER_INPROCESS";

export type ModelRouterTier = "reasoning" | "coding" | "fast";

export const MODEL_ROUTER_TIERS: readonly ModelRouterTier[] = ["reasoning", "coding", "fast"];

/** Tier → named combo (closed set). Ported verbatim from the sidecar. */
export const DEFAULT_TIER_COMBOS: Readonly<Record<ModelRouterTier, string>> = {
  reasoning: "best-reasoning-paid",
  coding: "best-coding-paid",
  fast: "fast",
};

/** Per-tier confidence floors. Ported verbatim from the sidecar (fast 0.45). */
export const DEFAULT_MIN_CONFIDENCE: Readonly<Record<ModelRouterTier, number>> = {
  reasoning: 0.6,
  coding: 0.6,
  fast: 0.45,
};

export const DEFAULT_CLASSIFY_URL = "http://127.0.0.1:20770/classify";
export const DEFAULT_VIRTUAL_MODEL = "laya-router";
export const DEFAULT_STATE_CHARS = 6000;
export const DEFAULT_TIMEOUT_MS = 2500;

export interface ModelRouterConfig {
  classifyUrl: string;
  virtualModel: string;
  tierCombos: Record<ModelRouterTier, string>;
  defaultCombo: string;
  minConfidence: Record<ModelRouterTier, number>;
  stateChars: number;
  timeoutMs: number;
}

export interface ClassifyResult {
  tier: ModelRouterTier;
  confidence: number;
  probabilities?: number[];
  fallback: boolean;
}

export interface TierSelection {
  combo: string;
  tier: ModelRouterTier;
  confidence: number;
  /** True when the tier/confidence gate (or a failure) forced the default combo. */
  fallback: boolean;
  reason: "classified" | "low_confidence" | "classify_failed" | "invalid_combo";
}

type Env = Record<string, string | undefined>;

function envString(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
}

function envNumber(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Reject anything outside the closed set of named combos. `auto/*` is refused
 * because the classifier picks the tier, never the model.
 */
function sanitizeCombo(value: string, fallback: string): string {
  if (!value || value.startsWith("auto/")) return fallback;
  return value;
}

export function resolveModelRouterConfig(env: Env = process.env): ModelRouterConfig {
  const tierCombos: Record<ModelRouterTier, string> = {
    reasoning: sanitizeCombo(
      envString(env, "MODEL_ROUTER_COMBO_REASONING", DEFAULT_TIER_COMBOS.reasoning),
      DEFAULT_TIER_COMBOS.reasoning
    ),
    coding: sanitizeCombo(
      envString(env, "MODEL_ROUTER_COMBO_CODING", DEFAULT_TIER_COMBOS.coding),
      DEFAULT_TIER_COMBOS.coding
    ),
    fast: sanitizeCombo(
      envString(env, "MODEL_ROUTER_COMBO_FAST", DEFAULT_TIER_COMBOS.fast),
      DEFAULT_TIER_COMBOS.fast
    ),
  };
  const defaultCombo = sanitizeCombo(
    envString(env, "MODEL_ROUTER_DEFAULT_COMBO", tierCombos.coding),
    tierCombos.coding
  );

  // A single env value overrides every tier floor (identical to the sidecar's
  // LAYA_MIN_CONFIDENCE behaviour); otherwise the ported per-tier defaults hold.
  const minConfidence: Record<ModelRouterTier, number> = {
    reasoning: DEFAULT_MIN_CONFIDENCE.reasoning,
    coding: DEFAULT_MIN_CONFIDENCE.coding,
    fast: DEFAULT_MIN_CONFIDENCE.fast,
  };
  const floorOverride = env.MODEL_ROUTER_MIN_CONFIDENCE;
  if (floorOverride !== undefined && floorOverride.trim() !== "") {
    const parsed = Number(floorOverride);
    if (Number.isFinite(parsed) && parsed >= 0) {
      for (const tier of MODEL_ROUTER_TIERS) minConfidence[tier] = parsed;
    }
  }

  return {
    classifyUrl: envString(env, "MODEL_ROUTER_CLASSIFY_URL", DEFAULT_CLASSIFY_URL),
    virtualModel: envString(env, "MODEL_ROUTER_VIRTUAL_MODEL", DEFAULT_VIRTUAL_MODEL),
    tierCombos,
    defaultCombo,
    minConfidence,
    stateChars: Math.floor(envNumber(env, "MODEL_ROUTER_STATE_CHARS", DEFAULT_STATE_CHARS)),
    timeoutMs: Math.floor(envNumber(env, "MODEL_ROUTER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)),
  };
}

/** Master switch. Default OFF unless overridden by env / DB / definition. */
export function isModelRouterInprocessEnabled(): boolean {
  return isFeatureFlagEnabled(MODEL_ROUTER_INPROCESS_FLAG);
}

export function isModelRouterTier(value: unknown): value is ModelRouterTier {
  return typeof value === "string" && (MODEL_ROUTER_TIERS as readonly string[]).includes(value);
}

/**
 * OpenAI/Anthropic content parts → text. Verbatim port of the sidecar's `_text`.
 */
export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { text: string } =>
          !!part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
      )
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

export interface ClassifierBodyLike {
  messages?: unknown;
  system?: unknown;
}

/**
 * Classifier input, most relevant text FIRST — verbatim port of the sidecar's
 * `state_from_body`. The tokenizer keeps only the first 512 tokens, so ordering
 * is the weighting: last user turn, then earlier non-system turns (newest
 * first, ≤6 parts total), then the system prompt last.
 *
 * NOTE: the system text is concatenated without a separator and the result is
 * head-truncated to STATE_CHARS exactly as the Python does — byte parity with
 * the standalone proxy depends on preserving both quirks.
 */
export function buildRouterState(
  body: ClassifierBodyLike,
  stateChars = DEFAULT_STATE_CHARS
): string {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const turns: Array<[string, string]> = messages
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m): [string, string] => [
      typeof m.role === "string" ? m.role : "",
      textFromContent(m.content),
    ])
    .filter(([, text]) => text.trim() !== "");

  let lastUser: number | null = null;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i][0] === "user") {
      lastUser = i;
      break;
    }
  }

  const parts: string[] = [];
  if (lastUser !== null) parts.push(turns[lastUser][1]);
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const role = turns[i][0];
    if (i !== lastUser && role !== "system" && role !== "developer" && parts.length < 6) {
      parts.push(turns[i][1]);
    }
  }

  const systemText =
    textFromContent(body?.system) +
    turns
      .filter(([role]) => role === "system" || role === "developer")
      .map(([, t]) => t)
      .join("\n");
  if (systemText.trim() !== "") parts.push(systemText);

  return truncateCodePoints(parts.join("\n"), stateChars);
}

/**
 * Head-truncate by Unicode code points. The sidecar slices a Python `str`
 * (`[:STATE_CHARS]`, code points); `String#slice` counts UTF-16 units and would
 * split/shift on astral characters (emoji), breaking tier/confidence parity.
 */
export function truncateCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

/**
 * Parse a /classify response. Returns null on any shape violation so the caller
 * falls back — never trust the remote blind.
 */
export function parseClassifyResponse(payload: unknown): ClassifyResult | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (!isModelRouterTier(record.tier)) return null;
  const confidence =
    typeof record.confidence === "number" && Number.isFinite(record.confidence)
      ? record.confidence
      : null;
  if (confidence === null || confidence < 0 || confidence > 1) return null;
  const probabilities = Array.isArray(record.probabilities)
    ? record.probabilities.filter((p): p is number => typeof p === "number" && Number.isFinite(p))
    : undefined;
  return {
    tier: record.tier,
    confidence,
    probabilities,
    fallback: record.fallback === true,
  };
}

/**
 * POST the assembled state to the (configurable, provider-abstract) classifier.
 * Any transport/shape failure → null → caller uses the default combo.
 */
export async function classifyViaHttp(
  state: string,
  config: ModelRouterConfig,
  fetchImpl: typeof fetch = fetch
): Promise<ClassifyResult | null> {
  if (!state.trim()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(config.classifyUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state }),
      signal: controller.signal,
    });
    if (!response.ok) {
      log.warn("MODEL_ROUTER", `classify HTTP ${response.status}`, { url: config.classifyUrl });
      return null;
    }
    return parseClassifyResponse(await response.json());
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError" ? "timeout" : "transport_error";
    log.warn("MODEL_ROUTER", `classify failed (${reason})`, { url: config.classifyUrl });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tier → combo with the confidence gate. Closed set: a configured `auto/*`
 * combo is refused (never let the classifier pick models).
 */
export function selectTierCombo(
  result: ClassifyResult | null,
  config: ModelRouterConfig
): TierSelection {
  if (!result) {
    return {
      combo: config.defaultCombo,
      tier: "coding",
      confidence: 0,
      fallback: true,
      reason: "classify_failed",
    };
  }
  if (result.confidence < config.minConfidence[result.tier]) {
    return {
      combo: config.defaultCombo,
      tier: result.tier,
      confidence: result.confidence,
      fallback: true,
      reason: "low_confidence",
    };
  }
  const combo = config.tierCombos[result.tier];
  if (!combo || combo.startsWith("auto/")) {
    log.warn("MODEL_ROUTER", `refusing auto/* combo from tier map: ${combo ?? "<empty>"}`);
    return {
      combo: config.defaultCombo,
      tier: result.tier,
      confidence: result.confidence,
      fallback: true,
      reason: "invalid_combo",
    };
  }
  return {
    combo,
    tier: result.tier,
    confidence: result.confidence,
    fallback: false,
    reason: "classified",
  };
}

export interface MaybeApplyInput {
  body: ClassifierBodyLike & { model?: unknown };
  /** Model resolved so far (X-Route-Model header or body.model). */
  modelStr: string | null | undefined;
  config?: ModelRouterConfig;
  fetchImpl?: typeof fetch;
}

export interface MaybeApplyResult {
  /** False = untouched; flag off, or the request is not for the virtual router model. */
  applied: boolean;
  model: string | null;
  tier?: ModelRouterTier;
  confidence?: number;
  fallback?: boolean;
  reason?: TierSelection["reason"];
}

/**
 * Resolve the tier combo for a request that targets the virtual router model.
 * Returns `applied: false` (and a null model) when the feature is off or the
 * resolved model is anything else — the caller then leaves routing untouched.
 */
export async function maybeApplyModelRouterTier(input: MaybeApplyInput): Promise<MaybeApplyResult> {
  const config = input.config ?? resolveModelRouterConfig();
  const model = typeof input.modelStr === "string" ? input.modelStr : null;
  if (!model || model !== config.virtualModel) return { applied: false, model };

  const state = buildRouterState(input.body, config.stateChars);
  const result = await classifyViaHttp(state, config, input.fetchImpl);
  const selection = selectTierCombo(result, config);
  log.info(
    "MODEL_ROUTER",
    `tier=${selection.tier} conf=${selection.confidence.toFixed(3)} -> ${selection.combo}`,
    {
      fallback: selection.fallback,
      reason: selection.reason,
    }
  );
  return {
    applied: true,
    model: selection.combo,
    tier: selection.tier,
    confidence: selection.confidence,
    fallback: selection.fallback,
    reason: selection.reason,
  };
}
