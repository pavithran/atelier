import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The design captures' render step (t499): the same Workers pool as the
// project's own vitest.config.ts, the Ledger with its real SQLite storage,
// running only test/fixtures/design/render.design.ts, which npm test never
// runs. Each page it draws is a console line; the reporter below appends
// those to the file ATELIER_DESIGN_OUT names (scripts/design/capture.ts reads
// it). A reporter of its own, because the reporter Vitest picks when an agent
// runs it prints no console output from a passing test.
const root = fileURLToPath(new URL("../..", import.meta.url));
const out = process.env.ATELIER_DESIGN_OUT;
const MAGIC = "{\"magic\":\"design-capture\"";
export default defineConfig({
  root,
  plugins: [cloudflareTest({ wrangler: { configPath: `${root}/wrangler.jsonc` }, remoteBindings: false })],
  test: {
    include: ["test/fixtures/design/render.design.ts"],
    reporters: [
      "default",
      { onUserConsoleLog(log: { content: string }) { if (out && log.content.startsWith(MAGIC)) appendFileSync(out, log.content.endsWith("\n") ? log.content : `${log.content}\n`); } },
    ],
    // The default reporter prints every other line; these are megabytes of HTML.
    onConsoleLog: (log) => (log.startsWith(MAGIC) ? false : undefined),
  },
});
