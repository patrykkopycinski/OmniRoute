import type { RegistryEntry } from "../../shared.ts";

export const openrouterProvider: RegistryEntry = {
  id: "openrouter",
  alias: "openrouter",
  format: "openai",
  executor: "default",
  baseUrl: "https://openrouter.ai/api/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  defaultContextLength: 128000,
  // #11226: OpenRouter's /api/v1/models is PUBLIC (200 with any or no key), so the
  // generic /models probe validated every key — even garbage ones — and bad keys
  // only surfaced later as upstream 401 "User not found." on real chat traffic.
  // /api/v1/auth/key is the authenticated key-info endpoint: 200 = valid, 401 = invalid.
  testKeyModelsUrl: "https://openrouter.ai/api/v1/auth/key",
  headers: {
    "HTTP-Referer": "https://endpoint-proxy.local",
    "X-Title": "Endpoint Proxy",
  },
  // OpenRouter multiplexes hundreds of independent upstream models behind one
  // connection/API key — without this flag, hasPerModelQuota() (accountFallback.ts)
  // falls through to connection-wide cooldown on any model-specific failure (e.g. a
  // 404 "No endpoints found" for one dead/renamed model), poisoning every OTHER
  // OpenRouter model on the same connection for the cooldown window and surfacing
  // that first model's stale error message on their unrelated requests.
  passthroughModels: true,
  models: [
    { id: "auto", name: "Auto (Best Available)" },
    // Paid-combo fallbacks. OpenRouter is passthrough-style; without these
    // rows the hops have no catalog window and collapse out of large prompts
    // whenever a sibling hop (Kimi/Opus) is known-large.
    { id: "x-ai/grok-4.6-high", name: "Grok 4.6 High", contextLength: 500000 },
    { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 1000000 },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", contextLength: 1048576 },
    { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", contextLength: 1048576 },
  ],
};
