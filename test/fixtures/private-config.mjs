// A config.json under os.tmpdir() naming projects' private files, for tests
// that call the CLI's modules in-process: the private-file guard reads the
// project's configuration itself (cli/private.mjs, privateGuardFor), from
// ATELIER_CONFIG_DIR, which this sets for the test and puts back after it.
// The iCloud ai-projects folder is set to one that does not exist (unless
// the test named one), so no test reads this Mac's own.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function privateConfig(t, projects) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-private-config-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ projects: Object.fromEntries(Object.entries(projects).map(([name, entry]) => [name, { ...entry }])) }));
  const previous = process.env.ATELIER_CONFIG_DIR, root = process.env.ATELIER_PRIVATE_ROOT;
  process.env.ATELIER_CONFIG_DIR = dir;
  process.env.ATELIER_PRIVATE_ROOT ||= join(dir, "no-icloud");
  t.after(() => {
    if (previous === undefined) delete process.env.ATELIER_CONFIG_DIR; else process.env.ATELIER_CONFIG_DIR = previous;
    if (root === undefined) delete process.env.ATELIER_PRIVATE_ROOT; else process.env.ATELIER_PRIVATE_ROOT = root;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
