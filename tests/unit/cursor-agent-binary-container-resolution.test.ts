/**
 * Regression tests for cursor-agent binary resolution in a containerized
 * OmniRoute deployment.
 *
 * Observed live (2026-08-04): the "Importing Models" dialog reported
 *   cursor-agent unavailable (cursor-agent binary not found. Install it
 *   (curl https://cursor.com/install -fsS | bash) ...) — using local catalog
 * on a machine where cursor-agent WAS installed and working
 * (`~/.local/bin/cursor-agent`, `cursor-agent status` → logged in).
 *
 * Root cause is the same class as the Cursor auto-import credential probe:
 * `fetchCursorAgentModels` spawns a HOST-local binary, but the gateway runs in
 * Docker where `homedir()` is `/home/node` and no host path is mounted, so every
 * candidate necessarily misses. The install advice is actively wrong there, and
 * before this change there was no env override to wire a mounted binary at all.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCursorAgentBinary,
  isContainerWithoutCursorAgent,
  buildCursorAgentMissingMessage,
  fetchCursorAgentModels,
} from "../../src/lib/providerModels/cursorAgent";

/** Filesystem stub: only the listed paths exist. */
const only =
  (...present: string[]) =>
  (p: string) =>
    present.includes(p);

const NONE = () => false;

describe("resolveCursorAgentBinary — CURSOR_AGENT_BINARY override", () => {
  it("honours CURSOR_AGENT_BINARY (the only lever that works in Docker)", () => {
    const bin = resolveCursorAgentBinary({
      env: { CURSOR_AGENT_BINARY: "/opt/cursor-agent/versions/x/cursor-agent" },
      fileExists: NONE,
    });
    // THE REGRESSION ASSERTION: before this change no env override existed, so a
    // containerized deployment could never resolve a bind-mounted binary.
    assert.equal(bin, "/opt/cursor-agent/versions/x/cursor-agent");
  });

  it("accepts the legacy CURSOR_AGENT_BIN alias", () => {
    assert.equal(
      resolveCursorAgentBinary({ env: { CURSOR_AGENT_BIN: "/mnt/ca" }, fileExists: NONE }),
      "/mnt/ca"
    );
  });

  it("prefers CURSOR_AGENT_BINARY over the legacy alias", () => {
    assert.equal(
      resolveCursorAgentBinary({
        env: { CURSOR_AGENT_BINARY: "/a", CURSOR_AGENT_BIN: "/b" },
        fileExists: NONE,
      }),
      "/a"
    );
  });

  it("returns a configured-but-missing override verbatim (actionable over 'not found')", () => {
    // Reporting the wrong configured path beats a generic miss — the operator
    // needs to know the override is what's broken.
    assert.equal(
      resolveCursorAgentBinary({ env: { CURSOR_AGENT_BINARY: "/nope" }, fileExists: NONE }),
      "/nope"
    );
  });

  it("ignores a blank/whitespace override and falls through to path probing", () => {
    assert.equal(
      resolveCursorAgentBinary({
        env: { CURSOR_AGENT_BINARY: "   " },
        fileExists: only("/usr/bin/cursor-agent"),
      }),
      "/usr/bin/cursor-agent"
    );
  });

  it("still probes the standard install locations when no override is set", () => {
    assert.equal(
      resolveCursorAgentBinary({ env: {}, fileExists: only("/usr/local/bin/cursor-agent") }),
      "/usr/local/bin/cursor-agent"
    );
  });

  it("still falls back to a PATH lookup", () => {
    assert.equal(
      resolveCursorAgentBinary({
        env: { PATH: "/x:/opt/bin" },
        fileExists: only("/opt/bin/cursor-agent"),
      }),
      "/opt/bin/cursor-agent"
    );
  });

  it("returns null when nothing resolves", () => {
    assert.equal(resolveCursorAgentBinary({ env: { PATH: "/x" }, fileExists: NONE }), null);
  });
});

describe("isContainerWithoutCursorAgent", () => {
  it("detects the Docker deployment with no override configured", () => {
    assert.equal(isContainerWithoutCursorAgent({}, only("/.dockerenv")), true);
  });

  it("detects podman via /run/.containerenv", () => {
    assert.equal(isContainerWithoutCursorAgent({}, only("/run/.containerenv")), true);
  });

  it("returns false on a bare host", () => {
    assert.equal(isContainerWithoutCursorAgent({}, NONE), false);
  });

  it("returns false in a PROPERLY WIRED container (override set)", () => {
    // Guard against over-reach: a container with a bind-mounted binary must not
    // be told it's unreachable.
    assert.equal(
      isContainerWithoutCursorAgent({ CURSOR_AGENT_BINARY: "/opt/ca" }, only("/.dockerenv")),
      false
    );
  });
});

describe("buildCursorAgentMissingMessage", () => {
  it("does NOT tell a container operator to run the host install script", () => {
    const msg = buildCursorAgentMissingMessage({}, only("/.dockerenv"));
    // THE REGRESSION ASSERTION: the old message unconditionally advised
    // `curl https://cursor.com/install`, which cannot fix a container.
    assert.ok(!/cursor\.com\/install/.test(msg), "must not advise the host install script");
    assert.ok(msg.includes("container"), "must name the real cause");
    assert.ok(msg.includes("CURSOR_AGENT_BINARY"), "must name the actual remedy");
  });

  it("warns that bind-mounting a macOS bundle cannot work (verified live)", () => {
    // A macOS cursor-agent bundle ships a Mach-O `node` plus darwin-only .node
    // modules; execing it in the Linux container yields
    // "Cannot run macOS (Mach-O) executable in Docker: Exec format error".
    // The message must steer to the Linux build, not a naive mount.
    const msg = buildCursorAgentMissingMessage({}, only("/.dockerenv"));
    assert.ok(/Mach-O/.test(msg), "must explain why a macOS mount fails");
    assert.ok(/linux/i.test(msg), "must point at the Linux build");
    assert.ok(/CURSOR_AUTH_TOKEN/.test(msg), "must mention the auth requirement");
  });

  it("reassures that the local-catalog fallback is expected, not a failure", () => {
    const msg = buildCursorAgentMissingMessage({}, only("/.dockerenv"));
    assert.ok(/expected and harmless/.test(msg));
  });

  it("keeps the install advice on a real host (where it DOES help)", () => {
    const msg = buildCursorAgentMissingMessage({}, NONE);
    assert.ok(msg.includes("cursor.com/install"));
    assert.ok(!msg.includes("container"));
  });
});

describe("fetchCursorAgentModels — auth token forwarding", () => {
  // `--list-models` is an AUTHENTICATED call: unauthenticated the CLI prints
  //   "Error: Authentication required. Run 'agent login', pass
  //    --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN."
  // Verified live inside the container: same binary + CURSOR_AUTH_TOKEN => the
  // real "Available models" catalog. So a reachable binary is necessary but NOT
  // sufficient; the token must be forwarded into the child env.
  //
  // These drive the real spawn path against a tiny shell script that behaves like
  // the CLI: it emits the catalog only when CURSOR_AUTH_TOKEN is set.
  const FIXTURE = join(tmpdir(), `fake-cursor-agent-${process.pid}.sh`);

  before(() => {
    writeFileSync(
      FIXTURE,
      [
        "#!/bin/sh",
        'if [ -z "$CURSOR_AUTH_TOKEN" ]; then',
        "  echo \"Error: Authentication required. Run 'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN.\" >&2",
        "  exit 1",
        "fi",
        'echo "Available models"',
        'echo ""',
        'echo "auto - Auto (default)"',
        `echo "token-echo-$CURSOR_AUTH_TOKEN - Echoed Token"`,
        "",
      ].join("\n"),
      { mode: 0o755 }
    );
  });

  after(() => {
    try {
      unlinkSync(FIXTURE);
    } catch {
      /* already gone */
    }
  });

  it("forwards authToken as CURSOR_AUTH_TOKEN so discovery succeeds", async () => {
    const models = await fetchCursorAgentModels({
      binary: FIXTURE,
      timeoutMs: 15000,
      authToken: "tok-abc123",
    });

    const ids = models.map((m) => m.id);
    assert.ok(ids.includes("auto"), `expected a parsed catalog, got ${JSON.stringify(ids)}`);
    // Proves the value actually reached the child's environment, not just that
    // some catalog came back.
    assert.ok(
      ids.includes("token-echo-tok-abc123"),
      `CURSOR_AUTH_TOKEN not visible to the child; got ${JSON.stringify(ids)}`
    );
  });

  it("without a token the same binary fails to discover (positive control)", async () => {
    // Guards the assertion above from being vacuous: if the fixture returned a
    // catalog regardless of env, the forwarding test would pass even unwired.
    // NOTE: a stray real CURSOR_AUTH_TOKEN in the ambient env would defeat this,
    // so clear it for the duration.
    const saved = process.env.CURSOR_AUTH_TOKEN;
    delete process.env.CURSOR_AUTH_TOKEN;
    try {
      await assert.rejects(
        () => fetchCursorAgentModels({ binary: FIXTURE, timeoutMs: 15000 }),
        /Authentication required|cursor-agent/i
      );
    } finally {
      if (saved !== undefined) process.env.CURSOR_AUTH_TOKEN = saved;
    }
  });
});
