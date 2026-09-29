import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// Ad-hoc config to run the 4 merge-touched tests/unit/*.test.ts files under
// vitest per the merge-verification task. Not part of the committed test
// suite (those files are node:test-based and normally run via `npm run
// test:unit`); this file is a scratch verification aid only.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/_setup/vitestUiPolyfills.ts"],
    include: [
      "tests/unit/cursor-agent-session.test.ts",
      "tests/unit/stream-passthrough-usage-estimation.test.ts",
      "tests/unit/kimi-tool-call-narration.test.ts",
      "tests/unit/semantic-cache-no-truncated-writes.test.ts",
    ],
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@omniroute/open-sse": path.resolve(__dirname, "./open-sse"),
    },
  },
});
