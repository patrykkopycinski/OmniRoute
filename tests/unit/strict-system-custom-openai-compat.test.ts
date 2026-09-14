import test from "node:test";
import assert from "node:assert/strict";
import { translateRequest } from "../../open-sse/translator/index.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import { parseStrictSystemProvidersEnv } from "../../src/lib/memory/injection.ts";

/**
 * #7301-class regression: a custom openai-compatible connection in front of a
 * self-hosted SGLang cell (Qwen3.8-27B, GDN/mamba hybrid) 400s with
 * "System message must be at the beginning." when memory injection splices
 * memory context mid-array. The strict-set gate (systemMessageMustBeFirst)
 * only fires for ids in BUILTIN_PROVIDERS_SYSTEM_MUST_BE_FIRST or
 * OMNIROUTE_STRICT_SYSTEM_PROVIDERS; a fresh custom connection id is NOT in
 * the builtin set, so the hoist is a silent no-op until an operator adds the
 * env entry. These tests pin:
 *   1. env-based extension works for arbitrary custom connection ids
 *   2. the default (no env) leaves custom ids non-strict — documented, not
 *      accidental, so a future refactor can't silently flip it
 *   3. the end-to-end translateRequest path hoists for the env-extended id
 * Production reference (2026-09-14): connection ids
 *   openai-compatible-chat-1743e48a-5212-4b2a-81a1-b0f1bec9e237
 *   openai-compatible-chat-68e8bf4c-327e-457d-8cc8-8f0ed0e18400
 * carried in OMNIROUTE_STRICT_SYSTEM_PROVIDERS on the m1max gateway deploy.
 */

const CUSTOM_CONN = "openai-compatible-chat-1743e48a-5212-4b2a-81a1-b0f1bec9e237";

test("#7301: OMNIROUTE_STRICT_SYSTEM_PROVIDERS extends the strict set to arbitrary custom connection ids", () => {
  const ids = parseStrictSystemProvidersEnv({
    OMNIROUTE_STRICT_SYSTEM_PROVIDERS: `${CUSTOM_CONN},xiaomi-mimo`,
  });
  assert.ok(ids.includes(CUSTOM_CONN));
  assert.ok(ids.includes("xiaomi-mimo"));
  // normalization: case/whitespace tolerant
  const noisy = parseStrictSystemProvidersEnv({
    OMNIROUTE_STRICT_SYSTEM_PROVIDERS: ` ${CUSTOM_CONN.toUpperCase()} ,`,
  });
  assert.ok(noisy.includes(CUSTOM_CONN));
});

test("#7301: default env (unset) keeps custom openai-compatible ids NON-strict — env opt-in is required", () => {
  const ids = parseStrictSystemProvidersEnv({});
  assert.equal(ids.length, 0);
});

test("#7301: same-format passthrough hoists mid-array system for env-extended custom connection", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    // memory-injection splice lands a system message mid-conversation
    { role: "system", content: "Memory context: user prefers terse answers" },
    { role: "user", content: "summarize" },
  ];

  const saved = process.env.OMNIROUTE_STRICT_SYSTEM_PROVIDERS;
  process.env.OMNIROUTE_STRICT_SYSTEM_PROVIDERS = CUSTOM_CONN;
  try {
    const result = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "qwen3.8-27b",
      { model: "qwen3.8-27b", messages },
      false,
      null,
      CUSTOM_CONN
    );
    const out = result.messages as Array<{ role: string; content: string }>;
    const systemIndices = out.map((m, i) => (m.role === "system" ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(systemIndices, [0]);
    assert.match(out[0].content, /Memory context: user prefers terse answers/);
  } finally {
    if (saved === undefined) delete process.env.OMNIROUTE_STRICT_SYSTEM_PROVIDERS;
    else process.env.OMNIROUTE_STRICT_SYSTEM_PROVIDERS = saved;
  }
});

test("#7301: without the env entry the same request is passed through untouched (documents the trap)", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "system", content: "Memory context: user prefers terse answers" },
    { role: "user", content: "summarize" },
  ];

  const saved = process.env.OMNIROUTE_STRICT_SYSTEM_PROVIDERS;
  delete process.env.OMNIROUTE_STRICT_SYSTEM_PROVIDERS;
  try {
    const result = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "qwen3.8-27b",
      { model: "qwen3.8-27b", messages },
      false,
      null,
      CUSTOM_CONN
    );
    // untouched: same array shape, system still at index 1 — the 400-producing
    // shape for strict upstreams. This documents that opt-in is per-deployment.
    const out = result.messages as Array<{ role: string }>;
    assert.equal(out[1].role, "system");
  } finally {
    if (saved !== undefined) process.env.OMNIROUTE_STRICT_SYSTEM_PROVIDERS = saved;
  }
});
