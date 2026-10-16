import test from "node:test";
import assert from "node:assert/strict";

const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { claudeToOpenAIRequest } =
  await import("../../open-sse/translator/request/claude-to-openai.ts");
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
  ) as Record<string, unknown>;
}

test("body-level enable_thinking=false survives Claude -> OpenAI translation (flat + extra_body)", () => {
  const body = titleBody({
    output_config: { effort: "high" },
    chat_template_kwargs: { enable_thinking: false },
    extra_body: { chat_template_kwargs: { enable_thinking: false } },
  });
  const out = viaTranslator(body);
  assert.equal(out.chat_template_kwargs?.enable_thinking, false);
  assert.equal(out.extra_body?.chat_template_kwargs?.enable_thinking, false);
  assert.equal(out.reasoning_effort, undefined);
  assert.equal(out.max_tokens, 32);
});

test("body-level extra_body survives Claude -> OpenAI translation", () => {
  const body = titleBody({ extra_body: { top_k: 20 } });
  const out = viaTranslator(body);
  assert.equal(out.extra_body?.top_k, 20);
});

test("Anthropic thinking:{type:disabled} maps to enable_thinking=false for openai-compatible targets", () => {
  const out = viaTranslator(
    titleBody({ thinking: { type: "disabled" }, output_config: { effort: "high" } })
  );
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

test("claudeToOpenAIRequest carries chat_template_kwargs only for template-aware providers", () => {
  const body = titleBody({ chat_template_kwargs: { enable_thinking: false, foo: 1 } });
  const withHint = claudeToOpenAIRequest("m", body, false, { _provider: COMPAT }) as Record<
    string,
    unknown
  >;
  assert.deepEqual(withHint.chat_template_kwargs, { enable_thinking: false, foo: 1 });
  const noHint = claudeToOpenAIRequest("m", body, false) as Record<string, unknown>;
  assert.equal(noHint.chat_template_kwargs, undefined);
});

for (const provider of [
  "openai",
  "groq",
  "deepseek",
  "openrouter",
  "anthropic",
  "nvidia",
  "codex",
]) {
  test(`non-compatible provider ${provider} gets neither chat_template_kwargs nor extra_body`, () => {
    const body = titleBody({
      thinking: { type: "disabled" },
      chat_template_kwargs: { enable_thinking: false },
      extra_body: { top_k: 20, chat_template_kwargs: { enable_thinking: false } },
    });
    const out = viaTranslator(body, provider);
    assert.equal(out.chat_template_kwargs, undefined);
    assert.equal(out.extra_body, undefined);
  });
}

test("provider=null gets neither chat_template_kwargs nor extra_body", () => {
  const out = translateRequest(
    FORMATS.CLAUDE,
    FORMATS.OPENAI,
    "m",
    titleBody({ thinking: { type: "disabled" }, extra_body: { top_k: 20 } }),
    false,
    null,
    null
  ) as Record<string, unknown>;
  assert.equal(out.chat_template_kwargs, undefined);
  assert.equal(out.extra_body, undefined);
});

for (const provider of ["llama-cpp", "vllm", "ollama-local", "lm-studio"]) {
  test(`self-hosted provider ${provider} gets the thinking opt-out + extra_body carry`, () => {
    const out = viaTranslator(
      titleBody({ thinking: { type: "disabled" }, extra_body: { top_k: 20 } }),
      provider
    );
    assert.equal(out.chat_template_kwargs?.enable_thinking, false);
    assert.equal(out.extra_body?.chat_template_kwargs?.enable_thinking, false);
    assert.equal(out.extra_body?.top_k, 20);
  });
}

test("precedence: flat chat_template_kwargs.enable_thinking wins over extra_body's", () => {
  const out = viaTranslator(
    titleBody({
      chat_template_kwargs: { enable_thinking: true },
      extra_body: { chat_template_kwargs: { enable_thinking: false } },
    })
  );
  assert.equal(out.chat_template_kwargs?.enable_thinking, true);
  assert.equal(out.extra_body?.chat_template_kwargs?.enable_thinking, true);
});
