/**
 * Copilot models whose `supported_endpoints` lack /chat/completions (gpt-6*, gpt-5.6*)
 * 400 on chat: `model "gpt-6.1-sol" is not accessible via the /chat/completions endpoint`.
 *
 * Three fixes, one test each group (every group must go red when its fix is reverted):
 *  1. routing  — static gpt-6* entries + discovered `supported_endpoints` drive /responses
 *  2. cooldown — that 400 must not lock the model out (a lock later reads as 429 quota)
 *  3. scrub    — the error message keeps `/chat/completions`, still redacts filesystem paths
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gh-responses-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "gh-responses-routing-test-secret";

const { getModelTargetFormat } = await import("../../open-sse/config/providerModels.ts");
const { GithubExecutor } = await import("../../open-sse/executors/github.ts");
const {
  parseGitHubCopilotModels,
  ensureCopilotEndpointsDiscovered,
  resetCopilotEndpointDiscovery,
} = await import("../../open-sse/services/githubCopilotModels.ts");
const { resetCopilotEndpointSupport, endpointsRequireResponses } =
  await import("../../open-sse/config/copilotEndpointSupport.ts");
const { handleComboChat, isEndpointRouting400, isModelScoped400 } =
  await import("../../open-sse/services/combo.ts");
const { clearAllModelLockouts, isModelLocked } =
  await import("../../open-sse/services/accountFallback.ts");
const { sanitizeErrorMessage } = await import("../../open-sse/utils/errorSanitization.ts");

const RESPONSES_URL = "https://api.githubcopilot.com/responses";

function urlFor(model: string) {
  return new GithubExecutor().buildUrl(model, false, 0, null);
}

function chatModel(id: string, endpoints?: string[]) {
  return {
    id,
    name: id,
    model_picker_enabled: true,
    policy: { state: "enabled" },
    capabilities: { type: "chat" },
    ...(endpoints ? { supported_endpoints: endpoints } : {}),
  };
}

test.beforeEach(() => {
  resetCopilotEndpointSupport();
  resetCopilotEndpointDiscovery();
  clearAllModelLockouts();
});

// ── 1. routing ──────────────────────────────────────────────────────────────

test("static registry: gpt-6* Copilot models target /responses", () => {
  for (const id of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra"]) {
    assert.equal(getModelTargetFormat("gh", id), "openai-responses", id);
    assert.equal(urlFor(id), RESPONSES_URL, id);
  }
});

test("endpointsRequireResponses: only when chat is absent and /responses is offered", () => {
  assert.equal(endpointsRequireResponses(["/responses", "ws:/responses"]), true);
  assert.equal(endpointsRequireResponses(["/chat/completions", "/responses"]), false);
  assert.equal(endpointsRequireResponses(["/v1/messages"]), false);
  assert.equal(endpointsRequireResponses([]), false);
  assert.equal(endpointsRequireResponses(undefined), false);
});

test("discovery: an unknown model that is Responses-only routes to /responses", () => {
  assert.equal(getModelTargetFormat("gh", "gpt-9-nova"), null);
  assert.notEqual(urlFor("gpt-9-nova"), RESPONSES_URL);

  parseGitHubCopilotModels({
    data: [chatModel("gpt-9-nova", ["/responses", "ws:/responses"])],
  });

  assert.equal(getModelTargetFormat("gh", "gpt-9-nova"), "openai-responses");
  assert.equal(urlFor("gpt-9-nova"), RESPONSES_URL);
});

test("discovery: a model that still offers /chat/completions stays on chat", () => {
  parseGitHubCopilotModels({
    data: [chatModel("gpt-9-both", ["/chat/completions", "/responses"])],
  });
  assert.equal(getModelTargetFormat("gh", "gpt-9-both"), null);
  assert.notEqual(urlFor("gpt-9-both"), RESPONSES_URL);
});

test("discovery: Claude/Gemini never go to /responses even if discovery says so (9router#1536)", () => {
  parseGitHubCopilotModels({
    data: [
      chatModel("claude-future-9", ["/responses"]),
      chatModel("gemini-future-9", ["/responses"]),
    ],
  });
  assert.notEqual(getModelTargetFormat("gh", "claude-future-9"), "openai-responses");
  assert.notEqual(getModelTargetFormat("gh", "gemini-future-9"), "openai-responses");
  assert.notEqual(urlFor("claude-future-9"), RESPONSES_URL);
  assert.notEqual(urlFor("gemini-future-9"), RESPONSES_URL);
});

test("discovery: a later refresh that re-adds /chat/completions clears the Responses-only mark", () => {
  parseGitHubCopilotModels({ data: [chatModel("gpt-9-flip", ["/responses"])] });
  assert.equal(getModelTargetFormat("gh", "gpt-9-flip"), "openai-responses");
  parseGitHubCopilotModels({ data: [chatModel("gpt-9-flip", ["/chat/completions"])] });
  assert.equal(getModelTargetFormat("gh", "gpt-9-flip"), null);
});

test("lazy discovery: learns Responses-only models from /models after a restart", async () => {
  let calls = 0;
  const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
    calls++;
    assert.equal(url, "https://api.githubcopilot.com/models");
    assert.match(init.headers.Authorization, /^Bearer tok-1$/);
    return Response.json({ data: [chatModel("gpt-9-lazy", ["/responses"])] });
  }) as unknown as typeof fetch;

  await ensureCopilotEndpointsDiscovered({
    model: "gpt-9-lazy",
    tokens: [undefined, "tok-1"],
    fetchImpl,
  });
  assert.equal(getModelTargetFormat("gh", "gpt-9-lazy"), "openai-responses");
  assert.equal(calls, 1);

  // Fresh cache → no second network call; statically-known and Claude models never fetch.
  await ensureCopilotEndpointsDiscovered({ model: "gpt-9-lazy", tokens: ["tok-1"], fetchImpl });
  await ensureCopilotEndpointsDiscovered({ model: "gpt-6-sol", tokens: ["tok-1"], fetchImpl });
  await ensureCopilotEndpointsDiscovered({ model: "claude-opus-5", tokens: ["tok-1"], fetchImpl });
  assert.equal(calls, 1);
});

test("lazy discovery: a failing /models call never throws and is not retried every request", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    throw new Error("network down");
  }) as unknown as typeof fetch;
  await ensureCopilotEndpointsDiscovered({ model: "gpt-9-x", tokens: ["t"], fetchImpl });
  await ensureCopilotEndpointsDiscovered({ model: "gpt-9-y", tokens: ["t"], fetchImpl });
  assert.equal(calls, 1);
  assert.equal(getModelTargetFormat("gh", "gpt-9-x"), null);
});

// ── 2. cooldown ─────────────────────────────────────────────────────────────

const ENDPOINT_400 =
  '[400]: model "gpt-6.1-sol" is not accessible via the /chat/completions endpoint';

test("isEndpointRouting400 matches endpoint-routing 400s only", () => {
  assert.equal(isEndpointRouting400(ENDPOINT_400), true);
  assert.equal(isEndpointRouting400("unsupported_api_for_model"), true);
  assert.equal(isEndpointRouting400("model x does not support Responses API."), true);
  assert.equal(isEndpointRouting400("[400]: The requested model is not supported."), false);
  assert.equal(isEndpointRouting400("invalid api key"), false);
  assert.equal(isEndpointRouting400(""), false);
  // Still model-scoped: the combo advances, it just must not lock.
  assert.equal(isModelScoped400(ENDPOINT_400), true);
});

async function runComboWith400(message: string, model: string) {
  const combo = {
    name: "gh-endpoint-400",
    strategy: "priority",
    models: [{ model: `github/${model}` }, { model: "claude/claude-sonnet-5" }],
  };
  const called: string[] = [];
  const noop = () => {};
  const response = await handleComboChat({
    body: { model: "x", messages: [{ role: "user", content: "hi" }] },
    combo,
    handleSingleModel: async (_b: unknown, modelStr: string) => {
      called.push(modelStr);
      if (modelStr.startsWith("github/")) {
        return Response.json(
          { error: { message, type: "invalid_request_error" } },
          { status: 400 }
        );
      }
      return Response.json({
        id: "ok",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" } }],
      });
    },
    isModelAvailable: async () => true,
    log: { info: noop, warn: noop, debug: noop, error: noop },
    settings: {},
    allCombos: null,
  });
  return { response, called };
}

test("combo: endpoint-routing 400 advances to the next target WITHOUT locking the model", async () => {
  const { response, called } = await runComboWith400(ENDPOINT_400, "gpt-6.1-sol");
  assert.equal(response.status, 200);
  assert.deepEqual(called, ["github/gpt-6.1-sol", "claude/claude-sonnet-5"]);
  assert.equal(isModelLocked("github", "", "gpt-6.1-sol"), false);
});

test("combo control: a genuine 'model not supported' 400 still locks the model", async () => {
  const { response } = await runComboWith400(
    "[400]: The requested model is not supported.",
    "gpt-4.1"
  );
  assert.equal(response.status, 200);
  assert.equal(isModelLocked("github", "", "gpt-4.1"), true);
});

// ── 3. error-message scrub ──────────────────────────────────────────────────

test("sanitizeErrorMessage keeps upstream API endpoints but still redacts filesystem paths", () => {
  assert.equal(
    sanitizeErrorMessage(ENDPOINT_400),
    '[400]: model "gpt-6.1-sol" is not accessible via the /chat/completions endpoint'
  );
  assert.equal(
    sanitizeErrorMessage("model x is not accessible via the /responses endpoint."),
    "model x is not accessible via the /responses endpoint."
  );
  assert.equal(
    sanitizeErrorMessage('model x is not accessible via the "/chat/completions" endpoint'),
    'model x is not accessible via the "/chat/completions" endpoint'
  );

  // Filesystem paths and look-alikes stay redacted.
  assert.match(sanitizeErrorMessage("crashed at /Users/alice/app/secret.ts"), /<path>/);
  assert.doesNotMatch(sanitizeErrorMessage("crashed at /Users/alice/app/secret.ts"), /alice/);
  assert.match(sanitizeErrorMessage("cannot open /etc/passwd now"), /<path>/);
  assert.match(sanitizeErrorMessage("cannot open /responses.ts now"), /<path>/);
  assert.match(sanitizeErrorMessage("cannot open /responses/../etc/passwd now"), /<path>/);
});
