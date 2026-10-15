import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve, sep } from "node:path";
import { PROSE_STANDARD_COPY, proseStandardLine } from "../src/prose-standard.ts";
import { excludeScratch } from "./scratch.mjs";

// The prose standard inside the agent's own workspace (t676). The project
// records the standard as a path from the developer's checkout, which a
// workspace under ~/Library/Caches, a reviewer's throwaway clone, or a harness
// confined to its folder (opencode) cannot read. Before a brief is written,
// the standard's text is copied to PROSE_STANDARD_COPY in the workspace and
// the brief names that copy with its hash. A source that cannot be read is
// said in the brief, never dropped.

const MAX_BYTES = 1_000_000;

const refuse = (refusal) => Object.assign(new Error(refusal), { refusal });

// The exclude is kept only in a folder that is itself a repository's top:
// a plain folder (the criteria review's) has none to keep, and one inside
// another repository must not write that repository's exclude.
function excludeIfRepository(workspace) {
  let top;
  try { top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return; }
  if (realpathSync(top) === realpathSync(workspace)) excludeScratch(workspace);
}

// True when the workspace's repository (if it is in one) tracks anything under
// .scratch: a tracked copy would be overwritten and then show as a change that
// `git add -A` commits, since an exclude rule does not untrack a file.
function trackedUnderScratch(workspace) {
  try {
    return execFileSync("git", ["ls-files", "--", ".scratch"], { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== "";
  } catch { return false; }
}

// Writes the copy without following a link the checkout controls: .scratch
// and the destination may be tracked symlinks, so each is lstat-ed, a link or
// anything but a folder / a file is refused, and the copy is a fresh file
// opened exclusively and without following a link.
function writeCopy(workspace, bytes) {
  if (trackedUnderScratch(workspace)) throw refuse(`the checkout tracks ${PROSE_STANDARD_COPY} or other files under .scratch, which the exclude rule cannot untrack, so nothing was written`);
  const root = realpathSync(workspace);
  const scratch = join(workspace, ".scratch");
  const held = lstatOrNull(scratch);
  if (held && held.isSymbolicLink()) throw refuse(".scratch in the workspace is a symbolic link, so nothing was written through it");
  if (held && !held.isDirectory()) throw refuse(".scratch in the workspace is not a folder");
  if (!held) mkdirSync(scratch, { recursive: true });
  const real = realpathSync(scratch);
  if (real !== join(root, ".scratch") && !real.startsWith(root + sep)) throw refuse(".scratch resolves outside the workspace");
  excludeIfRepository(workspace);
  const dest = join(workspace, PROSE_STANDARD_COPY);
  const old = lstatOrNull(dest);
  if (old && old.isSymbolicLink()) throw refuse(`${PROSE_STANDARD_COPY} in the workspace is a symbolic link, so nothing was written through it`);
  if (old && !old.isFile()) throw refuse(`${PROSE_STANDARD_COPY} in the workspace is not a file`);
  if (old) unlinkSync(dest);
  const fd = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeSync(fd, bytes); } finally { closeSync(fd); }
}

function lstatOrNull(path) {
  try { return lstatSync(path); } catch (e) { if (e?.code === "ENOENT") return null; throw e; }
}

// Copies the standard into `workspace`. `checkout` is the registered folder
// of the project (null when this machine registers none). Returns
// { sha256 } or { failed } with the reason, in words for the brief.
export function stageProseStandard(workspace, checkout, path) {
  const source = isAbsolute(path) ? path : checkout ? resolve(checkout, path) : null;
  if (!source) return { failed: "this machine registers no checkout of the project to resolve the relative path from" };
  let bytes;
  try { bytes = readFileSync(source); }
  catch (e) { return { failed: `${source} cannot be read: ${e?.code ?? "read error"}` }; }
  if (!bytes.length) return { failed: `${source} is empty` };
  if (bytes.length > MAX_BYTES) return { failed: `${source} is ${bytes.length} bytes, over the ${MAX_BYTES} a copy may be` };
  try { writeCopy(workspace, bytes); }
  catch (e) { return { failed: `the copy could not be written in the workspace: ${e?.refusal ?? e?.code ?? "write error"}` }; }
  return { sha256: createHash("sha256").update(bytes).digest("hex") };
}

// The brief line for `path` with the copy made in `workspace`.
export function stagedProseLine(workspace, checkout, path) {
  return proseStandardLine(path, stageProseStandard(workspace, checkout, path));
}

// A brief composed with proseStandardLine(path), made readable from the
// workspace: the standard is copied in and the line is the copy's. `path` is
// the project policy's value, handed over by whoever built the brief; it is
// never read back out of `text`, which carries diffs, summaries and briefs
// anyone may have written. A brief without that line is returned as it was.
export function stageBrief(workspace, text, checkout, path) {
  const plain = path ? proseStandardLine(path) : null;
  if (!plain || !text.includes(plain)) return text;
  return text.split(plain).join(stagedProseLine(workspace, checkout, path));
}
