import test from "node:test";
import assert from "node:assert/strict";
import {
  applyComboStepParams,
  mergeReasoningIntoContentIfEmpty,
  applyComboStepResponseGuards,
} from "../../open-sse/services/combo/stepParams.ts";

// ─── applyComboStepParams: maxTokens ───

test("params: maxTokens clamps a larger client max_tokens downward", () => {
  const body = { max_tokens: 64000 };
  applyComboStepParams(body, { maxTokens: 12288 });
  assert.equal(body.max_tokens, 12288);
});

test("params: maxTokens NEVER raises a smaller client limit (never-enlarge contract)", () => {
  const body = { max_tokens: 500 };
  applyComboStepParams(body, { maxTokens: 12288 });
  assert.equal(body.max_tokens, 500);
});

test("params: maxTokens imposed when client set no limit (64k-default class)", () => {
  const body: Record<string, unknown> = {};
  applyComboStepParams(body, { maxTokens: 12288 });
  assert.equal(body.max_tokens, 12288);
});

test("params: maxTokens writes whichever key the client used (max_completion_tokens)", () => {
  const body: Record<string, unknown> = { max_completion_tokens: 40000 };
  applyComboStepParams(body, { maxTokens: 8192 });
  assert.equal(body.max_completion_tokens, 8192);
  assert.equal(body.max_tokens, undefined);
});

test("params: null/undefined params leave body untouched (off-by-default)", () => {
  const body = { max_tokens: 1000, reasoning_effort: "high" };
  applyComboStepParams(body, null);
  applyComboStepParams(body, undefined);
  applyComboStepParams(body, {});
  assert.deepEqual(body, { max_tokens: 1000, reasoning_effort: "high" });
});

// ─── applyComboStepParams: thinking off ───

test("params: thinking off sets flat chat_template_kwargs (raw-HTTP SGLang reads it top-level)", () => {
  const body: Record<string, unknown> = {};
  applyComboStepParams(body, { thinking: "off" });
  // FLAT is the wire shape raw-HTTP SGLang/vLLM actually parse; nested-only
  // values are silently ignored (live-verified 2026-09-15).
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  // extra_body copy for SDK-style consumers that unwrap it client-side.
  assert.deepEqual(body.extra_body?.chat_template_kwargs, { enable_thinking: false });
  assert.equal(body.reasoning_effort, undefined);
});

test("params: thinking off drops client reasoning_effort (could re-enable upstream)", () => {
  const body = { reasoning_effort: "high" };
  applyComboStepParams(body, { thinking: "off" });
  assert.equal(body.reasoning_effort, undefined);
});

test("params: thinking off PRESERVES existing extra_body keys", () => {
  const body: Record<string, unknown> = { extra_body: { top_k: 5 } };
  applyComboStepParams(body, { thinking: "off" });
  assert.equal(body.extra_body.top_k, 5);
  assert.equal(body.extra_body.chat_template_kwargs.enable_thinking, false);
  assert.equal(body.chat_template_kwargs.enable_thinking, false);
});

// ─── applyComboStepParams: extraBody merge ───

test("params: extraBody shallow-merges per key, step value wins", () => {
  const body = { extra_body: { keep: 1, over: "client" } };
  applyComboStepParams(body, { extraBody: { over: "step", add: true } });
  assert.deepEqual(body.extra_body, { keep: 1, over: "step", add: true });
});

test("params: extraBody creates extra_body when absent", () => {
  const body: Record<string, unknown> = {};
  applyComboStepParams(body, { extraBody: { seed: 7 } });
  assert.deepEqual(body.extra_body, { seed: 7 });
});

// ─── mergeReasoningIntoContentIfEmpty ───

test("merge: empty content + reasoning → content gets reasoning, reasoning dropped", () => {
  const out = mergeReasoningIntoContentIfEmpty(
    { content: "", reasoning_content: "facts: espresso" },
    true
  );
  assert.equal(out.content, "facts: espresso");
  assert.equal(out.reasoning_content, undefined);
});

test("merge: no-op when content already populated", () => {
  const out = mergeReasoningIntoContentIfEmpty(
    { content: "already here", reasoning_content: "thoughts" },
    true
  );
  assert.equal(out, null);
});

test("merge: no-op when disabled (default)", () => {
  const out = mergeReasoningIntoContentIfEmpty(
    { content: "", reasoning_content: "facts" },
    undefined
  );
  assert.equal(out, null);
});

test("merge: no-op when reasoning absent", () => {
  const out = mergeReasoningIntoContentIfEmpty({ content: "" }, true);
  assert.equal(out, null);
});

// ─── combo-ref params (inheritance + override) ───
test("ref params: normalizer keeps params on combo-ref steps", async () => {
  const { normalizeComboStep } = await import("../../src/lib/combos/steps.ts");
  const step = normalizeComboStep(
    {
      kind: "combo-ref",
      comboName: "qwen38-local",
      params: { maxTokens: 12288 },
    },
    { comboName: "memory", index: 0 }
  );
  if (!step || step.kind !== "combo-ref") throw new Error("not a combo-ref step");
  assert.deepEqual(step.params, { maxTokens: 12288 });
});
test("ref params: combo-ref without params stays params-free", async () => {
  const { normalizeComboStep } = await import("../../src/lib/combos/steps.ts");
  const step = normalizeComboStep(
    {
      kind: "combo-ref",
      comboName: "qwen38-local",
    },
    { comboName: "memory", index: 0 }
  );
  if (!step || step.kind !== "combo-ref") throw new Error("not a combo-ref step");
  assert.equal(step.params, undefined);
});
test("ref params: ref params OVERRIDE nested model-step params on expansion", async () => {
  const { resolveNestedComboTargets } =
    await import("../../open-sse/services/combo/comboStructure.ts");
  const nestedCombo = {
    name: "qwen38-local",
    models: [
      {
        kind: "model",
        id: "a",
        model: "qwen38a100/qwen3.8-27b",
        params: { maxTokens: 999, thinking: "on" },
      },
      { kind: "model", id: "b", model: "qwen38a100b/qwen3.8-27b" },
    ],
    strategy: "round-robin",
  };
  const parentCombo = {
    name: "memory",
    models: [
      {
        kind: "combo-ref",
        id: "r1",
        comboName: "qwen38-local",
        params: { maxTokens: 12288, thinking: "off" },
      },
      { kind: "model", id: "m1", model: "openrouter/deepseek/deepseek-v4.1-flash" },
    ],
    strategy: "priority",
  };
  const targets = resolveNestedComboTargets(parentCombo, [parentCombo, nestedCombo]);
  const qwenTargets = targets.filter((t: { modelStr: string; params?: Record<string, unknown> }) =>
    String(t.modelStr).includes("qwen")
  );
  assert.equal(qwenTargets.length, 2);
  for (const t of qwenTargets) {
    assert.deepEqual(t.params, { maxTokens: 12288, thinking: "off" });
  }
  // nested's own 999/thinking:on must NOT survive on the qwen38a100 target
  const a = qwenTargets.find((t: { modelStr: string; params?: Record<string, unknown> }) =>
    t.modelStr.includes("qwen38a100/")
  );
  assert.notEqual(a.params?.maxTokens, 999);
});
test("ref params: no ref params → nested model-step params survive untouched", async () => {
  const { resolveNestedComboTargets } =
    await import("../../open-sse/services/combo/comboStructure.ts");
  const nestedCombo = {
    name: "qwen38-local",
    models: [
      { kind: "model", id: "a", model: "qwen38a100/qwen3.8-27b", params: { maxTokens: 4096 } },
    ],
    strategy: "round-robin",
  };
  const parentCombo = {
    name: "parent",
    models: [{ kind: "combo-ref", id: "r1", comboName: "qwen38-local" }],
    strategy: "priority",
  };
  const targets = resolveNestedComboTargets(parentCombo, [parentCombo, nestedCombo]);
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0].params, { maxTokens: 4096 });
});

// ─── execute-mode (runtimeUnits) params ───
test("execute: model unit applies params to a body copy (shared body untouched)", async () => {
  const { executeRuntimeUnitCombo } = await import("../../open-sse/services/combo/runtimeUnits.ts");
  const sharedBody: Record<string, unknown> = { max_tokens: 64000 };
  const seen: Array<Record<string, unknown>> = [];
  const handleSingleModel = async (body: Record<string, unknown>) => {
    seen.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      headers: { "content-type": "application/json" },
    });
  };
  const combo = { name: "t", models: [], strategy: "priority", config: {} };
  await executeRuntimeUnitCombo({
    body: sharedBody,
    combo,
    strategy: "priority",
    units: [
      {
        kind: "model",
        stepId: "s1",
        executionKey: "k1",
        modelStr: "qwen38a100/qwen3.8-27b",
        provider: "qwen38a100",
        providerId: null,
        connectionId: null,
        allowedConnectionIds: null,
        tags: null,
        prompt: null,
        fingerprint: null,
        label: null,
        weight: 0,
        params: { maxTokens: 12288, thinking: "off" },
      } as never,
    ],
    handleSingleModel: handleSingleModel as never,
    log: { info() {}, warn() {}, error() {} } as never,
    config: { maxRetries: 0 },
    allCombos: [],
    nesting: {
      depth: 0,
      maxDepth: 3,
      visitedComboNames: ["t"],
      attemptBudget: { count: 0, limit: 10 },
    } as never,
    baseOptions: {} as never,
    runCombo: (async () => new Response("x")) as never,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].max_tokens, 12288, "cap applied on dispatch body");
  assert.deepEqual(
    Object.keys(seen[0]).includes("chat_template_kwargs"),
    true,
    "thinking knob present"
  );
  assert.equal(sharedBody.max_tokens, 64000, "shared body MUST stay untouched");
});
test("execute: response guard merges empty-content + reasoning before quality check", async () => {
  const { executeRuntimeUnitCombo } = await import("../../open-sse/services/combo/runtimeUnits.ts");
  const handleSingleModel = async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "", reasoning_content: "facts" } }] }),
      {
        headers: { "content-type": "application/json" },
      }
    );
  const combo = { name: "t", models: [], strategy: "priority", config: {} };
  const out = await executeRuntimeUnitCombo({
    body: {},
    combo,
    strategy: "priority",
    units: [
      {
        kind: "model",
        stepId: "s1",
        executionKey: "k1",
        modelStr: "m",
        provider: "p",
        providerId: null,
        connectionId: null,
        allowedConnectionIds: null,
        tags: null,
        prompt: null,
        fingerprint: null,
        label: null,
        weight: 0,
        params: { mergeReasoningIntoContent: true },
      } as never,
    ],
    handleSingleModel: handleSingleModel as never,
    log: { info() {}, warn() {}, error() {} } as never,
    config: { maxRetries: 0 },
    allCombos: [],
    nesting: {
      depth: 0,
      maxDepth: 3,
      visitedComboNames: ["t"],
      attemptBudget: { count: 0, limit: 10 },
    } as never,
    baseOptions: {} as never,
    runCombo: (async () => new Response("x")) as never,
  });
  const parsed = await out.response.clone().json();
  assert.equal(parsed.choices[0].message.content, "facts");
  assert.equal(parsed.choices[0].message.reasoning_content, undefined);
});
test("execute: no params → body passed through verbatim (no shaping)", async () => {
  const { executeRuntimeUnitCombo } = await import("../../open-sse/services/combo/runtimeUnits.ts");
  const seen: Array<Record<string, unknown>> = [];
  const handleSingleModel = async (body: Record<string, unknown>) => {
    seen.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      headers: { "content-type": "application/json" },
    });
  };
  const combo = { name: "t", models: [], strategy: "priority", config: {} };
  await executeRuntimeUnitCombo({
    body: { temperature: 0.7 },
    combo,
    strategy: "priority",
    units: [
      {
        kind: "model",
        stepId: "s1",
        executionKey: "k1",
        modelStr: "m",
        provider: "p",
        providerId: null,
        connectionId: null,
        allowedConnectionIds: null,
        tags: null,
        prompt: null,
        fingerprint: null,
        label: null,
        weight: 0,
      } as never,
    ],
    handleSingleModel: handleSingleModel as never,
    log: { info() {}, warn() {}, error() {} } as never,
    config: { maxRetries: 0 },
    allCombos: [],
    nesting: {
      depth: 0,
      maxDepth: 3,
      visitedComboNames: ["t"],
      attemptBudget: { count: 0, limit: 10 },
    } as never,
    baseOptions: {} as never,
    runCombo: (async () => new Response("x")) as never,
  });
  assert.deepEqual(seen[0], { temperature: 0.7 });
});

// ── stripResponseFormat ──────────────────────────────────────────────
test("stripResponseFormat=true removes response_format from body", () => {
  const body = {
    model: "m",
    messages: [],
    response_format: { type: "json_object" },
    max_tokens: 512,
  };
  applyComboStepParams(body, { stripResponseFormat: true });
  assert.equal(body.response_format, undefined);
  assert.ok(!("response_format" in body));
  assert.equal(body.max_tokens, 512); // untouched
});

test("stripResponseFormat absent keeps response_format", () => {
  const body = { model: "m", messages: [], response_format: { type: "json_object" } };
  applyComboStepParams(body, {});
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("stripResponseFormat=false (explicit) keeps response_format", () => {
  const body = { model: "m", messages: [], response_format: { type: "json_object" } };
  applyComboStepParams(body, { stripResponseFormat: false });
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("stripResponseFormat composes with maxTokens + thinking off", () => {
  const body = {
    model: "m",
    messages: [],
    response_format: { type: "json_object" },
    max_tokens: 64000,
  };
  applyComboStepParams(body, { stripResponseFormat: true, maxTokens: 12288, thinking: "off" });
  assert.ok(!("response_format" in body));
  assert.equal(body.max_tokens, 12288);
  assert.equal((body.chat_template_kwargs as Record<string, unknown>).enable_thinking, false);
});

// ─── applyComboStepResponseGuards ───

test("guards: non-stream JSON with empty content gets reasoning merged into content", async () => {
  const payload = {
    choices: [{ message: { content: "", reasoning_content: "the answer" } }],
  };
  const res = new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
  const out = await applyComboStepResponseGuards(res, { mergeReasoningIntoContent: true }, false);
  const parsed = await out.json();
  assert.equal(parsed.choices[0].message.content, "the answer");
  assert.equal(parsed.choices[0].message.reasoning_content, undefined);
});

test("guards: skips streaming requests", async () => {
  const payload = { choices: [{ message: { content: "", reasoning_content: "x" } }] };
  const res = new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
  const out = await applyComboStepResponseGuards(res, { mergeReasoningIntoContent: true }, true);
  assert.equal(out, res);
});

// ─── guards: content-length integrity after merge (live incident 2026-09-15) ───
test("guards: merged response content-length matches body (no stale CL)", async () => {
  const payload = {
    choices: [{ message: { content: "", reasoning_content: "the answer" } }],
    usage: { prompt_tokens: 100, completion_tokens: 5 },
  };
  // Simulate the upstream: a Response whose serialized body is LONGER than
  // the post-merge body will be (reasoning_content gets dropped on merge).
  const res = new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json",
      // deliberately WRONG (stale) length, as the gateway used to forward
      "content-length": String(JSON.stringify(payload).length + 23),
    },
  });
  const out = await applyComboStepResponseGuards(res, { mergeReasoningIntoContent: true }, false);
  const bodyText = await out.text();
  const raw = out.headers.get("content-length");
  // Contract: after a merge the response must NEVER carry a stale CL.
  // Either CL is absent (server frames chunked — correct) or it exactly
  // equals the real body length. Anything else breaks strict HTTP clients.
  assert.ok(
    raw === null || Number(raw) === bodyText.length,
    `stale content-length ${raw} vs body length ${bodyText.length}`
  );
  const parsed = JSON.parse(bodyText);
  assert.equal(parsed.choices[0].message.content, "the answer");
});
test("guards: non-merged passthrough preserves original CL (untouched path)", async () => {
  const payload = { choices: [{ message: { content: "already", reasoning_content: "r" } }] };
  const res = new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
  const out = await applyComboStepResponseGuards(res, { mergeReasoningIntoContent: true }, false);
  assert.equal(out, res);
});

test("guards: skips when content already present", async () => {
  const payload = { choices: [{ message: { content: "fine", reasoning_content: "x" } }] };
  const res = new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
  const out = await applyComboStepResponseGuards(res, { mergeReasoningIntoContent: true }, false);
  assert.equal(out, res);
});

test("guards: skips non-JSON responses (SSE etc.) and absent params", async () => {
  const res = new Response("data: hi", { headers: { "content-type": "text/event-stream" } });
  assert.equal(
    await applyComboStepResponseGuards(res, { mergeReasoningIntoContent: true }, false),
    res
  );
  const jres = new Response("{}", { headers: { "content-type": "application/json" } });
  assert.equal(await applyComboStepResponseGuards(jres, null, false), jres);
});

test("guards: survives unparseable JSON body", async () => {
  const res = new Response("not json{", { headers: { "content-type": "application/json" } });
  const out = await applyComboStepResponseGuards(res, { mergeReasoningIntoContent: true }, false);
  assert.equal(out, res);
});
