// Basis-alignment regression: the combo pre-filter (comboStructure /
// capabilityFilter) and chatCore proactive compaction measure on the dense
// gate basis (GATE_CHARS_PER_TOKEN), so a target the filter accepts is one the
// gate will not reject for the same body, and proactive compaction triggers in
// the same band the gate enforces.
import test from "node:test";
import assert from "node:assert/strict";

import {
  GATE_CHARS_PER_TOKEN,
  estimateFinalInputTokens,
} from "../../open-sse/handlers/chatCore/contextEstimation.ts";
import { estimateTokens } from "../../open-sse/services/contextManager.ts";
import {
  checkRequestCapabilityFit,
  deriveRequestCapabilityRequirements,
} from "../../src/shared/constants/capabilities/capabilityFilter.ts";
import {
  deriveRequestCompatibilityRequirements,
} from "../../open-sse/services/combo/comboStructure.ts";

function bodyOfChars(chars: number) {
  // The filters estimate estimatePayload = { messages } — a wrapper of 13 chars
  // ("{"messages":...}" keys) around the message list JSON.
  const wrapper = 13 + JSON.stringify([{ role: "user", content: "" }]).length;
  return { messages: [{ role: "user", content: "x".repeat(chars - wrapper) }] };
}

test("pre-filter and gate agree: a char/4-fitting body the dense basis overflows is now rejected by the filter", () => {
  // Window 10_000: char/4 estimate must fit, dense estimate must not.
  const window = 10_000;
  // The dense divisor yields MORE tokens per char, so the dense estimate
  // overflows the window at fewer chars (window*3.25) than char/4 (window*4).
  // The disagreement band is (window*3.25, window*4): pick its midpoint.
  const lo = window * GATE_CHARS_PER_TOKEN + 1; // just past the dense overflow point
  const hi = window * 4; // the char/4 overflow point
  assert.ok(lo < hi, "fixture band: dense threshold below char/4 threshold");
  const chars = Math.floor((lo + hi) / 2); // between: dense estimate > window, char/4 <= window
  const body = bodyOfChars(chars);
  const dense = estimateFinalInputTokens(body);
  assert.ok(dense > window, `fixture: dense estimate must exceed the window (got ${dense})`);
  const char4 = estimateTokens({ messages: body.messages });
  assert.ok(char4 <= window, `fixture: char/4 estimate must fit the window (got ${char4})`);

  // capabilityFilter: char/4 would have accepted, dense rejects.
  const reqs = deriveRequestCapabilityRequirements(body);
  assert.ok(
    reqs.requiredContextTokens > window,
    `filter must see the dense estimate (got ${reqs.requiredContextTokens})`
  );
  const result = checkRequestCapabilityFit(
    {
      supportsTools: null,
      toolCalling: true,
      supportsVision: null,
      structuredOutput: null,
      contextWindow: window,
      maxInputTokens: window,
      maxOutputTokens: null,
    },
    reqs
  );
  assert.equal(result.compatible, false);
  assert.deepEqual(result.failures, ["context_window"]);

  // comboStructure pre-filter derives the same dense requirement.
  const comboReqs = deriveRequestCompatibilityRequirements(body as Record<string, unknown>);
  assert.equal(
    comboReqs.requiredContextTokens,
    reqs.requiredContextTokens,
    "combo pre-filter and Layer A filter must share the dense basis"
  );
});

test("chatCore proactive compaction: source measures messages on the dense basis", async () => {
  // Static source assertion (the full handler needs a DB + fetch stub; the basis
  // is what this commit changes). The proactive estimate and the tools reserve
  // must pass getGateCharsPerToken() to estimateTokens.
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../../open-sse/handlers/chatCore.ts", import.meta.url), "utf8")
  );
  assert.match(
    source,
    /estimatedTokens = estimateTokens\(allMessages, getGateCharsPerToken\(\)\)/,
    "proactive messages estimate must use the dense gate divisor"
  );
  assert.match(
    source,
    /reservedTokens = estimateTokens\(body\.tools, getGateCharsPerToken\(\)\)/,
    "proactive tools reserve must use the dense gate divisor"
  );
});
