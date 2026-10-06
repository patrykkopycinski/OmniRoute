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

import { createHash } from "node:crypto";

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

/** Downgrade-only policy (MODEL_ROUTER_POLICY=downgrade). */
export const DEFAULT_DOWNGRADE_FROM = "best-reasoning-paid";
export const DEFAULT_DOWNGRADE_TO = "best-coding-paid";
export const DEFAULT_DOWNGRADE_MIN_CONF = 0.9;
export const DEFAULT_DOWNGRADE_TIMEOUT_MS = 800;

/** Sticky session tier — verbatim port of the sidecar's `_sessions` LRU. */
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
export const SESSION_CAP = 512;

export interface ModelRouterConfig {
  classifyUrl: string;
  virtualModel: string;
  tierCombos: Record<ModelRouterTier, string>;
  defaultCombo: string;
  minConfidence: Record<ModelRouterTier, number>;
  stateChars: number;
  timeoutMs: number;
  /** `full` (virtual-model tier routing, default) | `downgrade` (downgrade-only). */
  policy: "full" | "downgrade";
  downgradeFrom: string;
  downgradeTo: string;
  downgradeMinConf: number;
  downgradeTimeoutMs: number;
  /** MODEL_ROUTER_SHADOW=1: classify + log the decision, never rewrite. */
  shadow: boolean;
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
    policy: envString(env, "MODEL_ROUTER_POLICY", "full") === "downgrade" ? "downgrade" : "full",
    downgradeFrom: envString(env, "MODEL_ROUTER_DOWNGRADE_FROM", DEFAULT_DOWNGRADE_FROM),
    downgradeTo: envString(env, "MODEL_ROUTER_DOWNGRADE_TO", DEFAULT_DOWNGRADE_TO),
    downgradeMinConf: envNumberAllowZero(
      env,
      "MODEL_ROUTER_DOWNGRADE_MIN_CONF",
      DEFAULT_DOWNGRADE_MIN_CONF
    ),
    downgradeTimeoutMs: Math.floor(
      envNumber(env, "MODEL_ROUTER_DOWNGRADE_TIMEOUT_MS", DEFAULT_DOWNGRADE_TIMEOUT_MS)
    ),
    shadow: envBool(env, "MODEL_ROUTER_SHADOW", false),
  };
}

function envBool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim() === "1" || raw.trim().toLowerCase() === "true";
}

/** Like envNumber but accepts 0 (a 0.0 confidence floor is meaningful). */
function envNumberAllowZero(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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

/**
 * Hermes injects retry nudges as user turns starting with '[System:'. Verbatim
 * port of the sidecar's `_is_harness_nudge` (lstrip then prefix check).
 */
export function isHarnessNudge(text: string): boolean {
  return text.replace(/^\s+/, "").startsWith("[System:");
}

/** Sticky session key: sha1 of the FIRST user turn's text, first 12 hex chars. */
export function sessionKeyFromUsers(users: string[]): string {
  return createHash("sha1").update(users[0]).digest("hex").slice(0, 12);
}

interface StickyEntry {
  tier: ModelRouterTier;
  ts: number;
}

/**
 * In-process LRU mirror of the sidecar's `_sessions` (OrderedDict, TTL 6h,
 * cap 512). Exported for tests; production code goes through classifyBodyLike.
 */
const sessions = new Map<string, StickyEntry>();

export function __resetModelRouterSessionsForTests(): void {
  sessions.clear();
}

export interface SessionClassification {
  result: ClassifyResult;
  session: string;
  sticky: boolean;
}

/**
 * Verbatim port of the sidecar's `classify_body` session logic (minus the model
 * inference itself, which arrives as `fresh` from the HTTP classifier):
 *  - session key = sha1(first user text)[:12]
 *  - sticky when a stored tier exists AND (last user text < 40 chars OR the
 *    fresh classification was confident OR the last turn is a nudge)
 *  - sticky reuse returns the stored tier with fallback=false
 *  - LRU with TTL 6h, cap 512
 */
export function classifyWithSessions(
  body: ClassifierBodyLike,
  fresh: ClassifyResult | null,
  nowMs: number = Date.now()
): SessionClassification {
  const userTexts = (Array.isArray(body?.messages) ? body.messages : [])
    .filter((m) => !!m && typeof m === "object")
    .map((m) => {
      const rec = m as Record<string, unknown>;
      return rec.role === "user" ? textFromContent(rec.content) : null;
    })
    .filter((t): t is string => t !== null && t.trim() !== "" && !isHarnessNudge(t));

  const state = buildRouterState(body);
  if (userTexts.length === 0) {
    if (!state.trim()) {
      return {
        result: { tier: "coding", confidence: 0, probabilities: [], fallback: true },
        session: "",
        sticky: false,
      };
    }
    return {
      result: fresh ?? { tier: "coding", confidence: 0, fallback: true },
      session: "",
      sticky: false,
    };
  }

  const first = userTexts[0];
  void first; // parity with the sidecar (session key derives from the first user text)
  const last = userTexts[userTexts.length - 1];
  const sess = sessionKeyFromUsers(userTexts);

  // TTL sweep (lazy, same as the sidecar's per-call loop).
  for (const [key, entry] of [...sessions.entries()]) {
    if (nowMs - entry.ts >= SESSION_TTL_MS) sessions.delete(key);
  }

  const stored = sessions.get(sess);
  const lastTurnIsNudge = (() => {
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    const lastMsg = msgs[msgs.length - 1];
    return (
      !!lastMsg &&
      typeof lastMsg === "object" &&
      (lastMsg as Record<string, unknown>).role === "user" &&
      isHarnessNudge(textFromContent((lastMsg as Record<string, unknown>).content))
    );
  })();
  const freshIsFallback = fresh === null || fresh.fallback;
  const sticky = stored !== undefined && (last.length < 40 || freshIsFallback || lastTurnIsNudge);

  let tier: ModelRouterTier;
  let fallback: boolean;
  if (sticky && stored) {
    tier = stored.tier;
    fallback = false;
  } else {
    tier = fresh?.tier ?? "coding";
    fallback = fresh === null ? true : fresh.fallback;
  }
  sessions.delete(sess);
  sessions.set(sess, { tier, ts: nowMs });
  while (sessions.size > SESSION_CAP) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }

  return {
    result: {
      tier,
      confidence: fresh?.confidence ?? 0,
      probabilities: fresh?.probabilities,
      fallback,
    },
    session: sess,
    sticky,
  };
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
    .filter(([, text]) => text.trim() !== "")
    // Harness-injected '[System:' user turns (retry nudges) are not real input.
    .filter(([role, text]) => !(role === "user" && isHarnessNudge(text)));

  // User turns newest first, at most 6. Only when there are no user turns,
  // fall back to non-system turns newest first (≤6). This is the sidecar's
  // exact ordering — never mix assistant/tool turns into a user-led state.
  const users = turns.filter(([role]) => role === "user").map(([, t]) => t);
  const parts =
    users.length > 0
      ? [...users].reverse().slice(0, 6)
      : turns
          .slice()
          .reverse()
          .filter(([role]) => role !== "system" && role !== "developer")
          .map(([, t]) => t)
          .slice(0, 6);

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
  /** Opt-out: x-omniroute-no-route: 1 skips routing for this request. */
  noRoute?: boolean;
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

  // ── Shadow mode (MODEL_ROUTER_SHADOW=1): classify + log, NEVER rewrite. ──
  // Fire-and-forget: the request path does not await the classifier.
  if (config.shadow) {
    if (!input.noRoute) void shadowClassifyAndLog(input.body, model, config, input.fetchImpl);
    return { applied: false, model };
  }

  // ── Downgrade-only policy (MODEL_ROUTER_POLICY=downgrade) ──
  if (config.policy === "downgrade") {
    if (input.noRoute) return { applied: false, model };
    if (!model || model !== config.downgradeFrom) return { applied: false, model };

    const state = buildRouterState(input.body, config.stateChars);
    const t0 = Date.now();
    const result = await classifyViaHttp(
      state,
      { ...config, timeoutMs: config.downgradeTimeoutMs },
      input.fetchImpl
    );
    const ms = Date.now() - t0;
    const downgraded =
      result !== null &&
      result.tier === "coding" &&
      !result.fallback &&
      result.confidence >= config.downgradeMinConf;
    const would = downgraded ? config.downgradeTo : model;
    logModelRouterDecision({
      policy: "downgrade",
      requested: model,
      would,
      tier: result?.tier ?? "coding",
      confidence: result?.confidence ?? 0,
      fb: result === null || result.fallback,
      sticky: false,
      sess: "",
      ms,
      applied: downgraded,
    });
    if (!downgraded) return { applied: false, model };
    return {
      applied: true,
      model: config.downgradeTo,
      tier: "coding",
      confidence: result?.confidence ?? 0,
      fallback: false,
      reason: "classified",
    };
  }

  // ── Full policy (default): virtual-model tier routing ──
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

export interface ModelRouterDecisionLog {
  policy: "full" | "downgrade" | "shadow";
  requested: string;
  would: string;
  tier: ModelRouterTier;
  confidence: number;
  fb: boolean;
  sticky: boolean;
  sess: string;
  ms: number;
  applied: boolean;
}

/**
 * One MODEL_ROUTER_DECISION line per shadow decision. Kept as a separate
 * exported function so tests can capture the exact rendered line.
 */
export function renderModelRouterDecisionLine(d: ModelRouterDecisionLog): string {
  return (
    `policy=${d.policy} requested=${d.requested} would=${d.would} tier=${d.tier} ` +
    `conf=${d.confidence.toFixed(3)} fb=${d.fb} sticky=${d.sticky} sess=${d.sess} ` +
    `ms=${d.ms.toFixed(1)} applied=${d.applied}`
  );
}

export function logModelRouterDecision(d: ModelRouterDecisionLog): void {
  log.info("MODEL_ROUTER_DECISION", renderModelRouterDecisionLine(d));
}

async function shadowClassifyAndLog(
  body: MaybeApplyInput["body"],
  requestedModel: string | null,
  config: ModelRouterConfig,
  fetchImpl?: typeof fetch
): Promise<void> {
  try {
    const model = requestedModel ?? "";
    const effectiveConfig: ModelRouterConfig =
      config.policy === "downgrade" ? { ...config, timeoutMs: config.downgradeTimeoutMs } : config;
    const relevant = config.policy === "downgrade" ? model === config.downgradeFrom : true;
    if (!relevant) return; // other models pass through untouched — nothing to log
    const state = buildRouterState(body, config.stateChars);
    const t0 = Date.now();
    const result = await classifyViaHttp(state, effectiveConfig, fetchImpl);
    const ms = Date.now() - t0;
    let would = model;
    let tier: ModelRouterTier = "coding";
    let conf = 0;
    let fb = true;
    let sticky = false;
    let sess = "";
    if (result) {
      const session = classifyWithSessions(body, result);
      tier = session.result.tier;
      conf = result.confidence;
      fb = session.result.fallback;
      sticky = session.sticky;
      sess = session.session;
      const selection = selectTierCombo(session.result, config);
      would =
        config.policy === "downgrade"
          ? result.tier === "coding" && !fb && result.confidence >= config.downgradeMinConf
            ? config.downgradeTo
            : model
          : model === config.virtualModel
            ? selection.combo
            : model;
    }
    logModelRouterDecision({
      policy: "shadow",
      requested: model,
      would,
      tier,
      confidence: conf,
      fb,
      sticky,
      sess,
      ms,
      applied: false,
    });
  } catch {
    /* fire-and-forget: shadow logging must never break the request */
  }
}
