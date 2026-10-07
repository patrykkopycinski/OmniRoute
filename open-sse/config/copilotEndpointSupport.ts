/**
 * Live GitHub Copilot endpoint capabilities, learned from `GET /models`
 * (`supported_endpoints`). A model whose list lacks `/chat/completions` (e.g.
 * gpt-6* / gpt-5.6*: `["/responses","ws:/responses"]`) 400s on chat
 * ("model X is not accessible via the /chat/completions endpoint"), so it must be
 * translated to and dispatched at /responses.
 *
 * Kept in its own dependency-free module so both the model-discovery service
 * (writer) and `getModelTargetFormat` (reader) can import it without a cycle.
 */

const responsesOnlyModels = new Set<string>();

/** Claude goes to /v1/messages; Claude/Gemini never go to /responses (9router#1536). */
function isResponsesCapableFamily(modelId: string): boolean {
  return !/claude|gemini/i.test(modelId);
}

/** True when `supported_endpoints` is present, non-empty, lacks chat, and offers /responses. */
export function endpointsRequireResponses(endpoints: unknown): boolean {
  if (!Array.isArray(endpoints)) return false;
  const list = endpoints.filter((e): e is string => typeof e === "string");
  if (list.length === 0) return false;
  const has = (path: string) => list.some((e) => e === path || e === `ws:${path}`);
  return !has("/chat/completions") && has("/responses");
}

/** Record (or clear) a discovered model's endpoint capability. */
export function recordCopilotModelEndpoints(modelId: string, endpoints: unknown): void {
  if (!modelId) return;
  if (isResponsesCapableFamily(modelId) && endpointsRequireResponses(endpoints)) {
    responsesOnlyModels.add(modelId);
  } else {
    responsesOnlyModels.delete(modelId);
  }
}

export function isCopilotResponsesOnlyModel(modelId: string): boolean {
  return isResponsesCapableFamily(modelId) && responsesOnlyModels.has(modelId);
}

/** Test helper. */
export function resetCopilotEndpointSupport(): void {
  responsesOnlyModels.clear();
}
