#!/usr/bin/env node
/**
 * Offline LLM suggestion mode for payload transform rules.
 *
 * Research-backed design (research-llm-prompt-rewriting-2026-09-05.md):
 * the only credible LLM-rewriting pattern is OFFLINE compilation (DSPy/OPRO
 * style): an LLM proposes a prompt adaptation once, offline, against a fixed
 * golden set; the proposal is validated and then served deterministically.
 * This script implements the proposal half. It NEVER writes live config —
 * output is a candidate file plus a golden-gate verdict; a human (or a
 * pipeline step) promotes it via the normal payload-rules API after review.
 *
 * Usage:
 *   node scripts/payload-rules/suggest.mjs \
 *     --problem problems.json \
 *     --golden golden.json \
 *     --out candidate.json \
 *     [--endpoint http://localhost:20128/v1/chat/completions] \
 *     [--model judge]
 */
import fs from "node:fs";
import path from "node:path";
import { runGoldenGate } from "./gate.mjs";

const SYSTEM = `You propose deterministic payload transform rules for an LLM gateway.

You may ONLY use these operations, applied to dotted payload paths (e.g. "messages.0.content", "system"):
- {"op":"append","path":"...","value":"..."}          — append string to an existing string value
- {"op":"prepend","path":"...","value":"..."}         — prepend string
- {"op":"replace","path":"...","search":"...","replace":"..."} — literal first-occurrence replace
- {"op":"regex","path":"...","pattern":"...","flags":"...","replace":"..."} — regex replace (flags: g,i,m,s,u only)

Rules match models by shell-style wildcard name and optional protocol.

Respond with ONLY a JSON object:
{"transform":[{"models":[{"name":"...","protocol":"..."}],"ops":[...]}]}

Constraints:
- Prefer the narrowest model pattern that solves the problem.
- Prefer append/prepend on "messages" content or "system" over regex.
- Never propose a rule that would alter payloads of models not named in the problem.
- No explanation, no markdown fences — only the JSON object.`;

async function propose({ endpoint, model, apiKey, problem, golden }) {
  const body = {
    model,
    temperature: 0,
    max_tokens: 2000,
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content:
          `Problem:\n${JSON.stringify(problem, null, 2)}\n\nGolden set (your rule will be replayed against these; every case must transform exactly as its "expect" specifies, and at least one case must match):\n${JSON.stringify(
            golden.map((g) => ({ name: g.name, model: g.model, protocol: g.protocol ?? "openai", payload: g.payload })),
            null,
            2
          )}\n\nPropose the minimal transform rule set.`,
      },
    ],
  };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`LLM endpoint ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  const txt = content.trim().replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "");
  return JSON.parse(txt);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("suggest.mjs")) {
  const arg = (flag) => {
    const i = process.argv.indexOf(flag);
    return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
  };
  const problemFile = arg("--problem");
  const goldenFile = arg("--golden");
  const outFile = arg("--out") ?? "candidate.json";
  const endpoint = arg("--endpoint") ?? "http://localhost:20128/v1/chat/completions";
  const model = arg("--model") ?? "judge";
  const apiKey = arg("--key") ?? process.env.OMNIROUTE_KEY ?? "sk-test";

  if (!problemFile || !goldenFile) {
    console.error("usage: suggest.mjs --problem <p.json> --golden <g.json> [--out <candidate.json>]");
    process.exit(2);
  }
  const problem = readJson(problemFile);
  const goldenFileJson = readJson(goldenFile);
  // Accept either a bare array or {"cases": [...]} (the on-disk fixture shape).
  const golden = Array.isArray(goldenFileJson) ? goldenFileJson : goldenFileJson.cases;
  if (!Array.isArray(golden)) {
    console.error("golden: expected an array or {cases: [...]}");
    process.exit(2);
  }

  console.log(`suggest: proposing via ${model} at ${endpoint}...`);
  let candidate;
  try {
    candidate = await propose({ endpoint, model, apiKey, problem, golden });
  } catch (e) {
    console.error(`suggest: LLM proposal failed: ${e.message}`);
    process.exit(1);
  }
  fs.writeFileSync(path.resolve(outFile), JSON.stringify(candidate, null, 2) + "\n");

  // The gate is the trust boundary: an LLM proposal has zero authority until
  // it replays correctly against the golden set.
  const verdict = await runGoldenGate({ rules: candidate, golden });
  const report = {
    candidate: path.resolve(outFile),
    generatedAt: new Date().toISOString(),
    model,
    gate: verdict,
  };
  fs.writeFileSync(
    path.resolve(outFile).replace(/\.json$/, ".verdict.json"),
    JSON.stringify(report, null, 2) + "\n"
  );
  if (verdict.passed) {
    console.log(`suggest: gate PASSED — candidate written to ${outFile} (review, then promote via the payload-rules API)`);
  } else {
    console.error(`suggest: gate FAILED — candidate written for inspection but is NOT safe to promote`);
    for (const f of verdict.failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}
