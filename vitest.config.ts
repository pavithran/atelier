import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests whose names end in .spec.ts run inside workerd through the Workers
// test pool, against the bindings wrangler.jsonc declares: the Ledger
// Durable Object with its real SQLite storage. The .test.ts files stay with
// `node --test`, which runs the pure functions in src/rules.ts and src/diff.ts.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The Artifacts binding is declared `remote: true`; without this the
      // pool opens an authenticated connection to the account before any test
      // runs. The Ledger never touches Artifacts, so tests stay local.
      remoteBindings: false,
    }),
  ],
  test: { include: ["test/**/*.spec.ts"] },
});
