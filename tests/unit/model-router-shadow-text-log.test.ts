/**
 * tests/unit/model-router-shadow-text-log.test.ts (vitest)
 *
 * MODEL_ROUTER_SHADOW_TEXT_LOG — one JSONL line per shadow decision carrying the
 * exact cleaned rule text (truncated + sha1 of the full text), secret redaction
 * before the write, and the shadow-only / fire-and-forget guarantees.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DOWNGRADE_FROM,
  DEFAULT_DOWNGRADE_TO,
  DEFAULT_SHADOW_TEXT_MAX,
  __resetModelRouterSessionsForTests,
  maybeApplyModelRouterTier,
  resolveModelRouterConfig,
  shortImperativeRule,
  type ModelRouterConfig,
} from "@/sse/services/modelRouterTier";
import {
  REDACTED,
  __resetShadowTextWarnForTests,
  buildShadowTextRecord,
  redactSecrets,
  truncateWithMarker,
} from "@/sse/services/modelRouterShadowLog";

const rules = () => import("@/sse/services/modelRouterShadowLog");

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mr-shadow-"));
  logPath = path.join(dir, "decisions.jsonl");
  __resetModelRouterSessionsForTests();
  __resetShadowTextWarnForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function cfg(overrides: Partial<ModelRouterConfig> = {}): ModelRouterConfig {
  const base = resolveModelRouterConfig({
    MODEL_ROUTER_POLICY: "downgrade",
    MODEL_ROUTER_DOWNGRADE_FROM: DEFAULT_DOWNGRADE_FROM,
    MODEL_ROUTER_DOWNGRADE_TO: DEFAULT_DOWNGRADE_TO,
    MODEL_ROUTER_DOWNGRADE_MIN_CONF: "0.9",
    MODEL_ROUTER_DOWNGRADE_TIMEOUT_MS: "800",
  });
  return { ...base, ...overrides };
}

function body(text: string, prev?: string) {
  const messages: Array<{ role: string; content: string }> = [];
  if (prev) messages.push({ role: "user", content: prev });
  messages.push({ role: "user", content: text });
  return { model: DEFAULT_DOWNGRADE_FROM, messages } as never;
}

/** Shadow decision for `text`, decider=rule (no classifier call). */
async function shadow(
  text: string,
  prev?: string,
  config = cfg({ shadow: true, decider: "rule" })
) {
  return maybeApplyModelRouterTier({
    body: body(text, prev),
    modelStr: DEFAULT_DOWNGRADE_FROM,
    config,
  });
}

/** Wait for the detached (fire-and-forget) append to land. */
async function readLines(p: string, expectLines: number): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (existsSync(p)) {
      const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
      if (lines.length >= expectLines) return lines.map((l) => JSON.parse(l));
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  const seen = existsSync(p) ? readFileSync(p, "utf8") : "<missing file>";
  throw new Error(`shadow text log did not reach ${expectLines} line(s): ${JSON.stringify(seen)}`);
}

describe("shadow text log record shape", () => {
  it("writes one line per shadow decision with the rule input text and full-text sha1", async () => {
    const text = "fix the failing test";
    const res = await shadow(
      text,
      undefined,
      cfg({ shadow: true, decider: "rule", shadowTextLog: logPath })
    );
    expect(res.applied).toBe(false);
    expect(res.model).toBe(DEFAULT_DOWNGRADE_FROM);

    const [line] = await readLines(logPath, 1);
    expect(line.requested).toBe(DEFAULT_DOWNGRADE_FROM);
    expect(line.tier).toBe("coding");
    expect(line.rule).toBe("down");
    expect(line.rule_len).toBe(shortImperativeRule(body(text)).len);
    expect(line.text).toBe(shortImperativeRule(body(text)).text);
    expect(line.text).toBe(text);
    expect(line.text_sha1).toBe(createHash("sha1").update(text).digest("hex"));
    expect(line.prev_user).toBeNull();
    expect(line.fb).toBe(true);
    expect(typeof line.ts).toBe("string");
    expect(new Date(line.ts as string).toISOString()).toBe(line.ts);
    expect(line).toHaveProperty("sess");
    expect(line).toHaveProperty("would");
    expect(line).toHaveProperty("conf");
  });

  it("carries the stripped rule text, previous user message, and writes one line per decision", async () => {
    const raw = "please fix it\n--- Attached Context ---\n<file>secret</file>";
    await shadow(
      raw,
      "an earlier question?",
      cfg({ shadow: true, decider: "rule", shadowTextLog: logPath })
    );
    await shadow(
      "second call",
      undefined,
      cfg({ shadow: true, decider: "rule", shadowTextLog: logPath })
    );

    const lines = await readLines(logPath, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("please fix it");
    expect(lines[0].text_sha1).toBe(
      createHash("sha1")
        .update(shortImperativeRule(body(raw)).text)
        .digest("hex")
    );
    expect(lines[0].prev_user).toBe("an earlier question?");
    expect(lines[1].text).toBe("second call");
    expect(lines[1].prev_user).toBeNull();
  });

  it("truncates text to MODEL_ROUTER_SHADOW_TEXT_MAX with a …[truncated N] suffix while sha1 covers the full text", async () => {
    const full = "a".repeat(DEFAULT_SHADOW_TEXT_MAX + 37);
    await shadow(full, undefined, cfg({ shadow: true, decider: "rule", shadowTextLog: logPath }));

    const [line] = await readLines(logPath, 1);
    const text = line.text as string;
    expect(text).toBe("a".repeat(DEFAULT_SHADOW_TEXT_MAX) + "…[truncated 37]");
    expect(text.endsWith("…[truncated 37]")).toBe(true);
    expect(line.text_sha1).toBe(createHash("sha1").update(full).digest("hex"));
  });

  it("truncates prev_user to 500 chars and keeps it null when there is no previous turn", () => {
    const rec = buildShadowTextRecord(
      {
        requested: "best-reasoning-paid",
        would: "best-coding-paid",
        tier: "coding",
        confidence: 0,
        fb: true,
        sess: "",
        rule: "down",
        ruleLen: 4,
        ruleText: "fix it",
      },
      body("fix it", "b".repeat(600)) as never,
      DEFAULT_SHADOW_TEXT_MAX
    );
    expect((rec.prev_user as string).startsWith("b".repeat(500))).toBe(true);
    expect((rec.prev_user as string).endsWith("…[truncated 100]")).toBe(true);
  });
});

describe("secret redaction before writing", () => {
  const cases: Array<[string, string]> = [
    ["sk-", "key=sk-abcdefghijklmnopqrstuvwx"],
    ["sk-ant-", "key=sk-ant-api03-abcdefghijklmnopqrstuv"],
    ["ghp_", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["gho_", "token gho_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["ghs_", "token ghs_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["ghr_", "token ghr_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["ghu_", "token ghu_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["github_pat_", "token github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz"],
    ["AKIA", "aws AKIAIOSFODNN7EXAMPLE"],
    ["xoxb-", "slack xoxb-1234567890-abcdefghijklm"],
    ["xoxp-", "slack xoxp-1234567890-abcdefghijklm"],
    ["xoxa-", "slack xoxa-1234567890-abcdefghijklm"],
    ["xoxr-", "slack xoxr-1234567890-abcdefghijklm"],
    ["Bearer", "Authorization: Bearer abcdefghijklmnop.qrstuvwx"],
    ["JWT", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM"],
    [
      "PEM private key",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
    ],
    ["password=", "password=hunter2"],
    ["passwd=", "passwd: hunter2"],
    ["secret=", "secret = hunter2"],
    ["token=", "token=abc123"],
    ["api_key=", "api_key=abc123"],
    ["api-key=", "api-key: abc123"],
    ["apiKey=", "apiKey=abc123"],
  ];

  it.each(cases)("masks %s", (_label, input) => {
    const out = redactSecrets(input);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).not.toContain("MIIEowIBAAKCAQEA");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwx");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).not.toContain("github_pat_11ABCDEFG");
    expect(out).not.toContain("xoxb-1234567890");
  });

  it("keeps the key name but masks the value", () => {
    expect(redactSecrets("api_key=abc123 rest")).toBe(`api_key=${REDACTED} rest`);
  });

  it("leaves secrets of any kind out of the written line, and keeps sha1 of the raw text", async () => {
    const raw = "please fix password=hunter2 and token=ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await shadow(raw, undefined, cfg({ shadow: true, decider: "rule", shadowTextLog: logPath }));
    const [line] = await readLines(logPath, 1);
    expect(line.text as string).not.toContain("hunter2");
    expect(line.text as string).not.toContain("ghp_");
    expect(line.text as string).toContain(REDACTED);
    expect(line.text_sha1).toBe(
      createHash("sha1")
        .update(shortImperativeRule(body(raw)).text)
        .digest("hex")
    );
  });

  it("does not touch ordinary text", () => {
    const plain = "restart the service and check the logs";
    expect(redactSecrets(plain)).toBe(plain);
    expect(truncateWithMarker(plain, 2000)).toBe(plain);
  });

  it("redacts before truncating so a cut secret cannot leak a prefix", () => {
    const raw = `sk-${"a".repeat(120)}`;
    const out = redactSecrets(raw);
    expect(out).toBe(REDACTED);
    expect(truncateWithMarker(out, 10)).toBe(REDACTED);
    expect(truncateWithMarker(out, 10)).not.toContain("sk-");
  });
});

describe("opt-in guarantees", () => {
  it("writes nothing when MODEL_ROUTER_SHADOW_TEXT_LOG is unset (even in shadow mode)", async () => {
    const res = await shadow(
      "fix the failing test",
      undefined,
      cfg({ shadow: true, decider: "rule", shadowTextLog: null })
    );
    expect(res.applied).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(logPath)).toBe(false);
  });

  it("writes nothing in live (non-shadow) mode even when the env is set", async () => {
    // Live rule decider actually downgrades — and must not write prompt text.
    const res = await maybeApplyModelRouterTier({
      body: body("fix it"),
      modelStr: DEFAULT_DOWNGRADE_FROM,
      config: cfg({ policy: "downgrade", decider: "rule", shadow: false, shadowTextLog: logPath }),
    });
    expect(res.applied).toBe(true);

    // Defense in depth: even a direct call with the live config must not write.
    const { appendShadowTextLog } = await rules();
    await appendShadowTextLog(
      { shadow: false, shadowTextLog: logPath, shadowTextMax: DEFAULT_SHADOW_TEXT_MAX },
      {
        requested: DEFAULT_DOWNGRADE_FROM,
        would: DEFAULT_DOWNGRADE_TO,
        tier: "coding",
        confidence: 0,
        fb: true,
        sess: "",
        rule: "down",
        ruleLen: 6,
        ruleText: "fix it",
      },
      body("fix it") as never
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(logPath)).toBe(false);
  });

  it("resolves config with the path unset by default and the 2000-char cap", () => {
    const c = resolveModelRouterConfig({});
    expect(c.shadowTextLog).toBeNull();
    expect(c.shadowTextMax).toBe(DEFAULT_SHADOW_TEXT_MAX);
  });

  it("creates the parent directory and writes the file with mode 0600", async () => {
    const nested = path.join(dir, "nested", "deeper", "shadow.jsonl");
    await shadow(
      "fix it",
      undefined,
      cfg({ shadow: true, decider: "rule", shadowTextLog: nested })
    );
    await readLines(nested, 1);
    const mode = (await import("node:fs")).statSync(nested).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("write failures never break the request", () => {
  it("does not throw and does not reject when the path is unwritable", async () => {
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    chmodSync(blocker, 0o400);
    const unwritable = path.join(blocker, "decisions.jsonl");

    const { appendShadowTextLog } = await rules();
    await expect(
      appendShadowTextLog(
        { shadow: true, shadowTextLog: unwritable, shadowTextMax: DEFAULT_SHADOW_TEXT_MAX },
        {
          requested: DEFAULT_DOWNGRADE_FROM,
          would: DEFAULT_DOWNGRADE_TO,
          tier: "coding",
          confidence: 0,
          fb: true,
          sess: "",
          rule: "down",
          ruleLen: 2,
          ruleText: "ok",
        },
        body("ok") as never
      )
    ).resolves.toBeUndefined();

    // And the request path itself still succeeds.
    const res = await shadow(
      "fix it",
      undefined,
      cfg({ shadow: true, decider: "rule", shadowTextLog: unwritable })
    );
    expect(res.applied).toBe(false);
    expect(res.model).toBe(DEFAULT_DOWNGRADE_FROM);
    // Let the detached write settle so its warn cannot leak into the next test.
    await new Promise((r) => setTimeout(r, 200));
  });

  it("logs the failure at most once per minute (rate-limited warn)", async () => {
    const logger = await import("@/sse/utils/logger");
    const spy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const blocker = path.join(dir, "blocker2");
    writeFileSync(blocker, "not a directory");
    const unwritable = path.join(blocker, "decisions.jsonl");
    const { appendShadowTextLog } = await rules();
    const decision = {
      requested: DEFAULT_DOWNGRADE_FROM,
      would: DEFAULT_DOWNGRADE_TO,
      tier: "coding" as const,
      confidence: 0,
      fb: true,
      sess: "",
      rule: "down" as const,
      ruleLen: 2,
      ruleText: "ok",
    };
    const cfgPick = {
      shadow: true,
      shadowTextLog: unwritable,
      shadowTextMax: DEFAULT_SHADOW_TEXT_MAX,
    };
    await appendShadowTextLog(cfgPick, decision, body("ok") as never);
    await appendShadowTextLog(cfgPick, decision, body("ok") as never);
    await appendShadowTextLog(cfgPick, decision, body("ok") as never);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
