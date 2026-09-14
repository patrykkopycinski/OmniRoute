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
  const body: Record<string, any> = {};
  applyComboStepParams(body, { maxTokens: 12288 });
  assert.equal(body.max_tokens, 12288);
});

test("params: maxTokens writes whichever key the client used (max_completion_tokens)", () => {
  const body: Record<string, any> = { max_completion_tokens: 40000 };
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
  const body: Record<string, any> = {};
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
  const body: Record<string, any> = { extra_body: { top_k: 5 } };
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
  const body: Record<string, any> = {};
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
