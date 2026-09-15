/**
 * tests/unit/agentic-stall-combo-wiring.test.ts — kanban t_1ebaf474
 *
 * Call-site coverage for the agentic-stall guard: the pure classifier is
 * tested in agentic-stall.test.ts; THIS file proves the combo loop actually
 * consumes it — a stalled primary member fails over to the next member, the
 * stall signature is logged, and legitimate responses pass through untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-agentic-stall-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { resetAllComboMetrics } = await import("../../open-sse/services/comboMetrics.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { resetAll: resetAllSemaphores } = await import("../../open-sse/services/rateLimitSemaphore.ts");
const { _resetAllDecks } = await import("../../src/shared/utils/shuffleDeck.ts");
const { clearSessions } = await import("../../open-sse/services/sessionManager.ts");
const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");

function createLog() {
  const entries: Array<{ level: string; tag: string; msg: string }> = [];
  return {
    info: (tag: string, msg: string) => entries.push({ level: "info", tag, msg }),
    warn: (tag: string, msg: string) => entries.push({ level: "warn", tag, msg }),
    error: (tag: string, msg: string) => entries.push({ level: "error", tag, msg }),
    debug: (tag: string, msg: string) => entries.push({ level: "debug", tag, msg }),
    entries,
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const STALL_TEXT = "<summary>\n## Overview\nThe session reviewed six PRs in parallel…\n</summary>";

function stallResponse() {
  return jsonResponse({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: STALL_TEXT } }],
  });
}

function toolCallingResponse() {
  return jsonResponse({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c2", function: { name: "read_file", arguments: "{}" } }],
        },
      },
    ],
  });
}

function toolTailBody() {
  return {
    model: "test-combo",
    tools: [{ type: "function", function: { name: "read_file" } }],
    messages: [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: "file contents…" },
    ],
  };
}

async function cleanupTestDataDir() {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      core.resetDbInstance();
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (lastError) throw lastError;
}

test.beforeEach(async () => {
  resetAllComboMetrics();
  resetAllCircuitBreakers();
  resetAllSemaphores();
  _resetAllDecks();
  clearSessions();
  await cleanupTestDataDir();
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await settingsDb.resetAllPricing();
  settingsDb.clearAllLKGP();
  delete process.env.OMNIROUTE_AGENTIC_STALL_FAILOVER;
});

test.after(async () => {
  resetAllComboMetrics();
  resetAllCircuitBreakers();
  resetAllSemaphores();
  _resetAllDecks();
  settingsDb.clearAllLKGP();
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  await cleanupTestDataDir();
});

test("priority combo: stalled primary fails over to the next member", async () => {
  const calls: string[] = [];
  const log = createLog();
  const result = await handleComboChat({
    body: toolTailBody() as never,
    combo: {
      name: "stall-combo",
      strategy: "priority",
      models: ["devin/swe-2-max", "claude/sonnet"],
      config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
    } as never,
    handleSingleModel: (async (_body: unknown, modelStr: string) => {
      calls.push(modelStr);
      if (modelStr === "devin/swe-2-max") return stallResponse();
      return toolCallingResponse();
    }) as never,
    isModelAvailable: async () => true,
    log: log as never,
    settings: null,
    allCombos: null,
  } as never);

  assert.equal(result.ok, true, "combo must succeed via the fallback member");
  assert.deepEqual(calls, ["devin/swe-2-max", "claude/sonnet"]);
  const served = await result.clone().json();
  assert.equal(served.choices[0].finish_reason, "tool_calls", "client gets the tool-calling response");
  const stallLogs = log.entries.filter(
    (e) => e.level === "warn" && String(e.msg).includes("agentic_stall_no_toolcall")
  );
  assert.equal(stallLogs.length, 1, "stall signature logged exactly once");
  assert.ok(String(stallLogs[0].msg).includes("devin/swe-2-max"));
});

test("positive control: stall-shaped content with NO tools pending is served, not failed over", async () => {
  const calls: string[] = [];
  const log = createLog();
  const result = await handleComboChat({
    body: {
      model: "test-combo",
      messages: [{ role: "user", content: "summarize this conversation" }],
    } as never,
    combo: {
      name: "no-tools-combo",
      strategy: "priority",
      models: ["devin/swe-2-max", "claude/sonnet"],
      config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
    } as never,
    handleSingleModel: (async (_body: unknown, modelStr: string) => {
      calls.push(modelStr);
      return stallResponse();
    }) as never,
    isModelAvailable: async () => true,
    log: log as never,
    settings: null,
    allCombos: null,
  } as never);

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["devin/swe-2-max"], "no failover without a tool-result tail");
  const served = await result.clone().json();
  assert.equal(served.choices[0].message.content, STALL_TEXT);
  assert.equal(
    log.entries.filter((e) => String(e.msg).includes("agentic_stall_no_toolcall")).length,
    0
  );
});

test("substantive answer on a tool-result tail is served by the primary", async () => {
  const calls: string[] = [];
  const log = createLog();
  const result = await handleComboChat({
    body: toolTailBody() as never,
    combo: {
      name: "real-answer-combo",
      strategy: "priority",
      models: ["devin/swe-2-max", "claude/sonnet"],
      config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
    } as never,
    handleSingleModel: (async (_body: unknown, modelStr: string) => {
      calls.push(modelStr);
      return jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Fixed the parser:\n- added the null check\n- covered it with a unit test",
            },
          },
        ],
      });
    }) as never,
    isModelAvailable: async () => true,
    log: log as never,
    settings: null,
    allCombos: null,
  } as never);

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["devin/swe-2-max"], "structured answers never trigger failover");
  assert.equal(
    log.entries.filter((e) => String(e.msg).includes("agentic_stall_no_toolcall")).length,
    0
  );
});

test("kill switch: OMNIROUTE_AGENTIC_STALL_FAILOVER=0 serves the stall as-is", async () => {
  process.env.OMNIROUTE_AGENTIC_STALL_FAILOVER = "0";
  const calls: string[] = [];
  const log = createLog();
  const result = await handleComboChat({
    body: toolTailBody() as never,
    combo: {
      name: "killswitch-combo",
      strategy: "priority",
      models: ["devin/swe-2-max", "claude/sonnet"],
      config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
    } as never,
    handleSingleModel: (async (_body: unknown, modelStr: string) => {
      calls.push(modelStr);
      if (modelStr === "devin/swe-2-max") return stallResponse();
      return toolCallingResponse();
    }) as never,
    isModelAvailable: async () => true,
    log: log as never,
    settings: null,
    allCombos: null,
  } as never);

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["devin/swe-2-max"], "guard disabled → no failover");
  const served = await result.clone().json();
  assert.equal(served.choices[0].message.content, STALL_TEXT);
});
