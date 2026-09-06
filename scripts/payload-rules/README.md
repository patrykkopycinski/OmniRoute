# Payload transform rules — policy and tooling

Per-model deterministic prompt adaptation, shipped as an extension of the
payload-rules engine (#2986 lineage). This document records the operating
policy and the tooling that enforces it.

## What ships

| Layer                 | Where                               | Behavior                                                                                                                                                    |
| --------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transform` rule type | `open-sse/services/payloadRules.ts` | `append`/`prepend`/`replace`/`regex` ops on dotted string paths, wildcard model match, protocol scoping. Off by default: no rules = byte-identical traffic. |
| Trace diff            | call-log `payloadRuleDiff`          | Every applied transform persists bounded before/after snippets + lengths to the call log; visible in the logs detail UI and API.                            |
| Dashboard             | Settings → Payload Rules            | JSON editor round-trips the full config including `transform`; summary chips + rule cards included.                                                         |
| Golden gate           | `scripts/payload-rules/gate.mjs`    | Deterministic replay of a candidate rule set against a golden prompt set. Fails on: payload mismatch, invalid rules, zero coverage (rule matched nothing).  |
| LLM suggester         | `scripts/payload-rules/suggest.mjs` | Offline proposal of rules by an LLM. Output has zero authority: the candidate MUST pass the golden gate before promotion. Never touches live config.        |

## Policy (research-backed)

Deep research (`~/Projects/research-llm-prompt-rewriting-2026-09-05.md`, 22+
projects) found **no credible gateway ships LLM rewriting in the hot path**.
Live rewriters that exist add 100–500ms p50 and can silently degrade output
(RAG-Fusion's own paper documents this; DMQR-RAG shows rewrites sometimes
underperform the unmodified prompt). The credible pattern is offline
compilation (DSPy/OPRO): LLM proposes once, deterministic artifact serves.

Therefore:

1. **Rejected**: LLM-in-the-loop rewriting of live requests. Do not build.
2. **The gate is mandatory**: no transform rule is promoted without passing
   `gate.mjs` against a golden set that covers the targeted model pattern.
3. **LLM proposals are advisory only**: `suggest.mjs` output must pass the
   gate and human review before promotion via the payload-rules API.
4. **Rules are frozen once live**: hot-path behavior is deterministic and
   diffable; every application is traceable in the call log.

## Matching: resolved model id, not the alias

Rules match the **resolved** model id, not the alias or combo name the client
requested. Matching happens after routing, so by the time rules run the
`provider/` prefix is gone and combo names have already fanned out.

```jsonc
// never fires — 'qwen38a100/...' is an alias, resolved before rules run
{ "models": [{ "name": "qwen38a100/qwen3.8-27b" }] }

// fires
{ "models": [{ "name": "qwen3.8-27b" }] }
```

The same applies to combo names (`main`, `cheap`, ...): scope rules to the
model ids the combo fans out to, not the combo itself.

An alias-scoped rule fails **silently** — no error, no log line, the transform
just never applies. The settings UI flags patterns that carry a provider prefix
or name no known model (`src/lib/payloadRules/transformPatternWarnings.ts`), but
the warning is advisory: a pattern targeting a model this build's registry does
not know (custom provider, newly released model) is legal and still saved.

## Golden set format

```json
{
  "cases": [
    {
      "name": "unique-case-name",
      "model": "target-model-pattern-match",
      "protocol": "openai",
      "payload": { "messages": [{ "role": "user", "content": "..." }] },
      "expect": { "messages": [{ "role": "user", "content": "... after transform ..." }] }
    }
  ]
}
```

`expect` is the exact payload after rules apply (deep JSON equality). Include
at least one case whose model matches the rule (coverage) and one that must
stay untouched (blast-radius control). See `golden.example.json`.

## Usage

```bash
# Gate a hand-written or LLM-proposed candidate
node --import tsx/esm scripts/payload-rules/gate.mjs \
  --rules candidate.json --golden golden.example.json

# Ask an LLM to propose rules (offline; writes candidate + verdict, promotes nothing)
node --import tsx/esm scripts/payload-rules/suggest.mjs \
  --problem problem.json --golden golden.example.json \
  --out candidate.json --model judge

# Promote after review (normal config path)
curl -X PUT http://localhost:20128/api/settings/payload-rules -d @full-config.json
```
