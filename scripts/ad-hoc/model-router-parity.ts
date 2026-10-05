/**
 * Parity harness: standalone laya-router vs in-process tier router.
 *
 * Ground truth  = the deployed sidecar's own `state_from_body()` + `classify()`
 *                 (served by scripts/ad-hoc/model-router-parity-server.py).
 * In-process    = `buildRouterState()` -> `classifyViaHttp()` -> `selectTierCombo()`
 *                 from src/sse/services/modelRouterTier.ts.
 *
 * Asserts, per frozen prompt: identical classifier input string, identical tier,
 * identical confidence, identical routed combo. Exits non-zero on any mismatch.
 *
 *   PARITY_URL=http://127.0.0.1:20771 node --import tsx/esm \
 *     scripts/ad-hoc/model-router-parity.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildRouterState,
  classifyViaHttp,
  resolveModelRouterConfig,
  selectTierCombo,
} from "../../src/sse/services/modelRouterTier.ts";

const base = process.env.PARITY_URL ?? "http://127.0.0.1:20771";
const fixture = path.resolve(process.cwd(), "tests/fixtures/model-router-parity-prompts.json");
const prompts: Array<{ id: string; body: Record<string, unknown> }> = JSON.parse(
  fs.readFileSync(fixture, "utf8")
);

async function post(route: string, payload: unknown): Promise<any> {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${route} -> HTTP ${res.status}`);
  return res.json();
}

// Sidecar's gate, replicated only to derive the expected combo from ITS result.
const config = resolveModelRouterConfig({});

let mismatches = 0;
console.log("id\tstateEq\tstandalone(tier,conf,combo)\tinprocess(tier,conf,combo)\tmatch");
for (const { id, body } of prompts) {
  const truth = await post("/standalone", { body });
  const truthState = (await post("/state", { body })).state as string;

  const state = buildRouterState(body as any, config.stateChars);
  const classified = await classifyViaHttp(state, config, (_u, init) =>
    fetch(`${base}/classify`, init)
  );
  const selected = selectTierCombo(classified, config);

  // Expected combo from the sidecar's result using the same gate the sidecar applies.
  const expectedCombo = truth.fallback
    ? config.defaultCombo
    : config.tierCombos[truth.tier as "fast"];

  const stateEq = state === truthState;
  const tierEq = classified?.tier === truth.tier;
  const confEq = classified?.confidence === truth.confidence;
  const comboEq = selected.combo === expectedCombo;
  const ok = stateEq && tierEq && confEq && comboEq;
  if (!ok) mismatches += 1;
  console.log(
    [
      id,
      stateEq,
      `${truth.tier},${truth.confidence.toFixed(6)},${expectedCombo}`,
      `${classified?.tier},${classified?.confidence.toFixed(6)},${selected.combo}`,
      ok ? "OK" : "MISMATCH",
    ].join("\t")
  );
}
console.log(`\n${prompts.length} prompts, ${mismatches} mismatches`);
process.exit(mismatches === 0 ? 0 : 1);
