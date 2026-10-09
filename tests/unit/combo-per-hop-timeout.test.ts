import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTargetTimeoutRunner } from "../../open-sse/services/combo/targetTimeoutRunner.ts";
import { comboModelStepInputSchema } from "../../src/shared/validation/schemas/combo.ts";
import type { ComboLogger, SingleModelTarget } from "../../open-sse/services/combo/types.ts";

const noopLog: ComboLogger = { warn() {}, info() {}, error() {}, debug() {} };

function hangUntilAbort(): (
  b: Record<string, unknown>,
  m: string,
  t?: SingleModelTarget
) => Promise<Response> {
  return (_b, _m, target) =>
    new Promise<Response>((resolve) => {
      const sig = target?.modelAbortSignal ?? undefined;
      sig?.addEventListener("abort", () => resolve(new Response(null, { status: 599 })));
    });
}

// ─── Schema ───

test("schema: model step accepts optional timeoutMs", () => {
  const parsed = comboModelStepInputSchema.parse({
    kind: "model",
    model: "cu/claude-haiku-5-5",
    timeoutMs: 8000,
  });
  assert.equal(parsed.timeoutMs, 8000);
});

test("schema: timeoutMs unset by default (backward-compatible)", () => {
  const parsed = comboModelStepInputSchema.parse({ kind: "model", model: "m" });
  assert.equal(parsed.timeoutMs, undefined);
});

test("schema: timeoutMs rejects negative, fractional, and >MAX values", () => {
  for (const bad of [-1, 1.5, 1e12]) {
    assert.equal(
      comboModelStepInputSchema.safeParse({ kind: "model", model: "m", timeoutMs: bad }).success,
      false,
      `timeoutMs=${bad} must be rejected`
    );
  }
});

test("schema: timeoutMs coerces numeric strings", () => {
  const parsed = comboModelStepInputSchema.parse({ kind: "model", model: "m", timeoutMs: "8000" });
  assert.equal(parsed.timeoutMs, 8000);
});

// ─── Runner: per-hop timeout beats the combo-wide timeout ───

test("per-hop timeoutMs set: aborts the hop and returns 504 combo_target_timeout", async () => {
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: hangUntilAbort(),
    // combo-wide timeout is huge — only the per-hop value can cut the hop
    comboTargetTimeoutMs: 60_000,
    resolveTargetTimeoutMs: async () => 60_000,
    log: noopLog,
  });
  const res = await runner({}, "slow-hop", { kind: "model", timeoutMs: 25 } as SingleModelTarget);
  assert.equal(res.status, 504);
  const body = await res.json();
  assert.match(JSON.stringify(body), /combo_target_timeout/);
});

test("per-hop timeoutMs wins over a SMALLER combo-wide/connection timeout", async () => {
  // hop gets 300ms; combo-wide + connection resolve to 25ms. The hop's explicit
  // larger budget must win: the slow-but-under-300ms dispatch completes.
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async () => {
      await new Promise((r) => setTimeout(r, 80));
      return new Response("ok");
    },
    comboTargetTimeoutMs: 25,
    resolveTargetTimeoutMs: async () => 25,
    log: noopLog,
  });
  const res = await runner({}, "roomy-hop", { kind: "model", timeoutMs: 300 } as SingleModelTarget);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
});

test("per-hop timeoutMs: 0 disables the hop timeout entirely", async () => {
  let called = false;
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async () => {
      called = true;
      return new Response("ok");
    },
    comboTargetTimeoutMs: 10,
    resolveTargetTimeoutMs: async () => 10,
    log: noopLog,
  });
  const res = await runner({}, "untimed-hop", { kind: "model", timeoutMs: 0 } as SingleModelTarget);
  assert.equal(called, true);
  assert.equal(await res.text(), "ok");
});

test("timeoutMs unset: current behaviour (combo-wide/connection timeout applies)", async () => {
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: hangUntilAbort(),
    comboTargetTimeoutMs: 25,
    log: noopLog,
  });
  const res = await runner({}, "legacy-hop", { kind: "model" } as SingleModelTarget);
  assert.equal(res.status, 504);
});

// ─── Streaming semantics ───

test("streaming: a hop that already produced its Response is never cut mid-response", async () => {
  // handleSingleModel resolves the Response object immediately, then the body
  // streams slowly. The 25ms hop timer fires mid-body, but the Response already
  // won the race, so the client still receives the full body.
  const fullBody = "x".repeat(64);
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            for (const ch of fullBody) {
              controller.enqueue(new TextEncoder().encode(ch));
              await new Promise((r) => setTimeout(r, 5));
            }
            controller.close();
          },
        })
      ),
    comboTargetTimeoutMs: 60_000,
    log: noopLog,
  });
  const res = await runner({}, "streaming-hop", { kind: "model", timeoutMs: 25 } as SingleModelTarget);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), fullBody);
});

// ─── Plumbing: stored combo step → resolved target → runner ───
// Guards the normalizer (src/lib/combos/steps.ts) and runtime resolver
// (open-sse/services/combo/comboStructure.ts): if either drops `timeoutMs`,
// the runner never sees it and the hop silently runs untimed.

test("plumbing: stored step timeoutMs survives resolveComboTargets and cuts the hop", async () => {
  const { resolveComboTargets } = await import("../../open-sse/services/combo/comboStructure.ts");
  const combo = {
    name: "best-cheap-test",
    models: [
      { kind: "model", model: "cu/claude-haiku-5-5", timeoutMs: 25 },
      { kind: "model", model: "gh/gpt-6-luna" },
    ],
  };
  const targets = resolveComboTargets(combo as never, null as never, undefined, new Map() as never);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].timeoutMs, 25);
  assert.equal("timeoutMs" in targets[1], false, "unset hop must not gain a timeoutMs");

  const runner = buildTargetTimeoutRunner({
    handleSingleModel: hangUntilAbort(),
    comboTargetTimeoutMs: 60_000,
    log: noopLog,
  });
  const res = await runner({}, targets[0].modelStr, targets[0] as SingleModelTarget);
  assert.equal(res.status, 504);
});
