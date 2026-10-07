/**
 * t_f53bc5fd: session-dedup must never touch the current turn (latest user
 * message + everything after it), and never whole-message-replace a user msg.
 * Run: node --import tsx/esm --test tests/unit/compression/session-dedup-current-turn-f53bc5fd.test.ts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { sessionDedupEngine } from "../../../open-sse/services/compression/engines/session-dedup/index.ts";

const NUDGE = `[System: You edited code in this turn.
Files changed: src/app.ts, src/lib.ts.
Verification status: stale — the test suite has not been re-run since these edits.
Next step: run the relevant tests and report real output before claiming completion.
Do not stop after describing work; verify it.]`;

describe("session-dedup current-turn protection (t_f53bc5fd)", () => {
  before(() => {});

  const apply = (messages: unknown[]) =>
    sessionDedupEngine.apply({ model: "gpt-4", messages }, { stepConfig: {} });

  it("AC1a: repeated nudge as latest user msg followed by tool_call + tool result stays untouched", () => {
    const messages = [
      { role: "user", content: `Earlier turn instructions:\n${NUDGE}` },
      { role: "assistant", content: "Understood, working on it." },
      { role: "user", content: `Current turn instructions:\n${NUDGE}` },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "x" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] },
    ];
    const { body } = apply(messages);
    const out = (body as { messages: Array<{ role: string; content: unknown }> }).messages;
    assert.equal(out[2].content, `Current turn instructions:\n${NUDGE}`);
    assert.equal(JSON.stringify(out[3]).includes("tool_use"), true);
    assert.equal(JSON.stringify(out[4]).includes("file body"), true);
  });

  it("AC1b: an identical earlier duplicate of the latest user message (multipart) stays untouched", () => {
    const part = { type: "text", text: NUDGE };
    const messages = [
      { role: "user", content: [part] },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "text", text: NUDGE }] },
    ];
    const { body } = apply(messages);
    const out = (body as { messages: Array<{ role: string; content: unknown }> }).messages;
    const latest = out[2].content as Array<{ type: string; text: string }>;
    const textPart = latest.find((p) => p.type === "text");
    assert.equal(textPart?.text, NUDGE);
  });

  it("AC2: an earlier duplicate user message is never reduced to a whole-message marker", () => {
    const messages = [
      { role: "user", content: `Header line one.\n${NUDGE}` },
      { role: "assistant", content: "ok" },
      { role: "user", content: `Other header.\n${NUDGE}` },
      { role: "assistant", content: "done" },
    ];
    const { body } = apply(messages);
    const out = (body as { messages: Array<{ role: string; content: unknown }> }).messages;
    const dup = out[2].content as string;
    assert.ok(dup.length > 0, "earlier user message must keep text");
    assert.match(dup, /^Other header\./);
    // the repeated block inside history may still be replaced, but never the whole message
    assert.ok(!/^\[dedup:ref/.test(dup), "no whole-message dedup marker on a user message");
  });

  it("AC3: repeated NUDGE blocks in earlier history still dedup (regression guard)", () => {
    const messages = [
      { role: "user", content: `First:\n${NUDGE}` },
      { role: "assistant", content: "ok" },
      { role: "user", content: `Second:\n${NUDGE}` },
      { role: "assistant", content: "ok" },
      { role: "user", content: "final unrelated question?" },
    ];
    const res = apply(messages);
    const out = (res.body as { messages: Array<{ role: string; content: unknown }> }).messages;
    const dup = out[2].content as string;
    assert.match(dup, /\[dedup:ref sha=[0-9a-f]{24}\]/);
    assert.equal(out[4].content, "final unrelated question?");
    assert.equal(res.compressed, true);
  });

  it("AC2a (mutation-proof): earlier user message whose ENTIRE text duplicates a prior message is never collapsed to a bare marker", () => {
    // single-line duplicate: its only suffix block IS the whole message, so a
    // removed guard would replace it with a bare [dedup:ref] marker
    const BLOB = [
      "You edited code in this turn.",
      "Files changed: src/app.ts, src/lib.ts.",
      "Verification status: stale — the test suite has not been re-run since these edits.",
    ].join("\n");
    const messages = [
      { role: "assistant", content: BLOB },
      { role: "user", content: BLOB }, // exact whole-text duplicate, earlier user msg
      { role: "user", content: "latest turn: unrelated question?" },
    ];
    const { body } = apply(messages);
    const out = (body as { messages: Array<{ role: string; content: unknown }> }).messages;
    const dup = out[1].content as string;
    assert.equal(
      dup,
      BLOB,
      "earlier user message stays verbatim, whole-message replacement forbidden"
    );
  });

  it("AC2b (mutation-proof): multipart user text part that wholly duplicates an earlier message keeps its text (string and image_url variants)", () => {
    const BLOB = [
      "You edited code in this turn.",
      "Files changed: src/app.ts, src/lib.ts.",
      "Verification status: stale — the test suite has not been re-run since these edits.",
    ].join("\n");
    const textOnly = [
      { role: "assistant", content: BLOB },
      { role: "user", content: [{ type: "text", text: BLOB }] },
      { role: "user", content: "latest turn: unrelated question?" },
    ];
    const withImage = [
      { role: "assistant", content: BLOB },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "https://x/img.png" } },
          { type: "text", text: BLOB },
        ],
      },
      { role: "user", content: "latest turn: unrelated question?" },
    ];
    for (const messages of [textOnly, withImage]) {
      const { body } = apply(messages);
      const out = (body as { messages: Array<{ role: string; content: unknown }> }).messages;
      const parts = out[1].content as Array<{ type: string; text?: string }>;
      const textPart = parts.find((p) => p.type === "text")!;
      assert.equal(
        textPart.text,
        BLOB,
        "multipart user text part stays verbatim, never a bare marker"
      );
    }
  });

  it("AC2c (fuzzy, mutation-proof): an earlier near-duplicate USER message is never whole-replaced with a CCR marker", () => {
    const A =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho";
    const messages = [
      { role: "assistant", content: A },
      { role: "user", content: `${A} sigma` }, // near-dup user msg in history (a latest user follows)
      { role: "user", content: "latest turn instruction: continue" },
    ];
    const { body } = sessionDedupEngine.apply(
      {
        model: "gpt-4",
        messages,
        tools: [{ type: "function", function: { name: "omniroute_ccr_retrieve" } }],
      },
      { stepConfig: { fuzzy: { enabled: true } }, principalId: "p1" }
    );
    const out = (body as { messages: Array<{ role: string; content: unknown }> }).messages;
    assert.equal(
      out[1].content,
      `${A} sigma`,
      "user messages are excluded from fuzzy whole-message replacement"
    );
  });
});
