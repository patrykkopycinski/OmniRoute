/**
 * Transform-rule model-pattern inertness detection.
 *
 * Payload rules are matched against the RESOLVED model id (e.g. `qwen3.8-27b`),
 * not the alias or combo name the client requested (e.g. `qwen38a100/qwen3.8-27b`,
 * `main`, `cheap`). A rule scoped to an alias therefore never fires — silently,
 * with no error and no log line. For an audit-oriented feature that is the worst
 * failure mode: the operator believes a transform is active when it is inert.
 *
 * This module makes that observable. It never rejects a rule (a pattern may
 * legitimately target a model this build's registry does not know about, e.g. a
 * custom provider or a model added after release) — it only flags patterns that
 * look like they will never match anything resolvable.
 */
import { PROVIDER_MODELS } from "@/shared/constants/models";

export interface InertModelPattern {
  pattern: string;
  reason: "alias_prefix" | "unknown_model";
}

let cachedModelIds: Set<string> | null = null;
let cachedProviderPrefixes: Set<string> | null = null;

function getModelIds(): Set<string> {
  if (cachedModelIds) return cachedModelIds;
  const ids = new Set<string>();
  for (const models of Object.values(PROVIDER_MODELS)) {
    for (const model of models) ids.add(model.id);
  }
  cachedModelIds = ids;
  return ids;
}

function getProviderPrefixes(): Set<string> {
  if (cachedProviderPrefixes) return cachedProviderPrefixes;
  cachedProviderPrefixes = new Set(Object.keys(PROVIDER_MODELS));
  return cachedProviderPrefixes;
}

/** Test-only: force the memoized registry indexes to rebuild on next call. */
export function __resetTransformPatternCacheForTest(): void {
  cachedModelIds = null;
  cachedProviderPrefixes = null;
}

/**
 * True when `pattern` (a payload-rule model spec name, possibly containing `*`)
 * can match at least one known resolved model id.
 */
function matchesAnyKnownModel(pattern: string): boolean {
  const ids = getModelIds();
  if (!pattern.includes("*")) return ids.has(pattern);
  // Translate the wildcard glob into a regex, escaping everything else.
  const source = `^${pattern.split("*").map(escapeRegExp).join(".*")}$`;
  const re = new RegExp(source);
  for (const id of ids) {
    if (re.test(id)) return true;
  }
  return false;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Classifies a single model pattern. Returns null when the pattern is fine.
 *
 * `alias_prefix` is reported when the pattern carries a `provider/` segment:
 * matching happens after routing resolves the model, so the provider prefix is
 * already stripped and a prefixed pattern can never match.
 */
export function classifyModelPattern(pattern: string): InertModelPattern | null {
  const trimmed = pattern.trim();
  if (!trimmed) return null;

  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const prefix = trimmed.slice(0, slash);
    // Only flag when the prefix looks like a provider/alias namespace rather
    // than part of a model id that legitimately contains a slash.
    if (getProviderPrefixes().has(prefix) || !matchesAnyKnownModel(trimmed)) {
      return { pattern: trimmed, reason: "alias_prefix" };
    }
  }

  if (!matchesAnyKnownModel(trimmed)) {
    return { pattern: trimmed, reason: "unknown_model" };
  }

  return null;
}

/** Shape of the minimal rule record the scan needs. */
export interface TransformRuleLike {
  models?: unknown;
}

/**
 * Scans the `transform` section of a payload-rules config and returns every
 * model pattern that will never fire. Used by the settings UI to warn before
 * an operator saves a rule that silently does nothing.
 */
export function findInertTransformPatterns(
  transformRules: readonly TransformRuleLike[]
): InertModelPattern[] {
  const found: InertModelPattern[] = [];
  const seen = new Set<string>();
  for (const rule of transformRules) {
    if (!Array.isArray(rule?.models)) continue;
    for (const spec of rule.models) {
      const name = (spec as { name?: unknown })?.name;
      if (typeof name !== "string") continue;
      const verdict = classifyModelPattern(name);
      if (verdict && !seen.has(verdict.pattern)) {
        seen.add(verdict.pattern);
        found.push(verdict);
      }
    }
  }
  return found;
}
