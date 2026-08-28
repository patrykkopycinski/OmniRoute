import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// cursor-agent waits on stdin when given a piped fd, so we always launch it
// with stdin closed ("ignore") so it exits as soon as it prints the model list.
export function runCursorAgent(
  binary: string,
  args: string[],
  timeoutMs: number,
  options?: { sigkillFollowupMs?: number; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: options?.env,
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let sigkillTimer: NodeJS.Timeout | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const killTimer = setTimeout(() => {
      child.kill("SIGTERM");
      // Unattended-execution hardening: nothing interactively supervises a
      // background spawn, so a process that ignores SIGTERM needs a hard
      // follow-up kill rather than lingering indefinitely.
      if (options?.sigkillFollowupMs !== undefined) {
        sigkillTimer = setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, options.sigkillFollowupMs);
      }
    }, timeoutMs);
    child.on("error", (err) => {
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(sigkillTimer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(sigkillTimer);
      resolve({ stdout, stderr, code, signal });
    });
  });
}

// Resolve cursor-agent across common install locations, since the standalone
// Next.js server may run with a PATH that doesn't include the user's local bin.
//
// `CURSOR_AGENT_BINARY` (or legacy `CURSOR_AGENT_BIN`) takes precedence — this is
// the only lever that works for a **containerized** OmniRoute, where the CLI lives
// on the host and none of the hardcoded paths can ever resolve. Point it at a
// bind-mounted binary, e.g.
//   docker run -v ~/.local/share/cursor-agent:/opt/cursor-agent:ro \
//              -e CURSOR_AGENT_BINARY=/opt/cursor-agent/versions/<v>/cursor-agent
type CursorAgentResolveOptions = {
  allowPathFallback?: boolean;
  env?: NodeJS.ProcessEnv;
  fileExists?: (p: string) => boolean;
};

export function resolveCursorAgentBinary(options: CursorAgentResolveOptions = {}): string | null {
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const override = (env.CURSOR_AGENT_BINARY || env.CURSOR_AGENT_BIN || "").trim();
  if (override) {
    // Return the override even when it doesn't exist so the caller can report the
    // configured-but-wrong path, which is far more actionable than "not found".
    return override;
  }

  const home = homedir();
  const candidates = [
    join(home, ".local", "bin", "cursor-agent"),
    "/root/.local/bin/cursor-agent",
    "/usr/local/bin/cursor-agent",
    "/usr/bin/cursor-agent",
    "/opt/homebrew/bin/cursor-agent",
  ];
  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate;
  }
  if (options?.allowPathFallback === false) return null;
  // Fallback: PATH-based lookup (lets execFile do the resolution).
  const pathDirs = (env.PATH || "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, "cursor-agent");
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

/**
 * Detect that we're inside a container that cannot reach a host-installed
 * cursor-agent, so the "install it" advice would be wrong.
 *
 * Same bug class as the Cursor auto-import credential probe: this code shells
 * out to a **host-local** binary, but in the Docker deployment `homedir()` is
 * `/home/node` and no host filesystem is mounted — so every candidate path
 * necessarily misses and telling the operator to run the install script sends
 * them to fix a machine that is already correct.
 *
 * Requires BOTH a container marker and no override configured, so a properly
 * wired container (bind-mount + CURSOR_AGENT_BINARY) is never mislabeled.
 */
export function isContainerWithoutCursorAgent(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = existsSync
): boolean {
  if ((env.CURSOR_AGENT_BINARY || env.CURSOR_AGENT_BIN || "").trim()) return false;
  return fileExists("/.dockerenv") || fileExists("/run/.containerenv");
}

/**
 * Build the "no binary" error message appropriate to where we're running.
 * Exported for unit testing — the container branch must not recommend an
 * install that cannot help.
 */
export function buildCursorAgentMissingMessage(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = existsSync
): string {
  if (isContainerWithoutCursorAgent(env, fileExists)) {
    return (
      "cursor-agent is not reachable from inside the OmniRoute container. " +
      "The CLI is installed on the host, and no host path is mounted. " +
      "Note that bind-mounting a macOS host's cursor-agent does NOT work — that " +
      "bundle ships a Mach-O node binary and darwin-only native modules, which " +
      "the Linux container cannot exec. Install the Linux build for the " +
      "container's architecture and point CURSOR_AGENT_BINARY at it, e.g. " +
      "curl -fsSL https://downloads.cursor.com/lab/<version>/linux/<arm64|x64>/" +
      "agent-cli-package.tar.gz | tar xz, then run with " +
      "-v <extracted>/dist-package:/opt/cursor-agent:ro " +
      "-e CURSOR_AGENT_BINARY=/opt/cursor-agent/cursor-agent and a " +
      "CURSOR_AUTH_TOKEN (or OmniRoute's stored Cursor token). " +
      "Until then the local model catalog is used, which is expected and harmless."
    );
  }
  return "cursor-agent binary not found. Install it (curl https://cursor.com/install -fsS | bash) so ~/.local/bin/cursor-agent exists, or pass a binary path explicitly.";
}

const SEGMENT_OVERRIDES: Record<string, string> = {
  gpt: "GPT",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
  kimi: "Kimi",
  composer: "Composer",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  codex: "Codex",
  mini: "Mini",
  nano: "Nano",
  max: "Max",
  high: "High",
  low: "Low",
  medium: "Medium",
  xhigh: "XHigh",
  none: "None",
  fast: "Fast",
  thinking: "Thinking",
  extra: "Extra",
  spark: "Spark",
  preview: "Preview",
  flash: "Flash",
  pro: "Pro",
};

export function humanizeCursorModelId(id: string): string {
  if (id === "auto") return "Auto (Server Picks)";

  // Collapse digit-dash-digit suffixes (e.g. claude-opus-4-7 → claude-opus-4.7)
  // so version numbers read naturally.
  const collapsed = id.replace(/(\d+)-(\d+)(?=-|$)/g, "$1.$2");
  return collapsed
    .split("-")
    .map((part) => {
      if (SEGMENT_OVERRIDES[part]) return SEGMENT_OVERRIDES[part];
      if (/^\d/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function parseCursorAgentModels(text: string): string[] {
  // Older Cursor Agent releases only exposed the catalog as part of the
  // invalid-model error produced by `--model --help`.
  const legacyMatch = text.match(/Available models:\s*([^\n]+)/);
  if (legacyMatch) {
    return deduplicateCursorModelIds(legacyMatch[1].split(","));
  }

  // Current releases expose an official `models` command whose output is:
  //
  // Available models
  //
  // auto - Auto (default)
  // gpt-5.3-codex - Codex 5.3
  const headerMatch = /(?:^|\n)Available models\s*(?:\n|$)/.exec(text);
  if (!headerMatch) return [];
  const lines = text.slice(headerMatch.index + headerMatch[0].length).split("\n");
  const ids: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Tip:")) break;
    const separator = trimmed.indexOf(" - ");
    if (separator > 0) ids.push(trimmed.slice(0, separator));
  }
  return deduplicateCursorModelIds(ids);
}

function deduplicateCursorModelIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export type CursorAgentModelEntry = {
  id: string;
  name: string;
  owned_by: "cursor";
};

/**
 * Default timeout for `cursor-agent --list-models`.
 *
 * The old 5s budget was tuned against a warm host CLI. Measured inside the
 * container the same command takes ~32s on a cold start (no Node compile cache,
 * cold module graph, first-call auth handshake), so discovery timed out and fell
 * back to the local catalog while reporting the misleading
 * "cursor-agent did not return a model catalog" — even though the CLI, run by
 * hand in that same container, succeeds with exit 0.
 *
 * 60s leaves headroom over the observed cold start without hanging the UI
 * indefinitely; the result is cached, so this cost is paid once.
 */
export const CURSOR_AGENT_LIST_MODELS_TIMEOUT_MS = 60_000;

export async function fetchCursorAgentModels(
  options: { binary?: string; timeoutMs?: number; authToken?: string } = {}
): Promise<CursorAgentModelEntry[]> {
  const binary = options.binary || resolveCursorAgentBinary();
  const timeoutMs = options.timeoutMs ?? CURSOR_AGENT_LIST_MODELS_TIMEOUT_MS;

  if (!binary) {
    throw new Error(buildCursorAgentMissingMessage());
  }

  // `--list-models` is an authenticated call: without a credential the CLI exits
  // with "Authentication required. Run 'agent login', pass --api-key/--auth-token,
  // or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN." A container has no `agent login`
  // state, so discovery fails there even once the binary IS reachable. Forward the
  // caller-supplied token (OmniRoute already stores a valid Cursor token on the
  // provider connection) via the env the CLI itself documents.
  const env = options.authToken
    ? { ...process.env, CURSOR_AUTH_TOKEN: options.authToken }
    : process.env;

  const startedAt = Date.now();
  let result: { stdout: string; stderr: string };
  try {
    // Modern Cursor Agent releases provide a dedicated catalog flag. Prefer the
    // flag over the equivalent `models` subcommand because older releases can
    // interpret an unknown positional subcommand as an agent prompt.
    result = await runCursorAgent(binary, ["--list-models"], timeoutMs, { env });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") {
      const configured = (
        process.env.CURSOR_AGENT_BINARY ||
        process.env.CURSOR_AGENT_BIN ||
        ""
      ).trim();
      if (configured) {
        throw new Error(
          `cursor-agent not found at ${binary} (from ${
            process.env.CURSOR_AGENT_BINARY ? "CURSOR_AGENT_BINARY" : "CURSOR_AGENT_BIN"
          }). Check the path is correct and, in Docker, that it is bind-mounted into the container.`
        );
      }
      throw new Error(`cursor-agent binary not executable at ${binary}`);
    }
    throw err;
  }
  let combined = `${result.stdout}\n${result.stderr}`;
  let ids = parseCursorAgentModels(combined);

  // Backward compatibility for releases from before the dedicated catalog interface.
  if (ids.length === 0 && !/Authentication required|Not logged in/i.test(combined)) {
    const remainingTimeoutMs = timeoutMs - (Date.now() - startedAt);
    if (remainingTimeoutMs > 0) {
      result = await runCursorAgent(binary, ["--model", "--help"], remainingTimeoutMs, { env });
      combined = `${result.stdout}\n${result.stderr}`;
      ids = parseCursorAgentModels(combined);
    }
  }

  if (ids.length === 0) {
    if (/Authentication required|Not logged in/i.test(combined)) {
      throw new Error("cursor-agent is not authenticated; run 'agent login' on the OmniRoute host");
    }
    throw new Error("cursor-agent did not return a model catalog from 'agent --list-models'");
  }

  return ids.map((id) => ({
    id,
    name: humanizeCursorModelId(id),
    owned_by: "cursor" as const,
  }));
}
