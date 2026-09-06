#!/usr/bin/env node
/**
 * Golden-set gate for payload transform rules.
 *
 * Research-backed rationale (research-llm-prompt-rewriting-2026-09-05.md):
 * rewriting sometimes underperforms the unmodified prompt (DMQR-RAG), so no
 * transform rule should go live without replaying a fixed golden prompt set
 * and proving the mutations are exactly the intended ones. The gate is fully
 * deterministic — no LLM, no network. Every rule that matches zero golden
 * cases is a coverage failure: you cannot claim a rule is safe when nothing
 * exercised it.
 *
 * Usage:
 *   node scripts/payload-rules/gate.mjs --rules candidate.json --golden golden.json
 *   (or import runGoldenGate programmatically; tests do)
 *
 * Exit codes: 0 = passed, 1 = gate failed (printed), 2 = usage/IO error.
 */
import fs from "node:fs";
import path from "node:path";

// Reuse the runtime engine through the repo's tsx loader so gate and serving
// path share one implementation of matching + transform application.
const { applyPayloadRules, normalizePayloadRulesConfig } = await import(
  process.env.OMNIROOT
    ? path.join(process.env.OMNIROOT, "open-sse/services/payloadRules.ts")
    : "../../open-sse/services/payloadRules.ts"
);

/**
 * @param {object} input
 * @param {object} input.rules - raw payload-rules config (transform section used)
 * @param {Array<{name: string, model: string, protocol?: string|string[], payload: object, expect: object}>} input.golden
 * @returns {Promise<{passed: boolean, failures: string[], cases: Array<{name: string, applied: number, matched: boolean}>}>}
 */
export async function runGoldenGate({ rules, golden }) {
  const failures = [];
  const cases = [];

  if (!rules || typeof rules !== "object") {
    return { passed: false, failures: ["rules: not an object"], cases: [] };
  }
  const normalized = normalizePayloadRulesConfig(rules);
  const transformRules = normalized.transform ?? [];
  if (transformRules.length === 0) {
    // Distinguish "input had transform rules but they were all invalid" from
    // "no transform section at all" — both fail, but with different messages.
    const rawRules = Array.isArray(rules?.transform) ? rules.transform : [];
    const message =
      rawRules.length > 0
        ? "rules: every transform rule was rejected by normalization (invalid op, path, pattern, or flags)"
        : "rules: no transform rules present";
    return { passed: false, failures: [message], cases: [] };
  }

  let anyMatched = false;
  for (const goldenCase of golden ?? []) {
    const { payload, applied } = applyPayloadRules(
      goldenCase.payload,
      goldenCase.model,
      goldenCase.protocol ?? "openai",
      normalized
    );
    const transformApplied = applied.filter((a) => a.type === "transform");
    if (transformApplied.length > 0) anyMatched = true;

    const actualJson = JSON.stringify(payload);
    const expectJson = JSON.stringify(goldenCase.expect);
    if (actualJson !== expectJson) {
      failures.push(
        `case "${goldenCase.name}": payload mismatch\n  expected: ${expectJson}\n  actual:   ${actualJson}`
      );
    }
    cases.push({
      name: goldenCase.name,
      applied: transformApplied.length,
      matched: transformApplied.length > 0,
    });
  }

  if (!anyMatched) {
    failures.push(
      "coverage: no golden case matched any transform rule — the rule set was never exercised; add a golden case for the targeted model pattern"
    );
  }

  return { passed: failures.length === 0, failures, cases };
}

// ── CLI ────────────────────────────────────────────────────────────────────
function readJsonArg(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return null;
  try {
    return JSON.parse(fs.readFileSync(path.resolve(argv[i + 1]), "utf8"));
  } catch (e) {
    console.error(`gate: cannot read ${flag} file: ${e.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("gate.mjs")) {
  const rules = readJsonArg(process.argv, "--rules");
  const goldenRaw = readJsonArg(process.argv, "--golden");
  const golden = Array.isArray(goldenRaw) ? goldenRaw : goldenRaw?.cases;
  if (!rules || !golden) {
    console.error("usage: gate.mjs --rules <candidate.json> --golden <golden.json>");
    process.exit(2);
  }
  const result = await runGoldenGate({ rules, golden });
  for (const c of result.cases) {
    console.log(`  ${c.matched ? "MATCH" : "-----"} ${c.name} (applied ${c.applied})`);
  }
  if (result.passed) {
    console.log(`gate: PASSED (${result.cases.length} cases)`);
  } else {
    console.error(`gate: FAILED (${result.failures.length} failure(s))`);
    for (const f of result.failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}
