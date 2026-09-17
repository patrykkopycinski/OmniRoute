/**
 * verify-agentic-stall-instructed-terminal.mjs — standing A/B harness for the
 * request-instructed-terminal exemption in the agentic-stall guard.
 *
 * Why it exists: this image executes the BUILT Turbopack chunks (see
 * open-sse/services/combo/agenticStall.ts for the source of truth), so a `.ts`
 * change is inert until the chunks are patched and the process reloads.
 * This harness drives the DEPLOYED bytes directly, giving red/green on the
 * change independent of process state — the same contract as
 * verify_deployed_classifier.mjs.
 *
 * Usage (inside the container):
 *   node verify_instructed_terminal.mjs $(grep -rl 'no tool_calls on tool-result tail' \
 *     /app/.build/next/server/chunks/*.js)
 * Exit 0 = every copy behaves as expected.
 */
import fs from "node:fs";

const SIGNATURE = "agentic_stall_no_toolcall";
const MODULE_START = /(\d+),e=>\{\s*"use strict";\s*let t="agentic_stall_no_toolcall";/;

const toolTail = (instruction) => ({
  model: "best-reasoning-paid",
  stream: true,
  tools: [{ type: "function", function: { name: "read_file" } }],
  messages: [
    { role: "system", content: instruction },
    { role: "user", content: "run the sweep" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
    { role: "tool", tool_call_id: "c1", content: "sweep complete: 0 unanswered threads" },
  ],
});

const sse = (content, finish = "stop") =>
  `data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n` +
  `data: {"choices":[{"delta":{"content":${JSON.stringify(content)}},"finish_reason":null}]}\n\n` +
  `data: {"choices":[{"delta":{},"finish_reason":${JSON.stringify(finish)}}]}\n\n` +
  `data: [DONE]\n\n`;

const resp = (p) =>
  new Response(p, { status: 200, headers: { "content-type": "text/event-stream" } });

function loadFactory(source, file) {
  const start = source.search(MODULE_START);
  if (start < 0) throw new Error(`${file}: module factory anchor not found`);
  const arrowStart = source.indexOf("e=>{", start);
  const regIdx = source.indexOf('e.s(["AGENTIC_STALL_SIGNATURE"', arrowStart);
  if (regIdx < 0) throw new Error(`${file}: export registration anchor not found`);
  const close = source.indexOf("])", regIdx);
  const end = close + 2;
  if (source[end] !== "}") throw new Error(`${file}: factory close brace not where expected`);
  const factorySrc = source.slice(arrowStart, end + 1);
  // new Function is safe: the input is our own Docker build artifact, never external input.
  // eslint-disable-next-line no-new-func
  return new Function(`return (${factorySrc});`)();
}

function instantiate(factory) {
  const mod = {};
  factory({
    s: (arr) => {
      for (let i = 0; i < arr.length; i += 3) mod[arr[i]] = arr[i + 2];
    },
  });
  return mod;
}

const REVIEW_BRIEF =
  "Review the conversation above. If nothing is worth saving, just say 'Nothing to save.' and stop.";

const CASES = [
  {
    name: "lane brief quotes 'Nothing to save.' → echo → NOT a stall",
    body: toolTail(REVIEW_BRIEF),
    text: "Nothing to save.",
    expectStall: false,
  },
  {
    name: "control: SAME echo, brief does NOT quote it → STALL",
    body: toolTail("You are a tool runner. Keep going."),
    text: "Nothing to save.",
    expectStall: true,
  },
  {
    name: "control: summary narration, no quote → STALL",
    body: toolTail(REVIEW_BRIEF),
    text: "<summary>\n## Overview\nsweep…\n</summary>",
    expectStall: true,
  },
  {
    name: "control: silence token still exempt",
    body: toolTail("Reply [SILENT] if nothing to report."),
    text: "[SILENT]",
    expectStall: false,
  },
  {
    name: "control: blocked report still exempt",
    body: toolTail("You are a tool runner."),
    text: "Blocked: #291310 still OPEN with no merged fix PR",
    expectStall: false,
  },
  {
    name: "control: uninstructed short prose → STALL",
    body: toolTail("You are a tool runner."),
    text: "Treatment arm done, both cells pinned clean.",
    expectStall: true,
  },
];

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node verify_instructed_terminal.mjs <chunk.js> [...]");
  process.exit(2);
}
let failed = 0;
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes(SIGNATURE)) {
    console.log(`${file}: no agentic-stall signature — skipped`);
    continue;
  }
  let mod;
  try {
    mod = instantiate(loadFactory(source, file));
  } catch (err) {
    console.log(`${file}: EXTRACT-FAIL ${err.message}`);
    failed++;
    continue;
  }
  const classify = mod.classifyAgenticStallResponse;
  if (typeof classify !== "function") {
    console.log(`${file}: no classifyAgenticStallResponse export`);
    failed++;
    continue;
  }
  for (const c of CASES) {
    let verdict = null;
    try {
      verdict = await classify({ body: c.body, response: resp(sse(c.text)) });
    } catch (err) {
      console.log(`${file}: ${c.name} → THREW ${err.message}`);
      failed++;
      continue;
    }
    const gotStall = verdict !== null;
    const ok = gotStall === c.expectStall;
    if (!ok) failed++;
    console.log(`${file}: ${ok ? "ok  " : "FAIL"} ${c.name} → ${gotStall ? "STALL" : "not-a-stall"}`);
  }
}
console.log(failed === 0 ? "RESULT: MATCH" : `RESULT: ${failed} MISMATCH(ES)`);
process.exit(failed === 0 ? 0 : 1);
