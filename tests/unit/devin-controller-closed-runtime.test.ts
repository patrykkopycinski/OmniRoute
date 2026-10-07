import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";

// Execute the executor's actual stream closures, rather than a duplicated guard.
const source = readFileSync(new URL("../../open-sse/executors/devin-cli.ts", import.meta.url), "utf8");
const start = source.indexOf("        const enc = new TextEncoder();");
const end = source.indexOf("        const env: NodeJS.ProcessEnv", start);
assert.ok(start >= 0 && end > start);
const js = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function actualClosures(controller: ReadableStreamDefaultController<Uint8Array>) {
  return runInNewContext(`${js}; ({ emit, close: closeController });`, {
    controller, TextEncoder,
  }) as {
    emit: (data: string) => void;
    close: () => void;
  };
}

test("actual Devin emit drops stdout after its controller closes", async () => {
  let controls: ReturnType<typeof actualClosures>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controls = actualClosures(controller); },
  });
  controls!.emit("first");
  controls!.close();
  assert.doesNotThrow(() => controls!.emit("late stdout"));
  assert.doesNotThrow(() => controls!.close());
  const reader = stream.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  assert.equal((await reader.read()).done, true);
});

test("actual Devin emit survives consumer cancellation", async () => {
  let controls: ReturnType<typeof actualClosures>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controls = actualClosures(controller); },
  });
  await stream.cancel();
  assert.doesNotThrow(() => controls!.emit("late stdout"));
  assert.doesNotThrow(() => controls!.close());
});
