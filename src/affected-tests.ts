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
export function selectByMap(map: readonly AffectedMapEntry[], changed: readonly string[] | null, files: readonly string[]): Selection {
  if (changed === null) return { kind: "full", why: "the changed paths could not be measured" };
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

const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

// The command that runs the selected tests.
export function affectedCommand(run: string, tests: readonly string[]): string {
  return run.replaceAll(TESTS_TOKEN, tests.map(quote).join(" "));
}
