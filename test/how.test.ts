import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { LIMITS, LOOP, ORCHESTRATOR, RULES, TERMS } from "../src/how-data.ts";
import { HELP_FORMS } from "../src/usage.ts";

// The How it works page states what the code does. These tests tie its
// statements to the code, so that a change which makes one untrue fails here
// instead of leaving the page wrong. They check that the named code exists and
// that the built and not-built labels match the files; they cannot check that
// a sentence still describes a function's behaviour, which is a reviewer's job.

const root = resolve(".");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const named = (symbol: string) => new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);

function sources(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(root, path)).isDirectory() ? sources(path) : /\.(ts|mjs)$/.test(name) ? [path] : [];
  });
}

test("every rule names code that exists where it says", () => {
  for (const rule of RULES) {
    assert.ok(rule.where.length > 0, `${rule.title} names no enforcing code`);
    for (const { file, symbol } of rule.where) {
      assert.ok(existsSync(join(root, file)), `${rule.title}: ${file} does not exist`);
      assert.match(read(file), named(symbol), `${rule.title}: ${symbol} is not in ${file}; update the rule or the page`);
    }
  }
});

test("each rule gives its reason in one sentence", () => {
  for (const rule of RULES) assert.equal(rule.why.split(/[.!?](?:\s|$)/).filter(Boolean).length, 1, `${rule.title}: ${rule.why}`);
});

test("a part marked built has its files and code; a part marked not built has none of them", () => {
  for (const part of ORCHESTRATOR) {
    assert.ok(part.files.length + part.code.length > 0, `${part.name} names nothing the test can check`);
    const marked = `${part.name} is marked ${part.built ? "built" : "not built yet"}`;
    for (const file of part.files) {
      assert.equal(existsSync(join(root, file)), part.built, `${marked}, but ${file} ${part.built ? "is missing" : "exists"}`);
    }
    for (const { file, symbol } of part.code) {
      const found = existsSync(join(root, file)) && named(symbol).test(read(file));
      assert.equal(found, part.built, `${marked}, but ${symbol} is ${part.built ? "not" : "now"} in ${file}`);
    }
  }
  // Every part may be built; the not-built branch above still holds for any added later.
  assert.ok(ORCHESTRATOR.some((p) => p.built));
});

// The review code in src/review runs in the Ledger and the runner (build
// steps 9 and 10); nothing else imports it. The page says the ledger's tick
// asks for reviews and the runner serves them, and no longer that the review
// code is called by nothing. The help lists atelier plan and atelier land
// exactly when the page marks each built.
test("the review code is called by the ledger and the runner, and the page says so", () => {
  const inside = join("src", "review") + sep;
  const imports = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](?:[^"']*\/)?review\//;
  // The part brief (src/plans/brief.ts) shares the verdict's finding type and
  // limits; it calls none of the review code.
  const sharesTypes = new Set([join("src", "plans", "brief.ts")]);
  const callers = [...sources("src"), ...sources("cli")].filter((file) => !file.startsWith(inside) && !sharesTypes.has(file) && imports.test(read(file)));
  assert.deepEqual([...callers].sort(), ["cli/runner.mjs", "src/ledger.ts"], "the review code should be called by the ledger and the runner alone");
  const requests = ORCHESTRATOR.find((p) => p.name === "Review requests and runner job")!;
  assert.ok(requests.built);
  assert.ok(requests.code.some((c) => c.file === "src/ledger.ts") && requests.code.some((c) => c.file === "cli/runner.mjs"), "the review requests part names the ledger and the runner as the callers");
  // The prose of the orchestrator section (src/how.ts) once said the review
  // code was pure functions that nothing called; the ledger and the runner
  // call it now, and the page must not say otherwise.
  const prose = read("src/how.ts");
  assert.doesNotMatch(prose, /nothing else calls it|nothing calls it|calls it yet|pure functions with tests/, "the orchestrator section still says the review code is uncalled");
  for (const said of ["review request", "runReview", "cli/agy-review.mjs", "routeParts", "integration branch", "atelier runner --integrate", "atelier land", "landing lease"]) {
    assert.ok(prose.includes(said), `the orchestrator section no longer says "${said}"`);
  }
  // Two claims the prose must not overstate: a home runner's offer always
  // holds build and plan (offerFrom in cli/runner.mjs adds them to whatever
  // the config lists), and only a rejection with blocking findings sends a
  // part back (reworkPart in src/ledger.ts).
  assert.match(read("cli/runner.mjs"), /\["build", "plan", \.\.\.\(config\.jobs/, "the runner no longer offers build and plan jobs by default");
  assert.ok(prose.includes("Every home runner offers build and plan jobs"), "the orchestrator section no longer says every home runner offers build and plan jobs");
  assert.match(read("src/ledger.ts"), /f\.severity === "blocking"\)\) \{\s*this\.reworkPart/, "the ledger no longer reworks a part on blocking findings alone");
  assert.ok(prose.includes("A rejection with blocking findings sends the part back"), "the orchestrator section no longer says which rejections send a part back");
  const command = ORCHESTRATOR.find((p) => p.name === "Plan routes and command")!;
  assert.equal(HELP_FORMS.some((form) => form.split(" ")[0] === "plan"), command.built, "the help and the page disagree on whether atelier plan exists");
  const land = ORCHESTRATOR.find((p) => p.name === "Landing a single task")!;
  assert.equal(HELP_FORMS.some((form) => form.split(" ")[0] === "land"), land.built, "the help and the page disagree on whether atelier land exists");
});

test("the plan flow the orchestrator section states is the code's", () => {
  const prose = read("src/how.ts");
  // The approval is refused while a part is unrouted: approvePlan in
  // src/ledger.ts throws on the unrouted routes routeParts returns.
  assert.match(read("src/ledger.ts"), /RuleError\("unrouted"/, "approvePlan no longer refuses an approval while a part is unrouted");
  assert.ok(prose.includes("the approval is refused while any part has no builder or no such reviewer"), "the orchestrator section no longer says what an unrouted part does to an approval");
  // The tick runs again after each change to a part (afterPlanChange).
  assert.match(read("src/ledger.ts"), /private afterPlanChange\(/, "the ledger no longer runs a plan's tick again after a part changes");
  assert.ok(prose.includes("after each push, check, review, submit, release, merge or abandon of a part"), "the orchestrator section no longer lists when the tick runs again");
  // The integrator submits the plan item once nothing remains to integrate:
  // runIntegrate in cli/runner.mjs, on the allIntegrated integratePart returns.
  assert.match(read("cli/runner.mjs"), /if \(result\.allIntegrated\) \{\s*await io\.cli\(\["submit", item\.id/, "the integrator no longer submits the plan item when every part has settled");
  assert.ok(prose.includes("the integrator submits the plan task"), "the orchestrator section no longer says who submits the plan task");
});

test("the page text uses no dash as punctuation, and says each step, term and rule once", () => {
  const text = [
    ...LOOP.flatMap((s) => [s.name, s.detail, s.moves, ...s.records]),
    ...TERMS.flatMap((t) => [t.term, t.meaning]),
    ...RULES.flatMap((r) => [r.title, r.enforced, r.why]),
    ...LIMITS,
    ...ORCHESTRATOR.flatMap((p) => [p.name, p.stage, p.what]),
  ];
  for (const t of text) assert.doesNotMatch(t, /\s[–—-]\s|[–—]/, t);
  for (const list of [LOOP.map((s) => s.name), TERMS.map((t) => t.term), RULES.map((r) => r.title)]) assert.equal(new Set(list).size, list.length);
});

test("each diagram label is short enough for its box at the drawn size", () => {
  for (const s of LOOP) {
    assert.ok(s.records.length <= 4, `${s.name}: more than four lines`);
    for (const line of s.records) assert.ok(line.length <= 18, `${s.name}: "${line}" is too long for a 112 unit box`);
    assert.ok(s.moves.length <= 16 && s.command.length <= 12);
  }
});
