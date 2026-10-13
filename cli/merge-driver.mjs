#!/usr/bin/env node
// The merge drivers Git runs for a project's declared paths (t463). The
// declarations and the record merge are src/merge-declarations.ts, pure and
// shared with the Worker's merge preview. cli/merge-pipeline.mjs copies this
// file into each managed clone's Git directory with that module beside it
// (as merge-declarations.mts), and names the copy in the clone's
// merge.<driver>.driver settings, so a merge runs the driver the clone was
// set up with, never a file the merge itself could change in the work tree.
// Run from the repository, it reads the module from src/ instead.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DECLARATIONS_COPY = "merge-declarations.mts";
const beside = join(here, DECLARATIONS_COPY);
const declarations = await import(pathToFileURL(existsSync(beside) ? beside : join(here, "..", "src", "merge-declarations.ts")).href);
export const { MANIFEST_PATH, GENERATED_DRIVER, RECORDS_DRIVER, parseManifest, readRecords, mergeRecords } = declarations;

// The record declaration for `path`, read from the manifest in the work
// tree Git runs the driver in. A manifest that cannot be read or does not
// declare the path leaves the file in conflict: union is used only where it
// is declared.
function declaredRecords(path) {
  let manifest;
  try { manifest = parseManifest(readFileSync(MANIFEST_PATH, "utf8")); } catch (error) { return { why: error.message }; }
  const found = manifest.records.find((r) => r.path === path);
  return found ? { record: found } : { why: `${path} is routed to ${RECORDS_DRIVER} in .gitattributes but ${MANIFEST_PATH} declares no record file there` };
}

// Git's call: driver base ours theirs path. Exit 0 writes the merge to
// `ours`; any other status leaves the path in conflict with what `ours`
// then holds.
function main([kind, base, ours, theirs, path]) {
  const read = (file) => readFileSync(file, "utf8");
  if (kind === "generated") {
    // `ours` is left as it is, with no markers: the path stays unmerged in
    // the index, so no commit can take it until it is regenerated.
    process.stderr.write(`atelier: ${path} is a generated output; it is regenerated once the sources merge, never merged as text\n`);
    return 1;
  }
  if (kind !== "records") { process.stderr.write(`atelier merge driver: unknown kind ${kind}\n`); return 2; }
  const { record, why } = declaredRecords(path);
  if (!record) { process.stderr.write(`atelier: ${why}; ${path} is left in conflict\n`); return 1; }
  const merged = mergeRecords(read(base), read(ours), read(theirs), record.pattern, record.framed);
  if (merged.problems.length) {
    process.stderr.write(`atelier: ${path} breaks the record format, so it is left in conflict:\n${merged.problems.map((p) => `  ${p}`).join("\n")}\n`);
    return 1;
  }
  writeFileSync(ours, merged.text);
  if (merged.conflicts.length) {
    process.stderr.write(`atelier: ${path} has records that need resolving:\n${merged.conflicts.map((c) => `  ${c}`).join("\n")}\n`);
    return 1;
  }
  return 0;
}

const invoked = (() => { try { return realpathSync(process.argv[1]); } catch { return null; } })();
if (invoked && realpathSync(fileURLToPath(import.meta.url)) === invoked) process.exitCode = main(process.argv.slice(2));
