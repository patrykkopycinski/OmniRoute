#!/usr/bin/env node
// Install the linux native optional dependencies that a host-built (macOS)
// standalone bundle is missing.
//
// Dockerfile.local copies `.build/next/standalone` verbatim from the build
// host. When that host is macOS, npm only installed the darwin variants of
// platform-gated optionalDependencies (`@img/sharp-darwin-arm64`,
// `@wreq-js/binding-darwin-arm64`, `@ngrok/ngrok-darwin-arm64`, ...), so in
// the linux container `require("sharp")` throws
//   Could not load the "sharp" module using the linux-arm64 runtime
// and every cursor/* request with an image_url part 500s.
//
// This walks top-level node_modules packages, collects each optional
// dependency whose name targets the CURRENT platform/arch/libc and is not
// installed, and installs exactly those pinned versions into node_modules.
// It runs at image build time inside the target platform, so it is correct
// for both linux/arm64 and linux/amd64 builds.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.argv[2] ?? "node_modules";
const platform = process.platform; // "linux"
const arch = process.arch; // "arm64" | "x64"
const isMusl = !process.report?.getReport()?.header?.glibcVersionRuntime;
const otherLibc = isMusl ? "gnu" : "musl";

// Matches "linux-arm64", "linux-arm64-gnu", "-linux-arm64.", but never
// "linuxmusl-arm64" (musl) on glibc or "linux-arm64-musl" on glibc.
const platformRe = new RegExp(`(^|[-/])${platform}${isMusl ? "(musl)?" : ""}-${arch}($|[-.])`);
const wrongLibcRe = new RegExp(`(${platform}musl|-${otherLibc}$)`);
const targets = (name) => platformRe.test(name) && !(isMusl ? /-gnu$/ : wrongLibcRe).test(name);

function packageDirs() {
  const dirs = [];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      for (const sub of readdirSync(join(root, entry))) dirs.push(join(root, entry, sub));
    } else {
      dirs.push(join(root, entry));
    }
  }
  return dirs;
}

const wanted = new Map();
for (const dir of packageDirs()) {
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) continue;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pj, "utf8"));
  } catch {
    continue;
  }
  for (const [dep, version] of Object.entries(pkg.optionalDependencies ?? {})) {
    if (!targets(dep)) continue;
    if (existsSync(join(root, dep, "package.json"))) continue;
    if (existsSync(join(dir, "node_modules", dep, "package.json"))) continue;
    wanted.set(dep, `${dep}@${version}`);
  }
}

if (wanted.size === 0) {
  console.log(`[native-optionals] nothing missing for ${platform}-${arch}${isMusl ? "-musl" : ""}`);
  process.exit(0);
}

const specs = [...wanted.values()].sort();
console.log(`[native-optionals] installing for ${platform}-${arch}: ${specs.join(" ")}`);
const scratch = mkdtempSync(join(tmpdir(), "native-optionals-"));
execFileSync(
  "npm",
  ["install", "--prefix", scratch, "--no-save", "--no-package-lock", "--no-audit", "--no-fund",
   "--ignore-scripts", "--omit=dev", ...specs],
  { stdio: "inherit" },
);
for (const dep of wanted.keys()) {
  cpSync(join(scratch, "node_modules", dep), join(root, dep), { recursive: true });
}
