// The declaration problems of a work tree (t509): the same check a merge
// makes (declarationProblems in src/merge-declarations.ts, read against
// bin/merge-manifest.json), read here for atelier check on the tree its
// checks run on — the pushed head, or with --merged its merge with main —
// so a builder meets a declaration a landing would refuse before any
// review is asked, not at land after a full review round. A tree with no
// manifest declares nothing and has no problems to find; a manifest that
// cannot be read is itself a problem, named as a merge names it. The work
// tree is read as the merge pipeline reads it (cli/merge-pipeline.mjs);
// each problem is a sentence naming the path.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_PATH, declarationProblems, parseManifest } from "../src/merge-declarations.ts";
import { globToRegExp } from "../src/rules.ts";

export function declarationProblemsIn(dir) {
  const file = join(dir, MANIFEST_PATH);
  if (!existsSync(file)) return [];
  let manifest;
  try { manifest = parseManifest(readFileSync(file, "utf8")); }
  catch (error) { return [error.message]; }
  return declarationProblems(manifest,
    (path) => { try { return readFileSync(join(dir, path), "utf8"); } catch { return null; } },
    (folder) => { try { return readdirSync(join(dir, folder), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { return []; } },
    globToRegExp);
}
