/**
 * Shadow decision text log (MODEL_ROUTER_SHADOW_TEXT_LOG).
 *
 * In shadow mode (MODEL_ROUTER_SHADOW=1) every would-be decision is also
 * appended, as one JSON line, to the file named by MODEL_ROUTER_SHADOW_TEXT_LOG
 * together with the exact cleaned text the short-imperative rule scored, so a
 * would-be downgrade can be judged for harm without joining against client
 * session stores. Default OFF (env unset).
 *
 * Contract:
 *  - secrets are masked with `[REDACTED]` BEFORE truncation and before the write
 *    (so a secret cut by truncation cannot leak a prefix);
 *  - the write is fire-and-forget: it never throws and never blocks the request
 *    path; failures produce a single rate-limited warn;
 *  - nothing is written unless shadow mode is active AND the path is set.
 */

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import * as log from "../utils/logger";
import {
  SHADOW_PREV_USER_MAX,
  cleanRuleText,
  realUserTexts,
  type ModelRouterConfig,
  type ModelRouterTier,
} from "./modelRouterTier";

export const REDACTED = "[REDACTED]";

/** Applied in order; earlier (more specific) patterns run before the generic key/value one. */
const REDACTION_PATTERNS: readonly RegExp[] = [
  // PEM private key blocks (also unterminated, e.g. cut off by the client).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*$)/g,
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
  // Authorization bearer tokens.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // sk-… / sk-ant-… / sk-proj-… API keys.
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // GitHub tokens.
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  // AWS access key id.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Slack tokens.
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
];

/** `password: hunter2` / `api_key=abc` — keep the key, mask the value. */
const KEY_VALUE_PATTERN = /\b(password|passwd|secret|token|api[_-]?key)(\s*[:=]\s*)\S+/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of REDACTION_PATTERNS) out = out.replace(pattern, REDACTED);
  return out.replace(KEY_VALUE_PATTERN, `$1$2${REDACTED}`);
}

/** Truncate to `max` code points; suffix `…[truncated N]` (N = code points dropped). */
export function truncateWithMarker(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, max).join("")}…[truncated ${points.length - max}]`;
}

export interface ShadowTextDecision {
  requested: string;
  would: string;
  tier: ModelRouterTier;
  confidence: number;
  fb: boolean;
  sess: string;
  rule: "down" | "keep";
  ruleLen: number;
  /** Cleaned text the rule evaluated (from shortImperativeRule). */
  ruleText: string;
}

export function buildShadowTextRecord(
  d: ShadowTextDecision,
  body: Parameters<typeof realUserTexts>[0],
  textMax: number,
  now: Date = new Date()
): Record<string, unknown> {
  const users = realUserTexts(body);
  const prevRaw = users.length >= 2 ? cleanRuleText(users[users.length - 2]) : "";
  return {
    ts: now.toISOString(),
    sess: d.sess,
    requested: d.requested,
    would: d.would,
    tier: d.tier,
    conf: Number(d.confidence.toFixed(3)),
    fb: d.fb,
    rule: d.rule,
    rule_len: d.ruleLen,
    text: truncateWithMarker(redactSecrets(d.ruleText), textMax),
    text_sha1: createHash("sha1").update(d.ruleText).digest("hex"),
    prev_user: prevRaw ? truncateWithMarker(redactSecrets(prevRaw), SHADOW_PREV_USER_MAX) : null,
  };
}

const WARN_INTERVAL_MS = 60_000;
let lastWarnAt = 0;

function warnRateLimited(err: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  try {
    const code = (err as { code?: unknown } | null)?.code;
    log.warn(
      "MODEL_ROUTER_SHADOW_TEXT_LOG",
      `shadow text log write failed${typeof code === "string" ? ` (${code})` : ""}`
    );
  } catch {
    /* logging must never throw into the request path */
  }
}

export function __resetShadowTextWarnForTests(): void {
  lastWarnAt = 0;
}

/**
 * Append one JSONL record. Resolves once the write settled (or was skipped);
 * NEVER rejects. Callers in the request path use `void` and do not await.
 * No-op unless shadow mode is active and a path is configured.
 */
export async function appendShadowTextLog(
  config: Pick<ModelRouterConfig, "shadow" | "shadowTextLog" | "shadowTextMax">,
  decision: ShadowTextDecision,
  body: Parameters<typeof realUserTexts>[0]
): Promise<void> {
  if (!config.shadow || !config.shadowTextLog) return;
  try {
    const file = config.shadowTextLog;
    const line = JSON.stringify(buildShadowTextRecord(decision, body, config.shadowTextMax)) + "\n";
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fsp.appendFile(file, line, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    warnRateLimited(err);
  }
}
