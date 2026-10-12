// A project's merge declarations and the record merge (t463), pure: no
// imports and no I/O, so every merge reads them the same way. The CLI's
// merge pipeline (cli/merge-pipeline.mjs) and its merge driver
// (cli/merge-driver.mjs, which runs with a copy of this file beside it in
// each managed clone's Git directory) use them in a clone; the Worker's
// merge preview and its merged check tree (src/preview/merge.ts) use them
// where no generator can run. Only erasable TypeScript, since Node runs the
// copy as it is.
//
// The declarations live in MANIFEST_PATH, in the project's own tree:
//
//   generators  outputs written by a command from declared source inputs.
//               An output is never merged as text: the driver leaves it in
//               conflict, and the pipeline regenerates it once every source
//               path has merged cleanly.
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

export const MANIFEST_PATH = "bin/merge-manifest.json";
export const GENERATED_DRIVER = "atelier-generated";
export const RECORDS_DRIVER = "atelier-records";
const STRUCTURED = /\.(json|jsonc|js|mjs|cjs|ts|mts|cts|ya?ml|toml)$/i;
const NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface Generator { name: string; command: string[]; inputs: string[]; outputs: string[] }
export interface RecordFile { path: string; key: string; pattern: RegExp; framed: boolean }
export interface Registry { name: string; dir: string; key: string; pattern: RegExp; exclude: string[]; files?: string }
export interface Manifest { generators: Generator[]; records: RecordFile[]; registries: Registry[] }

// A repository path as declared: relative, `/` between parts, nothing that
// climbs out or into .git.
function plainPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\\")
    && path.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

function keyPattern(source: unknown, where: string, problems: string[]): RegExp {
  const never = /(?!)/;
  if (typeof source !== "string" || !source) { problems.push(`${where} has no key pattern`); return never; }
  let re: RegExp;
  try { re = new RegExp(source, "m"); } catch (error) { problems.push(`${where}'s key pattern does not compile: ${(error as Error).message}`); return never; }
  if ((new RegExp(`${source}|`).exec("") ?? []).length < 2) problems.push(`${where}'s key pattern ${source} has no capture group naming the key`);
  return re;
}

// The manifest's text, read and checked whole. Answers the declarations,
// or throws naming every problem found, so a misdeclared manifest stops a
// merge rather than leaving a path undeclared.
export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (error) { throw new Error(`${MANIFEST_PATH} is not valid JSON: ${(error as Error).message}`); }
  const problems: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${MANIFEST_PATH} must hold an object`);
  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1) problems.push(`${MANIFEST_PATH} must declare "version": 1`);
  for (const key of Object.keys(doc)) if (!["version", "generators", "records", "registries"].includes(key)) problems.push(`${MANIFEST_PATH} declares an unknown section "${key}"`);
  type Entry = Record<string, any> | null | undefined;
  const list = (key: string): Entry[] => (doc[key] === undefined ? [] : Array.isArray(doc[key]) ? doc[key] as Entry[] : (problems.push(`"${key}" must be a list`), []));
  const names = new Set<unknown>(), owners = new Map<string, string>();
  const generators = list("generators").map((g, i): Generator => {
    const where = `generator ${g?.name ?? `#${i + 1}`}`;
    if (!NAME.test(g?.name ?? "")) problems.push(`${where} needs a name of lower-case letters, digits and dashes`);
    else if (names.has(g!.name)) problems.push(`${where} is declared twice`);
    names.add(g?.name);
    if (!Array.isArray(g?.command) || !g.command.length || !g.command.every((w: unknown) => typeof w === "string" && w)) problems.push(`${where} needs its command as a list of words, run without a shell`);
    if (!Array.isArray(g?.inputs) || !g.inputs.length || !g.inputs.every((p: unknown) => typeof p === "string" && p && !p.startsWith("/"))) problems.push(`${where} needs the source inputs it reads, as a list of paths or globs`);
    if (!Array.isArray(g?.outputs) || !g.outputs.length) problems.push(`${where} needs the outputs it writes`);
    for (const out of Array.isArray(g?.outputs) ? g.outputs as unknown[] : []) {
      if (!plainPath(out) || /[*?[]/.test(out)) problems.push(`${where} declares the output ${JSON.stringify(out)}, which is not one plain file path`);
      else if (owners.has(out)) problems.push(`${out} is declared by both ${owners.get(out)} and ${where}`);
      else owners.set(out, where);
    }
    return { name: g?.name, command: g?.command ?? [], inputs: g?.inputs ?? [], outputs: g?.outputs ?? [] };
  });
  const records = list("records").map((r, i): RecordFile => {
    const where = `record file ${r?.path ?? `#${i + 1}`}`;
    if (!plainPath(r?.path)) problems.push(`${where} needs a plain file path`);
    else if (STRUCTURED.test(r!.path) && r!.framed !== true) problems.push(`${where} is a structured file; union of its lines would not keep it well formed, so declare it as a registry of one file per entry, or as framed where each record is one complete line`);
    else if (owners.has(r!.path)) problems.push(`${r!.path} is declared by both ${owners.get(r!.path)} and ${where}`);
    else owners.set(r!.path, where);
    if (r?.framed !== undefined && typeof r.framed !== "boolean") problems.push(`${where}'s framed must be true or false`);
    const key = r?.key ?? "^(\\S+)";
    return { path: r?.path, key, pattern: keyPattern(key, where, problems), framed: r?.framed === true };
  });
  const registries = list("registries").map((g, i): Registry => {
    const where = `registry ${g?.name ?? `#${i + 1}`}`;
    if (!NAME.test(g?.name ?? "")) problems.push(`${where} needs a name of lower-case letters, digits and dashes`);
    else if (names.has(g!.name)) problems.push(`${where} is declared twice`);
    names.add(g?.name);
    if (!plainPath(g?.dir)) problems.push(`${where} needs the plain path of its folder`);
    const pattern = keyPattern(g?.key, where, problems);
    // exclude: file names in the folder that are not entries, such as an
    // index generated from them.
    if (g?.exclude !== undefined && !(Array.isArray(g.exclude) && g.exclude.every((n: unknown) => typeof n === "string" && n && !n.includes("/")))) problems.push(`${where}'s exclude must be a list of file names in its folder`);
    const exclude = Array.isArray(g?.exclude) ? g.exclude as string[] : [];
    return { name: g?.name, dir: g?.dir, key: g?.key, pattern, exclude, ...(typeof g?.files === "string" ? { files: g.files } : {}) };
  });
  if (problems.length) throw new Error(`${MANIFEST_PATH} is misdeclared:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  return { generators, records, registries };
}

export interface RecordsRead { records: Map<string, { line: string; at: number }>; problems: string[]; head: string; tail: string }

// One record file's lines keyed. A blank line, a line the pattern names no
// key in, a duplicate key and a missing final newline are each a problem:
// the record format has no room for them, and a merge would hide them. In
// a framed file the lines before the first record are its head and those
// after the last its tail; a keyless line between records is a problem.
export function readRecords(text: string, pattern: RegExp, framed = false): RecordsRead {
  const records = new Map<string, { line: string; at: number }>(), problems: string[] = [], head: string[] = [], tail: string[] = [];
  if (text && !text.endsWith("\n")) problems.push("the file does not end with a newline");
  const lines = text ? text.replace(/\n$/, "").split("\n") : [];
  lines.forEach((line, i) => {
    if (/^(<<<<<<<|=======|>>>>>>>)( |$)/.test(line)) { problems.push(`line ${i + 1} is a conflict marker`); return; }
    const key = line.trim() ? pattern.exec(line)?.[1] : undefined;
    if (framed && !key) { (records.size ? tail : head).push(line); return; }
    if (!key) { problems.push(`line ${i + 1} holds no record key`); return; }
    if (tail.length) { problems.push(`line ${i + 1} is a record after the frame's closing lines`); return; }
    if (records.has(key)) { problems.push(`the key ${key} appears twice (lines ${records.get(key)!.at} and ${i + 1})`); return; }
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
function splitEmptyFrames(sides: Record<string, RecordsRead>, problems: string[]): void {
  const known = Object.values(sides).filter((side) => side.records.size);
  if (!known.length) return;
  for (const [name, side] of Object.entries(sides)) {
    if (side.records.size) continue;
    const lines = side.head === "" ? [] : side.head.split("\n");
    let best = 0, at: number[] = [];
    for (let k = 0; k <= lines.length; k++) {
      const head = lines.slice(0, k).join("\n"), tail = lines.slice(k).join("\n");
      const score = Math.max(...known.map((ref) => Number(ref.head === head) + Number(ref.tail === tail)));
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
export function mergeRecords(base: string, ours: string, theirs: string, pattern: RegExp, framed = false): { text: string; conflicts: string[]; problems: string[] } {
  const [o, a, b] = [base, ours, theirs].map((text) => readRecords(text, pattern, framed));
  const problems = [...a.problems.map((p) => `ours: ${p}`), ...b.problems.map((p) => `theirs: ${p}`), ...o.problems.map((p) => `base: ${p}`)];
  if (framed) splitEmptyFrames({ base: o, ours: a, theirs: b }, problems);
  const byKey = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const keys = framed
    ? [...o.records.keys(), ...[...new Set([...a.records.keys(), ...b.records.keys()])].filter((k) => !o.records.has(k)).sort(byKey)]
    : [...new Set([...o.records.keys(), ...a.records.keys(), ...b.records.keys()])].sort(byKey);
  const out: string[] = [], conflicts: string[] = [];
  const lines = (text: string) => (text === "" ? [] : text.split("\n"));
  // A frame part both sides changed differently stays in conflict.
  const frame = (part: "head" | "tail", name: string) => {
    const [was, mine, yours] = [o, a, b].map((side) => side[part]);
    if (mine === yours || was === yours) return lines(mine);
    if (was === mine) return lines(yours);
    conflicts.push(`the frame's ${name}: edited differently on both sides`);
    return ["<<<<<<< ours", ...lines(mine), "=======", ...lines(yours), ">>>>>>> theirs"];
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

// The generators a merge must run: those whose inputs or outputs both sides
// changed since their merge base (`a`, `b`), so the merged tree holds a
// combination neither side generated, and those with an output left in
// conflict. With no merge base (`mb` null) every generator runs. `glob`
// turns an input pattern into a RegExp (globToRegExp in src/rules.ts).
export function generatorsToRun(manifest: Manifest | null, { mb, a, b, conflicted = [] }: { mb: string | null; a: string[]; b: string[]; conflicted?: string[] }, glob: (pattern: string) => RegExp): Generator[] {
  if (!manifest?.generators.length) return [];
  return manifest.generators.filter((g) => {
    const inputs = g.inputs.map(glob);
    const touches = (path: string) => g.outputs.includes(path) || inputs.some((re) => re.test(path));
    return g.outputs.some((o) => conflicted.includes(o)) || !mb || (a.some(touches) && b.some(touches));
  });
}

// Validate the merged records and registry entries in both CLI and Worker.
export function declarationProblems(manifest: Manifest | null, read: (path: string) => string | null, list: (dir: string) => string[], glob: (pattern: string) => RegExp, skip = new Set<string>()): string[] {
  const problems: string[] = [];
  for (const record of manifest?.records ?? []) {
    if (skip.has(record.path)) continue;
    const text = read(record.path);
    if (text === null) continue;
    for (const p of readRecords(text, record.pattern, record.framed).problems) problems.push(`${record.path}: ${p}`);
  }
  for (const registry of manifest?.registries ?? []) {
    const match = registry.files ? glob(registry.files) : null;
    const seen = new Map<string, string>();
    for (const name of list(registry.dir).filter((n) => (!match || match.test(n)) && !registry.exclude.includes(n)).sort()) {
      const path = `${registry.dir}/${name}`;
      const key = registry.pattern.exec(read(path) ?? "")?.[1];
      if (!key) problems.push(`${path} names no key for the ${registry.name} registry`);
      else if (seen.has(key)) problems.push(`the ${registry.name} registry key ${key} is declared by both ${seen.get(key)} and ${path}`);
      else seen.set(key, path);
    }
  }
  return problems;
}
