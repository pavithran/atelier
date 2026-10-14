// A config.json under os.tmpdir() naming projects' private files, for tests
// that call the CLI's modules in-process: the private-file guard reads the
// project's configuration itself (cli/private.mjs, privateGuardFor), from
// ATELIER_CONFIG_DIR, which this sets for the test and puts back after it.
// Each entry keeps an empty copy of the iCloud list, so the guard does not
// depend on this Mac's own iCloud folder.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function privateConfig(t, projects) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-private-config-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ projects: Object.fromEntries(Object.entries(projects).map(([name, entry]) => [name, { privateFromList: [], ...entry }])) }));
  const previous = process.env.ATELIER_CONFIG_DIR;
  process.env.ATELIER_CONFIG_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.ATELIER_CONFIG_DIR; else process.env.ATELIER_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
