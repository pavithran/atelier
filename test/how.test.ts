import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { LIMITS, LOOP, ORCHESTRATOR, RULES, STEPS, TAGLINE, TAKEAWAYS, TERMS, USING_WELL, USING_WELL_DOC } from "../src/how-data.ts";
import { HELP_FORMS } from "../src/usage.ts";
import { LAYERS_CAPTION, LAYERS_LABEL, PLAN_FLOW, PLAN_FLOW_CAPTION, PLAN_FLOW_LABEL, PLAN_FLOW_RETURNS, layersDiagram } from "../src/diagrams.ts";

// The How it works page states what the code does. These tests tie its
// statements to the code, so that a change which makes one untrue fails here
// instead of leaving the page wrong. They check that the named code exists and
// that the built and not-built labels match the files; they cannot check that
// a sentence still describes a function's behaviour, which is a reviewer's job.

const root = resolve(".");
// src/usage.ts assembles the help from each command's declaration, so code
// named there is looked for in src/usage/commands/ too.
const declarations = () => readdirSync(join(root, "src/usage/commands")).map((name) => readFileSync(join(root, "src/usage/commands", name), "utf8")).join("\n");
const read = (file: string) => readFileSync(join(root, file), "utf8") + (file === "src/usage.ts" ? `\n${declarations()}` : "");
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

// The five verbs of t367, the words the app, the README and the docs share.
test("the life of a task is five verbs in order, each guarded by a rule, and the README uses the same words", () => {
  assert.deepEqual(STEPS.map((s) => s.verb), ["Claim", "Fork", "Prove", "Review", "Land"]);
  for (const s of STEPS) assert.ok(RULES.some((r) => r.verb === s.verb), `no rule is listed under ${s.verb}`);
  assert.equal(TAKEAWAYS, "Proven. Reviewed. Recorded.");
  assert.equal(TAGLINE, "Git keeps the code. Atelier brings the receipts.");
  for (const t of [...STEPS.flatMap((s) => [s.line, s.about]), TAKEAWAYS, TAGLINE]) assert.doesNotMatch(t, /\s[–—-]\s|[–—]/, t);
  // Labels only: every command the steps name is still a command.
  for (const s of STEPS) for (const [, cmd] of s.about.matchAll(/`atelier ([a-z]+)/g)) assert.ok(HELP_FORMS.some((f) => f.split(" ")[0] === cmd), `${s.verb} names atelier ${cmd}, which the help does not list`);
  const readme = read("README.md");
  const enforces = readme.slice(readme.indexOf("## What Atelier enforces"), readme.indexOf("\n## ", readme.indexOf("## What Atelier enforces") + 3)).replace(/[ \n]+(?!#)/g, " ");
  assert.deepEqual([...enforces.matchAll(/^### (\w+)/gm)].map((m) => m[1]), STEPS.map((s) => s.verb), "the README's What Atelier enforces is not headed by the five verbs");
  for (const s of STEPS) assert.ok(enforces.includes(s.line), `the README does not give ${s.verb}'s line, "${s.line}"`);
  assert.ok(enforces.includes(TAKEAWAYS) && enforces.includes(TAGLINE), "the README's summary does not give the takeaways and the tagline");
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
  // limits, and the CLI reads the reply limit alone, to cut what it keeps of
  // an unparsable reply (t407); neither calls any of the review code.
  const sharesTypes = new Set([join("src", "plans", "brief.ts"), join("cli", "commands", "review-unparsable.mjs")]);
  // The landing's triage before the review (t475) lives in src/review/triage.ts
  // and is not review code: the landing, the landing Workflow that checks its
  // binding and the init route that records the project's triage model
  // import it, and nothing else from src/review.
  const triageOnly = (file: string) => [join("cli", "land.mjs"), join("src", "landing-workflow.ts"), join("src", "index.ts")].includes(file)
    && [...read(file).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["'](?:[^"']*\/)?review\/([^"']+)["']/g)].every((m) => m[1] === "triage.ts");
  // The harness adapter (cli/harness/adapter.mjs), which the runner starts
  // for a review, reads the reply with the runner's own verdict parser only
  // to tell whether it states a verdict, and asks once more when it does not
  // (t576); it imports src/review/verdict.ts and nothing else from src/review.
  const verdictCheckOnly = (file: string) => file === join("cli", "harness", "adapter.mjs")
    && [...read(file).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["'](?:[^"']*\/)?review\/([^"']+)["']/g)].every((m) => m[1] === "verdict.ts");
  const callers = [...sources("src"), ...sources("cli")].filter((file) => !file.startsWith(inside) && !sharesTypes.has(file) && !triageOnly(file) && !verdictCheckOnly(file) && imports.test(read(file)));
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
  // Two claims the prose must not overstate: a home runner's offer takes its
  // jobs from its config (offerFrom in cli/runner.mjs), which by default
  // (DEFAULT_JOBS in cli/runner-config.mjs) holds build and plan with the
  // merge jobs a merge-main or merge-plan build needs, and only a rejection
  // with blocking findings sends a part back (reworkPart in src/ledger.ts).
  assert.match(read("cli/runner.mjs"), /jobs: \[\.\.\.\(jobs \?\? DEFAULT_JOBS\)\]/, "the runner no longer takes its offer's jobs from its config");
  assert.match(read("cli/runner-config.mjs"), /DEFAULT_JOBS = \["build", "plan", "merge-main", "merge-main-task", "merge-plan"\]/, "the runner's default jobs no longer hold build and plan");
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
    ...USING_WELL.map((a) => a.point),
  ];
  for (const t of text) assert.doesNotMatch(t, /\s[–—-]\s|[–—]/, t);
  for (const list of [LOOP.map((s) => s.name), TERMS.map((t) => t.term), RULES.map((r) => r.title)]) assert.equal(new Set(list).size, list.length);
});

// The plan flow on /how (src/diagrams.ts) draws steps the code takes. Each
// claim it makes is tied here to the code that makes it true.
test("the plan flow draws what the code does, from goal to merge", () => {
  const steps = PLAN_FLOW.map((s) => `${s.name}: ${s.sub.join(" ")}`);
  const says = (name: string, text: string) => assert.ok(steps.find((s) => s.startsWith(`${name}:`))?.includes(text), `the plan flow's ${name} step no longer says "${text}"`);
  const runner = read("cli/runner.mjs"), ledger = read("src/ledger.ts");
  // A plan job on a home runner: runPlanTask posts the plan document.
  assert.ok(HELP_FORMS.some((form) => form.startsWith("plan ")), "atelier plan is gone from the help");
  says("Plan", "home runner takes the plan job");
  assert.match(runner, /export async function runPlanTask\(/);
  assert.match(read("cli/runner-config.mjs"), /DEFAULT_JOBS = \["build", "plan",/, "a home runner no longer offers plan jobs");
  // Approval by hash, then routing to a builder, alternates and a reviewer of another family.
  says("Approve the plan", "by the hash");
  assert.match(read("src/plans/route.ts"), /export function routeParts\(/);
  says("Route the parts", "routeParts names a builder, two alternates");
  // Dispatch once dependencies land, two live at a time.
  const phase = read("src/plans/phase.ts");
  assert.match(phase, /input\.maxParallel \?\? 2/, "the tick no longer keeps two parts live by default");
  assert.match(phase, /part\.dependsOn\.every\(\(dep\) => settled\(states\.get\(dep\)\)\)/, "the tick no longer waits for a part's dependencies");
  says("Dispatch build jobs", "two parts live at a time");
  // A review request once the checks pass and the paths are measured; a review job serves it.
  assert.match(read("src/review/needed.ts"), /every required check is observed passing at its\s*\/\/ head, its changed paths are measured/);
  assert.match(runner, /export async function runReview\(/);
  says("Review", "runReview");
  // Rework on blocking findings, and on a failed integration.
  assert.match(ledger, /f\.severity === "blocking"\)\) \{\s*this\.reworkPart/);
  assert.match(phase, /case "review\.rework":/);
  assert.match(phase, /case "integration\.failed":/);
  assert.match(PLAN_FLOW_RETURNS.rework, /blocking findings/);
  // The integrator merges, runs the plan's checks, rolls back on failure and submits the plan.
  assert.match(runner, /export async function runIntegrate\(/);
  assert.match(runner, /merges it onto the\s*\/\/ plan's branch with --no-ff, pushes[\s\S]{0,120}runs the plan's checks/);
  assert.match(runner, /rolls the branch back|is rolled back to its previous head/);
  assert.match(runner, /if \(result\.allIntegrated\) \{\s*await io\.cli\(\["submit", item\.id/);
  says("Integrate", "atelier runner --integrate");
  says("Submit the plan", "once every part is integrated");
  // An integrated part has landed for the parts that depend on it.
  assert.match(read("src/plans/integrate.ts"), /export const LANDED: readonly PartState\[\] = \["integrated", "merged"\]/);
  assert.equal(PLAN_FLOW[0].lane, "owner");
  assert.equal(PLAN_FLOW.at(-1)!.name, "Accept and merge");
  assert.equal(PLAN_FLOW.filter((s) => s.lane === "owner").length, 3, "the owner acts three times, as the caption says");
  assert.match(PLAN_FLOW_CAPTION, /The developer acts three times/);
});

test("the plan flow's text fits its boxes and lanes at the drawn size", () => {
  for (const s of PLAN_FLOW) {
    assert.ok(s.name.length <= 24, `"${s.name}" is too long for its box`);
    for (const line of s.sub) assert.ok(line.length <= 44, `${s.name}: "${line}" is too long for a 272 unit box`);
  }
  for (const note of Object.values(PLAN_FLOW_RETURNS)) assert.ok(note.length <= 50, `"${note}" is too long for its lane`);
  for (const t of [PLAN_FLOW_LABEL, PLAN_FLOW_CAPTION, ...Object.values(PLAN_FLOW_RETURNS), ...PLAN_FLOW.flatMap((s) => [s.name, ...s.sub])]) {
    assert.doesNotMatch(t, /\s[–—-]\s|[–—]/, t);
  }
});

// The layers diagram shows a goal entering as a plan and names the jobs a
// home runner takes, and those are the jobs the runner offers by default:
// build and plan with the merge jobs such a build needs (DEFAULT_JOBS in
// cli/runner-config.mjs; a config's jobs names exactly the jobs it takes
// instead), review when the config lists it, and integrate, refresh and the
// task refresh (t462) for a runner started with --integrate.
test("the layers diagram shows a goal entering as a plan and the runner's jobs", () => {
  const runner = read("cli/runner.mjs");
  assert.match(runner, /jobs: \[\.\.\.\(jobs \?\? DEFAULT_JOBS\)\]/);
  assert.match(read("cli/runner-config.mjs"), /DEFAULT_JOBS = \["build", "plan", "merge-main", "merge-main-task", "merge-plan"\]/);
  assert.match(runner, /dispatch carrying job: "plan"[\s\S]{0,80}carrying "review"/);
  assert.match(runner, /jobs: \["integrate", "refresh", "task-refresh"\]/);
  for (const t of [LAYERS_LABEL, LAYERS_CAPTION]) {
    assert.match(t, /atelier plan "goal"/, t);
    assert.match(t, /build, plan and review jobs|build and plan jobs, and review jobs/, t);
  }
  assert.match(LAYERS_LABEL, /Ledger[^.]*holds each plan and dispatches its parts/);
  assert.match(LAYERS_CAPTION, /--integrate[^.]*integrate and refresh jobs/);
  const svg = layersDiagram();
  assert.ok(svg.includes(">developer: atelier plan &quot;goal&quot;</text>"), "the terminal node shows the goal entering as a plan");
  assert.ok(svg.includes(">build, plan and review jobs</text>"), "the home runner node names its jobs");
  assert.ok(svg.includes(">holds each plan and dispatches its parts and jobs</text>"), "the Ledger node holds the plan");
  for (const t of [LAYERS_LABEL, LAYERS_CAPTION]) assert.doesNotMatch(t, /\s[–—-]\s|[–—]/, t);
});

// The Using Atelier well section restates the owner's guide. Each point
// carries a phrase that must stand in the point and in the guide, so a
// rewrite of either that drops it fails here instead of leaving the page
// saying something the guide no longer does.
test("each point of Using Atelier well names something in docs/using-atelier.md", () => {
  assert.equal(USING_WELL_DOC, "docs/using-atelier.md");
  assert.ok(existsSync(join(root, USING_WELL_DOC)), `${USING_WELL_DOC} does not exist`);
  const guide = read(USING_WELL_DOC);
  assert.ok(USING_WELL.length >= 3, "the section has too few points to be a guide");
  for (const { point, from } of USING_WELL) {
    assert.ok(from.trim().length >= 8, `"${from}" is too short to tie a point to the guide`);
    assert.ok(point.includes(from), `the point "${point.slice(0, 40)}…" does not say "${from}"`);
    assert.ok(guide.includes(from), `"${from}" is not in ${USING_WELL_DOC}; the point has drifted from the guide`);
  }
  // Fewer words than the guide: each point is a few sentences, not a copy of a section.
  for (const { point } of USING_WELL) assert.ok(point.length <= 400, `a point is too long to be a summary: ${point.slice(0, 40)}…`);
  const froms = USING_WELL.map((a) => a.from);
  assert.equal(new Set(froms).size, froms.length, "two points lean on the same phrase");
});

test("each diagram label is short enough for its box at the drawn size", () => {
  for (const s of LOOP) {
    assert.ok(s.records.length <= 4, `${s.name}: more than four lines`);
    for (const line of s.records) assert.ok(line.length <= 18, `${s.name}: "${line}" is too long for a 112 unit box`);
    assert.ok(s.moves.length <= 16 && s.command.length <= 12);
  }
});

// t473: only claimed items and the item a live landing lease names hold core
// files. Nothing the owner or an agent reads may still say a submitted or
// accepted item holds them, or that a hold lasts until the item merges.
test("the How page, help and docs state the current core-file hold rule", () => {
  const texts: [string, string][] = [
    ...RULES.map((r): [string, string] => [`rule ${r.title}`, `${r.enforced} ${r.why}`]),
    ...LOOP.map((s): [string, string] => [`loop ${s.title}`, JSON.stringify(s)]),
    ["src/usage commands", declarations()],
    ["src/usage.ts", readFileSync(join(root, "src/usage.ts"), "utf8")],
    ...["docs/orchestrator.md", "docs/orchestrating.md", "README.md"].map((f): [string, string] => [f, readFileSync(join(root, f), "utf8")]),
  ];
  const stale = [/live item(?:'s)? \(claimed, submitted or accepted/, /live task's in a core file/,/one claimed, submitted or accepted/, /a submitted or accepted plan item does/, /(?:merges|merged) or is abandoned/, /until (?:that|the live) item merges/];
  for (const [where, text] of texts) {
    const flat = text.replace(/\s+/g, " ");
    for (const old of stale) assert.doesNotMatch(flat, old, `${where} still states the old core-file hold rule`);
  }
  const core = RULES.find((r) => r.title === "Core files are built one change at a time")!;
  assert.match(core.enforced, /claimed item or of the item named by a live landing lease/);
  assert.match(core.enforced, /submitted or accepted item that is not landing holds nothing/);
  assert.match(core.enforced, /once each claimed blocker submits or is released and each landing ends/);
});
