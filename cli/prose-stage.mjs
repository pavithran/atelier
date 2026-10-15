import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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
  try {
    mkdirSync(join(workspace, ".scratch"), { recursive: true });
    excludeScratch(workspace);
    writeFileSync(join(workspace, PROSE_STANDARD_COPY), bytes, { mode: 0o600 });
  } catch (e) { return { failed: `the copy could not be written in the workspace: ${e?.code ?? "write error"}` }; }
  return { sha256: createHash("sha256").update(bytes).digest("hex") };
}

// The brief line for `path` with the copy made in `workspace`.
export function stagedProseLine(workspace, checkout, path) {
  return proseStandardLine(path, stageProseStandard(workspace, checkout, path));
}

const NAMED = /Prose standard: this project's prose follows `([^`\n]+)`/;

// A brief composed with proseStandardLine(path), made readable from the
// workspace: the standard is copied in and the line is the copy's. A brief
// that names none is returned as it was.
export function stageBrief(workspace, text, checkout) {
  const path = NAMED.exec(text)?.[1];
  const plain = path ? proseStandardLine(path) : null;
  if (!plain || !text.includes(plain)) return text;
  return text.split(plain).join(stagedProseLine(workspace, checkout, path));
}
