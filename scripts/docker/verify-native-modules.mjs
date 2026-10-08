#!/usr/bin/env node
// Build-time guard: fail the image build if a native module the gateway
// depends on cannot load on the container's platform. A host-built (macOS)
// standalone bundle ships darwin-only binaries and otherwise boots fine,
// then 500s at request time (sharp -> every cursor/* image request).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));
const failures = [];

try {
  const sharp = require("sharp");
  // 1x1 transparent PNG -> JPEG: exercises libvips decode + encode, the
  // exact path cursorImages.prepareCursorImageForWire takes.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const out = await sharp(png).resize(1, 1).jpeg({ quality: 50 }).toBuffer();
  if (out[0] !== 0xff || out[1] !== 0xd8) throw new Error("sharp produced non-JPEG output");
  const pkgPath = join(process.cwd(), "node_modules/sharp/package.json");
  console.log(`[native-check] sharp OK (${JSON.parse(readFileSync(pkgPath, "utf8")).version})`);
} catch (error) {
  failures.push(`sharp: ${String(error?.message ?? error).split("\n")[0]}`);
}

for (const mod of ["wreq-js", "better-sqlite3"]) {
  try {
    const m = require(mod);
    if (mod === "better-sqlite3") new m(":memory:").prepare("select 1").get();
    console.log(`[native-check] ${mod} OK`);
  } catch (error) {
    failures.push(`${mod}: ${String(error?.message ?? error).split("\n")[0]}`);
  }
}

if (failures.length) {
  console.error(`[native-check] FAILED on ${process.platform}-${process.arch}:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
