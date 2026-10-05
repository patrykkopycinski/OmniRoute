import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

// Wiring test: drives the REAL handleChat so a removed/ungated call site in
// src/sse/handlers/chat.ts turns it red (unit tests of the helper cannot).
const harness = await createChatPipelineHarness("model-router-tier-wiring");
const {
  BaseExecutor,
  buildOpenAIResponse,
  buildRequest,
  handleChat,
  resetStorage,
  seedConnection,
} = harness;
const { combosDb } = harness;
const { clearAllFeatureFlagOverrides } = await import("../../src/lib/db/featureFlags.ts");

const ENV_KEYS = ["MODEL_ROUTER_INPROCESS", "MODEL_ROUTER_CLASSIFY_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
const realFetch = globalThis.fetch;

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
  clearAllFeatureFlagOverrides();
  for (const k of ENV_KEYS) delete process.env[k];
});

test.afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

async function seedTierCombos() {
  await seedConnection("openai", { apiKey: "sk-test" });
  await combosDb.createCombo({ name: "fast", models: ["openai/gpt-4.1-mini"] });
  await combosDb.createCombo({ name: "best-coding-paid", models: ["openai/gpt-4.1"] });
}

function installFakeFetch(tier: string, confidence: number) {
  const classifyCalls: string[] = [];
  const upstreamModels: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const href = String(url);
    if (href.includes("/classify")) {
      classifyCalls.push(String(init.body));
      return new Response(
        JSON.stringify({ tier, confidence, probabilities: {}, fallback: false }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    try {
      upstreamModels.push(JSON.parse(String(init.body)).model);
    } catch {}
    return buildOpenAIResponse("ok");
  }) as typeof fetch;
  return { classifyCalls, upstreamModels };
}

function routerRequest() {
  return buildRequest({
    url: "http://localhost/v1/chat/completions",
    body: {
      model: "laya-router",
      stream: false,
      messages: [{ role: "user", content: "Rename userCnt to userCount" }],
    },
  });
}

test("flag ON: laya-router is classified and dispatched to the tier combo's model", async () => {
  await seedTierCombos();
  process.env.MODEL_ROUTER_INPROCESS = "true";
  process.env.MODEL_ROUTER_CLASSIFY_URL = "http://127.0.0.1:1/classify";
  const { classifyCalls, upstreamModels } = installFakeFetch("fast", 0.9);

  const response = await handleChat(routerRequest());

  assert.equal(response.status, 200);
  assert.equal(classifyCalls.length, 1, "classifier consulted exactly once");
  assert.match(classifyCalls[0], /Rename userCnt/);
  assert.equal(upstreamModels[0], "gpt-4.1-mini", "routed through the `fast` combo");
});

test("flag ON: low confidence falls back to the default (coding) combo", async () => {
  await seedTierCombos();
  process.env.MODEL_ROUTER_INPROCESS = "true";
  process.env.MODEL_ROUTER_CLASSIFY_URL = "http://127.0.0.1:1/classify";
  const { upstreamModels } = installFakeFetch("fast", 0.1);

  const response = await handleChat(routerRequest());

  assert.equal(response.status, 200);
  assert.equal(upstreamModels[0], "gpt-4.1");
});

test("flag OFF (default): classifier is never called and laya-router is not rewritten", async () => {
  await seedTierCombos();
  const { classifyCalls, upstreamModels } = installFakeFetch("fast", 0.9);

  const response = await handleChat(routerRequest());

  assert.equal(classifyCalls.length, 0, "no classify call with the flag off");
  assert.equal(upstreamModels.length, 0, "nothing reaches an upstream for the unknown model");
  assert.notEqual(response.status, 200);
});
