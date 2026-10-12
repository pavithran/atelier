#!/usr/bin/env node
// The merge declarations of a project and the merge drivers Git runs for
// them (t463). This file stands alone, importing nothing but Node's own
// modules: cli/merge-pipeline.mjs copies it into each managed clone's Git
// directory and names that copy in the clone's merge.<driver>.driver
// settings, so a merge runs the driver the clone was set up with, never a
// file the merge itself could change in the work tree.
//
// The declarations live in MANIFEST_PATH, in the project's own tree:
//
//   generators  outputs written by a command from declared source inputs.
//               An output is never merged as text: the driver below leaves
//               it in conflict, and the pipeline regenerates it once every
//               source path has merged cleanly.
//   records     line files of order-independent records, one per line, each
//               with a unique key. Both sides' records are united by key;
//               a key both sides added differently, edited differently, or
//               one side edited and the other deleted stays in conflict.
//               A framed record file ("framed": true) holds its records as
//               one unbroken run of complete lines between a fixed header
//               and footer, the lines its key pattern does not match: a
//               list of one-line entries in source, each well formed alone,
//               such as src/capability-declarations.ts. Its frame merges
//               whole, a side's change taken only where the other left it.
//   registries  folders whose files are each one entry (a command, a
//               route): adding an entry adds a file, so independent
//               additions never touch the same file. Keys are read from the
//               files and must be unique across the folder.
//
// A structured declaration (JSON, JavaScript, TypeScript, YAML, TOML) is
// never a plain record file: union of its lines would not keep it well
// formed, so it belongs in a registry, one entry per file, or, where each
// entry is one complete line in a fixed frame, in a framed record file.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MANIFEST_PATH = "bin/merge-manifest.json";
export const GENERATED_DRIVER = "atelier-generated";
export const RECORDS_DRIVER = "atelier-records";
const STRUCTURED = /\.(json|jsonc|js|mjs|cjs|ts|mts|cts|ya?ml|toml)$/i;
const NAME = /^[a-z0-9][a-z0-9-]*$/;

// A repository path as declared: relative, `/` between parts, nothing that
// climbs out or into .git.
function plainPath(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\\")
    && path.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

function keyPattern(source, where, problems) {
  if (typeof source !== "string" || !source) { problems.push(`${where} has no key pattern`); return null; }
  let re;
  try { re = new RegExp(source, "m"); } catch (error) { problems.push(`${where}'s key pattern does not compile: ${error.message}`); return null; }
  if (new RegExp(`${source}|`).exec("").length < 2) problems.push(`${where}'s key pattern ${source} has no capture group naming the key`);
  return re;
}

// The manifest's text, read and checked whole. Answers the declarations,
// or throws naming every problem found, so a misdeclared manifest stops a
// merge rather than leaving a path undeclared.
export function parseManifest(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (error) { throw new Error(`${MANIFEST_PATH} is not valid JSON: ${error.message}`); }
  const problems = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${MANIFEST_PATH} must hold an object`);
  if (raw.version !== 1) problems.push(`${MANIFEST_PATH} must declare "version": 1`);
  for (const key of Object.keys(raw)) if (!["version", "generators", "records", "registries"].includes(key)) problems.push(`${MANIFEST_PATH} declares an unknown section "${key}"`);
  const list = (key) => (raw[key] === undefined ? [] : Array.isArray(raw[key]) ? raw[key] : (problems.push(`"${key}" must be a list`), []));
  const names = new Set(), owners = new Map();
  const generators = list("generators").map((g, i) => {
    const where = `generator ${g?.name ?? `#${i + 1}`}`;
    if (!NAME.test(g?.name ?? "")) problems.push(`${where} needs a name of lower-case letters, digits and dashes`);
    else if (names.has(g.name)) problems.push(`${where} is declared twice`);
    names.add(g?.name);
    if (!Array.isArray(g?.command) || !g.command.length || !g.command.every((w) => typeof w === "string" && w)) problems.push(`${where} needs its command as a list of words, run without a shell`);
    if (!Array.isArray(g?.inputs) || !g.inputs.length || !g.inputs.every((p) => typeof p === "string" && p && !p.startsWith("/"))) problems.push(`${where} needs the source inputs it reads, as a list of paths or globs`);
    if (!Array.isArray(g?.outputs) || !g.outputs.length) problems.push(`${where} needs the outputs it writes`);
    for (const out of Array.isArray(g?.outputs) ? g.outputs : []) {
      if (!plainPath(out) || /[*?[]/.test(out)) problems.push(`${where} declares the output ${JSON.stringify(out)}, which is not one plain file path`);
      else if (owners.has(out)) problems.push(`${out} is declared by both ${owners.get(out)} and ${where}`);
      else owners.set(out, where);
    }
    return { name: g?.name, command: g?.command ?? [], inputs: g?.inputs ?? [], outputs: g?.outputs ?? [] };
  });
  const records = list("records").map((r, i) => {
    const where = `record file ${r?.path ?? `#${i + 1}`}`;
    if (!plainPath(r?.path)) problems.push(`${where} needs a plain file path`);
    else if (STRUCTURED.test(r.path) && r.framed !== true) problems.push(`${where} is a structured file; union of its lines would not keep it well formed, so declare it as a registry of one file per entry, or as framed where each record is one complete line`);
    else if (owners.has(r.path)) problems.push(`${r.path} is declared by both ${owners.get(r.path)} and ${where}`);
    else owners.set(r.path, where);
    if (r?.framed !== undefined && typeof r.framed !== "boolean") problems.push(`${where}'s framed must be true or false`);
    const re = keyPattern(r?.key ?? "^(\\S+)", where, problems);
    return { path: r?.path, key: r?.key ?? "^(\\S+)", pattern: re, framed: r?.framed === true };
  });
  const registries = list("registries").map((g, i) => {
    const where = `registry ${g?.name ?? `#${i + 1}`}`;
    if (!NAME.test(g?.name ?? "")) problems.push(`${where} needs a name of lower-case letters, digits and dashes`);
    else if (names.has(g.name)) problems.push(`${where} is declared twice`);
    names.add(g?.name);
    if (!plainPath(g?.dir)) problems.push(`${where} needs the plain path of its folder`);
    const re = keyPattern(g?.key, where, problems);
    // exclude: file names in the folder that are not entries, such as an
    // index generated from them.
    if (g?.exclude !== undefined && !(Array.isArray(g.exclude) && g.exclude.every((n) => typeof n === "string" && n && !n.includes("/")))) problems.push(`${where}'s exclude must be a list of file names in its folder`);
    const exclude = Array.isArray(g?.exclude) ? g.exclude : [];
    return { name: g?.name, dir: g?.dir, key: g?.key, pattern: re, exclude, ...(typeof g?.files === "string" ? { files: g.files } : {}) };
  });
  if (problems.length) throw new Error(`${MANIFEST_PATH} is misdeclared:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  return { generators, records, registries };
}

// One record file's lines keyed. A blank line, a line the pattern names no
// key in, a duplicate key and a missing final newline are each a problem:
// the record format has no room for them, and a merge would hide them. In
// a framed file the lines before the first record are its head and those
// after the last its tail; a keyless line between records is a problem.
export function readRecords(text, pattern, framed = false) {
  const records = new Map(), problems = [], head = [], tail = [];
  if (text && !text.endsWith("\n")) problems.push("the file does not end with a newline");
  const lines = text ? text.replace(/\n$/, "").split("\n") : [];
  lines.forEach((line, i) => {
    if (/^(<<<<<<<|=======|>>>>>>>)( |$)/.test(line)) { problems.push(`line ${i + 1} is a conflict marker`); return; }
    const key = line.trim() ? pattern.exec(line)?.[1] : undefined;
    if (framed && !key) { (records.size ? tail : head).push(line); return; }
    if (!key) { problems.push(`line ${i + 1} holds no record key`); return; }
    if (tail.length) { problems.push(`line ${i + 1} is a record after the frame's closing lines`); return; }
    if (records.has(key)) { problems.push(`the key ${key} appears twice (lines ${records.get(key).at} and ${i + 1})`); return; }
    records.set(key, { line, at: i + 1 });
  });
  return { records, problems, head: head.join("\n"), tail: tail.join("\n") };
}

// A framed side that holds no records has no line between its frame's
// opening and closing lines, so readRecords reads its whole frame as the
// opening. Each such side is split where its lines take the opening and
// closing lines of a side that holds records, so a side emptied of every
// record merges like any other deletion; a frame that cannot be split that
// way, or only at more than one place, is a problem, never a guess.
function splitEmptyFrames(sides, problems) {
  const known = Object.values(sides).filter((side) => side.records.size);
  if (!known.length) return;
  for (const [name, side] of Object.entries(sides)) {
    if (side.records.size) continue;
    const lines = side.head === "" ? [] : side.head.split("\n");
    let best = 0, at = [];
    for (let k = 0; k <= lines.length; k++) {
      const head = lines.slice(0, k).join("\n"), tail = lines.slice(k).join("\n");
      const score = Math.max(...known.map((ref) => (ref.head === head) + (ref.tail === tail)));
      if (score > best) { best = score; at = [k]; } else if (score === best && score) at.push(k);
    }
    if (at.length !== 1) { problems.push(`${name}: it holds no records, and its frame cannot be told apart into the opening and closing lines the other sides hold`); continue; }
    side.head = lines.slice(0, at[0]).join("\n");
    side.tail = lines.slice(at[0]).join("\n");
  }
}

// The three-way union of a record file, by key. A key one side alone
// changed (added, edited or deleted) takes that side; a key both sides
// changed the same way takes it once; a key both sides changed differently
// is a conflict. The merged records are sorted by key, so the result is the
// same whichever side is ours. Answers { text, conflicts, problems }:
// `problems` are records a side holds that break the format (and so cannot
// be merged at all), `conflicts` the keys left for a person to resolve.
// A framed file keeps its records' order: the base's, then the keys added
// on either side in key order, so it too is the same whichever side is
// ours, and its head and tail each take the one side that changed them.
export function mergeRecords(base, ours, theirs, pattern, framed = false) {
  const [o, a, b] = [base, ours, theirs].map((text) => readRecords(text, pattern, framed));
  const problems = [...a.problems.map((p) => `ours: ${p}`), ...b.problems.map((p) => `theirs: ${p}`), ...o.problems.map((p) => `base: ${p}`)];
  if (framed) splitEmptyFrames({ base: o, ours: a, theirs: b }, problems);
  const byKey = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const keys = framed
    ? [...o.records.keys(), ...[...new Set([...a.records.keys(), ...b.records.keys()])].filter((k) => !o.records.has(k)).sort(byKey)]
    : [...new Set([...o.records.keys(), ...a.records.keys(), ...b.records.keys()])].sort(byKey);
  const out = [], conflicts = [];
  // A frame part both sides changed differently stays in conflict.
  const frame = (part, name) => {
    const [was, mine, yours] = [o, a, b].map((side) => side[part]);
    if (mine === yours || was === yours) return mine === "" ? [] : mine.split("\n");
    if (was === mine) return yours === "" ? [] : yours.split("\n");
    conflicts.push(`the frame's ${name}: edited differently on both sides`);
    return ["<<<<<<< ours", ...(mine === "" ? [] : mine.split("\n")), "=======", ...(yours === "" ? [] : yours.split("\n")), ">>>>>>> theirs"];
  };
  if (framed) out.push(...frame("head", "opening lines"));
  for (const key of keys) {
    const [was, mine, yours] = [o, a, b].map((side) => side.records.get(key)?.line);
    if (mine === yours) { if (mine !== undefined) out.push(mine); continue; }
    if (was === mine) { if (yours !== undefined) out.push(yours); continue; }
    if (was === yours) { if (mine !== undefined) out.push(mine); continue; }
    const what = was === undefined ? "added by both sides with different records" : mine === undefined || yours === undefined ? "deleted on one side and edited on the other" : "edited differently on both sides";
    conflicts.push(`${key}: ${what}`);
    out.push("<<<<<<< ours", ...(mine === undefined ? [] : [mine]), "=======", ...(yours === undefined ? [] : [yours]), ">>>>>>> theirs");
  }
  if (framed) out.push(...frame("tail", "closing lines"));
  return { text: out.length ? `${out.join("\n")}\n` : "", conflicts, problems };
}

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
