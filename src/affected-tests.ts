// A project's affected-tests check (G20, lessons-to-2.0; 1.x task t394). A
// task's check runs only the tests its changed files map to, plus the other
// required checks (the typecheck among them), and the full suite runs once
// at the shipped head, as a step of `atelier ship` before anything is
// delivered. The selection is deterministic: the project declares it, either
// as a map from changed-path globs to test files or as a read-only command
// that lists the affected tests. Atelier never guesses one: a changed path
// the map does not cover, a declared test file the head lacks, or a list
// command that fails, runs the full suite and says why.
import { matchesAny, RuleError } from "./rules.ts";
import { refusalOf } from "./checks.ts";

export interface AffectedMapEntry { paths: string[]; tests: string[] }

export interface AffectedTests {
  // The registered check (one of policy.checks, the full suite) that a task's
  // check replaces with the affected tests. Ship runs it whole.
  check: string;
  // The command that runs the selected tests: {tests} is replaced by their
  // paths, each quoted for the shell.
  run: string;
  // Either the declared map: a changed path matching any glob of an entry
  // selects that entry's tests (globs over the head's tracked files allowed);
  // an entry with no tests declares the paths need none.
  map?: AffectedMapEntry[];
  // Or a read-only command that prints the affected test paths, one per line,
  // given the changed paths on its standard input, one per line.
  list?: string;
}

export const TESTS_TOKEN = "{tests}";
const MAP_MAX = 200;

const bad = (detail: string) => new RuleError("bad_checks", `affectedTests ${detail}`, 400);
const strings = (v: unknown, what: string, empty = false): string[] => {
  if (!Array.isArray(v) || (!empty && !v.length) || v.some((s) => typeof s !== "string" || !s.trim())) throw bad(`${what} must be a list of paths or globs${empty ? "" : " with something in it"}`);
  return v.map((s: string) => s.trim());
};

// The declaration as a route body gives it, checked; null clears it.
export function parseAffectedTests(v: unknown): AffectedTests | null {
  if (v === null) return null;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad("must be { check, run, map } or { check, run, list }");
  const o = v as Record<string, unknown>;
  if (typeof o.check !== "string" || !o.check.trim()) throw bad("check must name the registered check it stands in for, the full suite");
  if (typeof o.run !== "string" || !o.run.includes(TESTS_TOKEN)) throw bad(`run must be the command that runs the selected tests, with ${TESTS_TOKEN} where their paths go`);
  if ((o.map === undefined) === (o.list === undefined)) throw bad("needs either map or list, not both");
  const out: AffectedTests = { check: o.check.trim(), run: o.run.trim() };
  if (o.map !== undefined) {
    if (!Array.isArray(o.map) || !o.map.length || o.map.length > MAP_MAX) throw bad(`map must be a list of 1 to ${MAP_MAX} { paths, tests } entries`);
    out.map = o.map.map((e: unknown) => {
      if (!e || typeof e !== "object") throw bad("map entries must be { paths, tests }");
      const r = e as Record<string, unknown>;
      return { paths: strings(r.paths, "map paths"), tests: strings(r.tests, "map tests", true) };
    });
  } else {
    if (typeof o.list !== "string" || !o.list.trim()) throw bad("list must be the command that prints the affected tests");
    out.list = o.list.trim();
  }
  // Commands that are never read-only are refused here, as checks are.
  for (const cmd of [out.run.replaceAll(TESTS_TOKEN, "test"), ...(out.list ? [out.list] : [])]) {
    const why = refusalOf(cmd);
    if (why) throw bad(`names \`${cmd}\`, which ${why}; a check never does`);
  }
  return out;
}

// The declaration after an init: the one given, whose check must be
// registered; else the one recorded, while its check still is.
export function settleAffectedTests(checks: readonly string[], given: AffectedTests | null | undefined, current: AffectedTests | undefined): AffectedTests | undefined {
  if (given === null) return undefined;
  if (given === undefined) return current && checks.includes(current.check) ? current : undefined;
  if (!checks.includes(given.check)) throw new RuleError("bad_checks", `affectedTests names \`${given.check}\`, which is not a registered check; name the full-suite check given with --check`, 400);
  return given;
}

export type Selection =
  | { kind: "affected"; tests: string[]; why: string }
  | { kind: "full"; why: string };

// The tests a change selects through the declared map. `changed` is the
// change's paths against main (null when unmeasured); `files` the head's
// tracked files, which globs in the map are matched against and literal test
// paths are looked up in.
export function selectByMap(map: readonly AffectedMapEntry[], changed: readonly string[] | null | undefined, files: readonly string[]): Selection {
  if (!Array.isArray(changed)) return { kind: "full", why: UNMEASURED };
  const tracked = new Set(files);
  const tests = new Set<string>();
  for (const path of changed) {
    const entries = map.filter((e) => matchesAny(path, e.paths));
    if (!entries.length) return { kind: "full", why: `${path} is in no entry of the declared map` };
    for (const e of entries) {
      for (const t of e.tests) {
        if (/[*?[]/.test(t)) {
          const found = files.filter((f) => matchesAny(f, [t]));
          if (!found.length) return { kind: "full", why: `the declared tests ${t} match no file at this head` };
          for (const f of found) tests.add(f);
        } else if (!tracked.has(t)) return { kind: "full", why: `the declared test ${t} is not a file at this head` };
        else tests.add(t);
      }
    }
  }
  const list = [...tests].sort();
  return { kind: "affected", tests: list, why: `${list.length} test file${list.length === 1 ? "" : "s"} the declared map selects for ${changed.length} changed path${changed.length === 1 ? "" : "s"}` };
}

// The tests a list command printed, one per line; its exit decides.
export function selectByList(status: number | null, output: string, files: readonly string[]): Selection {
  if (status !== 0) return { kind: "full", why: `the list command exited ${status ?? "by a signal"}` };
  const tracked = new Set(files);
  const tests = [...new Set(output.split("\n").map((l) => l.trim()).filter(Boolean))].sort();
  const missing = tests.find((t) => !tracked.has(t));
  if (missing) return { kind: "full", why: `the list command named ${missing}, which is not a file at this head` };
  return { kind: "affected", tests, why: `${tests.length} test file${tests.length === 1 ? "" : "s"} the declared list command printed` };
}

export const UNMEASURED = "the changed paths against main could not be measured (no merge base with main was read)";

// The selection for a task check: the map's, or the list command's run with
// the changed paths (`list` runs it and gives its exit status and output). A
// change whose paths were not measured (undefined or null, as the clean
// clone reports a failed merge-base) selects the full suite on either path,
// and the list command is not run.
export async function selectTests(a: Pick<AffectedTests, "map" | "list">, changed: readonly string[] | null | undefined, files: readonly string[], list: (changed: readonly string[]) => Promise<{ status: number | null; output: string }>): Promise<Selection> {
  if (!Array.isArray(changed)) return { kind: "full", why: UNMEASURED };
  if (a.map) return selectByMap(a.map, changed, files);
  const r = await list(changed);
  return selectByList(r.status, r.output, files);
}

const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

// The command that runs the selected tests.
export function affectedCommand(run: string, tests: readonly string[]): string {
  return run.replaceAll(TESTS_TOKEN, tests.map(quote).join(" "));
}

// What covers a change, for a review's proof that the tests ran (t523). The
// server holds the project's declaration and the change's measured paths but
// not the head's file list, so this reads the declared map alone: a literal
// test is named exactly, a glob entry is met by any test it matches. A list
// command is not run by the server, and a path the map lacks or an unmeasured
// change has no named cover, so the cover is the full suite, which the
// declaration's check name stands for.
export type Cover =
  | { kind: "affected"; exact: string[]; globs: string[]; why: string }
  | { kind: "full"; check: string; why: string };

// The tests an approval must show passing at its head. `changed` is the
// change's measured paths from the Ledger's evidence, never the reviewer's
// word; `files` the head's tracked files, which the review route reads from
// the repository. A declared glob stands for every file it matches at the head
// (selectByMap, the selection `atelier check` runs), so each needs its own
// result. A path the map does not cover, a declared test the head lacks, or
// files that could not be read need the full suite, named by the
// declaration's check. A project with no declaration names no test, so any
// passing result is the least an approval carries (names is null).
export interface RequiredTests { names: string[] | null; why: string; full: boolean }

export function requiredTests(affected: Pick<AffectedTests, "check" | "map"> | undefined, changed: readonly string[] | null | undefined, files: readonly string[] | null | undefined): RequiredTests {
  if (!affected) return { names: null, why: "the project declares no affected tests, so at least one passing test result is needed", full: false };
  const full = (why: string): RequiredTests => ({ names: [affected.check], why, full: true });
  const cover = coveringTests(affected, changed);
  if (cover.kind === "full") return full(cover.why);
  if (!cover.globs.length) return { names: cover.exact, why: cover.why, full: false };
  if (!files) return full("the head's files could not be read to expand the declared test globs");
  const picked = selectByMap(affected.map!, changed, files);
  return picked.kind === "full" ? full(picked.why) : { names: picked.tests, why: picked.why, full: false };
}

export function coveringTests(a: Pick<AffectedTests, "check" | "map">, changed: readonly string[] | null | undefined): Cover {
  const full = (why: string): Cover => ({ kind: "full", check: a.check, why });
  if (!Array.isArray(changed)) return full(UNMEASURED);
  if (!a.map) return full("the declaration is a list command, which the server does not run");
  const exact = new Set<string>(), globs = new Set<string>();
  for (const path of changed) {
    const entries = a.map.filter((e) => matchesAny(path, e.paths));
    if (!entries.length) return full(`${path} is in no entry of the declared map`);
    for (const e of entries) for (const t of e.tests) (/[*?[]/.test(t) ? globs : exact).add(t);
  }
  const named = [...exact, ...globs].sort();
  const n = changed.length;
  return { kind: "affected", exact: [...exact].sort(), globs: [...globs].sort(), why: `the declared map selects ${named.length ? named.join(", ") : "no test"} for ${n} changed path${n === 1 ? "" : "s"}` };
}
