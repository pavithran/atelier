// A real SQLite Ledger namespace for tests that need no HTTP listener.
import { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error the namespace is plain JavaScript without declarations
import { Namespace } from "../../src/runtime/namespace.mjs";
import { Ledger } from "../../src/ledger.ts";

const root = mkdtempSync(join(tmpdir(), "atelier-ledger-spec-"));
export const env = {} as Env;
const namespace = new Namespace({ dir: root, Class: Ledger, env });
env.LEDGER = namespace;
after(async () => {
  await namespace.close();
  rmSync(root, { recursive: true, force: true });
});
