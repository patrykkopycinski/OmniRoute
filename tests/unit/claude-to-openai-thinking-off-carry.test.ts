import test from "node:test";
import assert from "node:assert/strict";

const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { claudeToOpenAIRequest } = await import("../../open-sse/translator/request/claude-to-openai.ts");
const { applyComboStepParams } = await import("../../open-sse/services/combo/stepParams.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

const COMPAT = "openai-compatible-chat-7f66e42d-518d-4337-bd14-06848f4c9326";

function titleBody(extra: Record<string, unknown> = {}) {
  return {
    model: "local-fast",
    max_tokens: 32,
    system: "Generate a 3-7 word title",
    messages: [{ role: "user", content: "calc.py has a bug in add(). Fix it." }],
    ...extra,
  };
}

function viaTranslator(body: Record<string, unknown>, provider: string = COMPAT) {
  return translateRequest(
    FORMATS.CLAUDE,
    FORMATS.OPENAI,
    "qwen3.8-flash-next",
    body,
    false,
    null,
    provider
  ) as Record<string, any>;
}

test("combo step thinking:off survives Claude -> OpenAI translation (flat + extra_body)", () => {
  const body = titleBody({ output_config: { effort: "high" } });
  applyComboStepParams(body, { thinking: "off" });
  const out = viaTranslator(body);
  assert.equal(out.chat_template_kwargs?.enable_thinking, false);
  assert.equal(out.extra_body?.chat_template_kwargs?.enable_thinking, false);
  assert.equal(out.reasoning_effort, undefined);
  assert.equal(out.max_tokens, 32);
});

test("combo step extraBody survives Claude -> OpenAI translation", () => {
  const body = titleBody();
  applyComboStepParams(body, { extraBody: { top_k: 20 } });
  const out = viaTranslator(body);
  assert.equal(out.extra_body?.top_k, 20);
});

test("Anthropic thinking:{type:disabled} maps to enable_thinking=false for openai-compatible targets", () => {
  const out = viaTranslator(titleBody({ thinking: { type: "disabled" }, output_config: { effort: "high" } }));
  assert.equal(out.chat_template_kwargs?.enable_thinking, false);
  assert.equal(out.extra_body?.chat_template_kwargs?.enable_thinking, false);
  assert.equal(out.reasoning_effort, undefined);
});

test("thinking:disabled is NOT mapped for non-openai-compatible providers", () => {
  const out = viaTranslator(titleBody({ thinking: { type: "disabled" } }), "openai");
  assert.equal(out.chat_template_kwargs, undefined);
  assert.equal(out.extra_body, undefined);
});

test("no step params and no thinking opt-out: nothing injected (local-reasoning unchanged)", () => {
  const out = viaTranslator(titleBody({ thinking: { type: "enabled", budget_tokens: 4000 } }));
  assert.equal(out.chat_template_kwargs, undefined);
  assert.equal(out.extra_body, undefined);
  assert.equal(out.reasoning_effort, "medium");
  const plain = viaTranslator(titleBody());
  assert.equal(plain.chat_template_kwargs, undefined);
});

test("claudeToOpenAIRequest carries chat_template_kwargs without provider hint", () => {
  const out = claudeToOpenAIRequest(
    "m",
    titleBody({ chat_template_kwargs: { enable_thinking: false, foo: 1 } }),
    false
  ) as Record<string, any>;
  assert.deepEqual(out.chat_template_kwargs, { enable_thinking: false, foo: 1 });
});
