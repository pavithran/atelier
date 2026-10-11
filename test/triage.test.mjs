import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ROUTE_LEVEL } from "../src/route-level.ts";
import { criteriaOf } from "../src/criteria.ts";
import {
  decideTriage, parseTriage, recordedTriage, resolveTriage, sameBinding, triageBrief, triageCriteria, triageFormat, triageModelRefusal, triageRecord, triageSettingRefusal, triageStandsRefusal,
} from "../src/review/triage.ts";

// Triage before the review (t475), against runLand with injected fakes and a
// deterministic triage harness in place of a model: only every criterion met
// goes on to the submission and the review request; a criterion not met or
// unsure, no criteria, a malformed reply, a harness that fails or never
// answers, and a model the pool refuses each stop the landing before the
// task is submitted, with the findings and the command to run again, the
// lease released and nothing asked of a reviewer. The owner's bypass and
// override are recorded, with the head and the criteria binding, before the
// landing goes on, and a record the server refuses stops it. Triage results
// are bound to the head, its merge base and the criteria, and run again when
// the criteria change. Triage is recorded as land.triage steps and never
// through a review route, and once it passes or is bypassed the review rules
// run as they did: no review needed, an existing approval, --no-review.

// The Workflow executor polls its stage every ATELIER_LAND_POLL_MS, read when
// cli/land.mjs loads; node --test runs this file in a process of its own. A
// landing that fails ends by throwing here, where the command would exit,
// so its signal handlers stay behind; they are many, and harmless.
process.env.ATELIER_LAND_POLL_MS = "5";
process.setMaxListeners(100);
const { runLand } = await import("../cli/land.mjs");

const HEAD = "a".repeat(40), BASE = "b".repeat(40);
const CRITERIA = ["The widget renders", "The route answers 200"];
const met = (n, extra = {}) => ({ criterion: n, status: "met", evidence: `criterion ${n} holds`, file: "src/widget.ts", line: 10 + n, ...extra });
const reply = (entries, unverified = []) => `Some prose first.\n\n${JSON.stringify({ triage: entries, unverified })}\n`;
const allMet = (count = CRITERIA.length) => reply(Array.from({ length: count }, (_, i) => met(i + 1)));
const POOL = [
  { id: "opus-5.5", harness: "claude-code", where: "cloud", provider: "subscription", aliases: [], family: "anthropic", note: "", addedBy: "owner", addedAt: "2026-10-01T00:00:00Z" },
  { id: "gpt-6-astra", harness: "codex", where: "cloud", provider: "subscription", aliases: [], family: "openai", note: "", addedBy: "owner", addedAt: "2026-10-01T00:00:00Z" },
  { id: "glm-9", harness: "opencode", where: "cloud", provider: "openrouter", aliases: [], family: "zai", note: "", addedBy: "owner", addedAt: "2026-10-01T00:00:00Z" },
  { id: "sonnet-5.5", harness: "claude-code", where: "cloud", provider: "subscription", aliases: [], family: "anthropic", note: "", addedBy: "owner", addedAt: "2026-10-01T00:00:00Z", status: { state: "refused", by: "home:mbp", at: "2026-10-02T00:00:00Z" } },
];

// One landing of t1 in proj, built by claude-code/opus-5.5. `answers` are
// the triage harness's replies in turn: a string is the model's reply, an
// Error is a harness that fails, "hang" one that never answers. `criteria`
// is the task's list, or a function of how many times the item has been
// read, for criteria that change while the landing runs. `landFails` refuses
// a land step for which it answers true, as the server refuses a record.
function landing(t, { args = {}, answers = [allMet()], criteria = CRITERIA, events = [], review = { needed: false, reason: "a direct change needs no review" }, landFails = () => false, pool = POOL, policy = { checks: [] }, project = {}, workflow = false } = {}) {
  const scratch = resolve(".scratch"); mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "triage-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", dir]);
  const config = { "atelier.project": "proj", "atelier.item": "t1", "atelier.actor": "claude-code/opus-5.5", "atelier.write-token-expires-at": new Date(Date.now() + 6 * 3600_000).toISOString() };
  const itemPath = "/projects/proj/items/t1", leasePath = "/projects/proj/landing-lease", wfPath = `${itemPath}/landing-workflow`;
  const log = [], lines = [], asked = [], recorded = [...events];
  let reads = 0, state = "claimed", requestedAt = null;
  const accept = () => (typeof criteria === "function" ? criteria(reads) : criteria);
  const item = () => ({ id: "t1", title: "Widget", brief: "Render the widget.", state, owner: "claude-code/opus-5.5", head: HEAD, accept: accept(), scope: [] });
  const request = async (method, path, body) => {
    log.push({ method, path, body });
    if (path === "/version") return { routeLevel: ROUTE_LEVEL, commit: "c0ffee" };
    if (path === "/models") return pool;
    if (path === leasePath && method === "GET") return { lease: null, waiting: [] };
    if (path === leasePath) return body.cancel ? {} : { item: { id: "t1", state } };
    if (path === itemPath) {
      reads++;
      const reviews = requestedAt && review.approveBy ? [{ head: HEAD, by: review.approveBy, approve: true, at: new Date(Date.parse(requestedAt) + 1000).toISOString() }] : [];
      return { item: item(), policy, events: recorded, reviews };
    }
    if (path === `${itemPath}/base-token`) return { remote: "https://base.invalid/main.git", token: "read", defaultBranch: "main" };
    if (path === `${itemPath}/land`) {
      if (landFails(body)) throw Object.assign(new Error("not_project_owner: only the project owner records a landing's steps"), { status: 403 });
      recorded.push({ kind: `land.${body.step}`, seq: recorded.length + 1, data: body });
      return { item: item() };
    }
    if (path === `${itemPath}/review-request`) {
      requestedAt = new Date().toISOString();
      return review.needed ? { needed: true, requested: true, head: HEAD, at: requestedAt, reviewer: review.approveBy, reason: "a protected change needs an independent review" } : { needed: false, reason: review.reason };
    }
    if (path === wfPath) {
      if (method === "GET") return log.some((c) => c.method === "POST" && c.path === wfPath && c.body?.event?.type === "workspace" && c.body.event.payload.head)
        ? { instance: "w1", stage: "done", round: 0, status: { status: "complete" } }
        : log.some((c) => c.method === "POST" && c.path === wfPath && !c.body?.event) ? { instance: "w1", stage: "workspace", round: 0, status: { status: "waiting" } } : { instance: null, status: null };
      return body?.event ? {} : { instance: "w1", created: true, checks: "local", stage: "lease" };
    }
    return {};
  };
  const fakeGit = (a, o = {}) => {
    let out = "";
    if (a[0] === "config") out = config[a.at(-1)] ?? null;
    else if (a[0] === "rev-parse") out = HEAD;
    else if (a[0] === "merge-base" && a[1] !== "--is-ancestor") out = BASE;
    else if (a[0] === "diff" && a.includes("--name-only")) out = "src/widget.ts\0";
    else if (a[0] === "diff") out = "diff --git a/src/widget.ts b/src/widget.ts\n+widget\n";
    if (o.allowFail) return { status: out === null ? 1 : 0, stdout: out ?? "", stderr: "" };
    return out ?? "";
  };
  const runCommand = async (argv) => {
    log.push({ command: argv[2] });
    if (argv[2] === "submit") state = "submitted";
    if (argv[2] === "accept") state = "accepted";
    return { passed: true, status: 0, output: "ok\n", durationMs: 1 };
  };
  const queue = [...answers];
  const triage = async (ask) => {
    asked.push(ask);
    log.push({ triage: ask.actor });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === "hang") return new Promise(() => {});
    if (next instanceof Error) throw next;
    return { reply: next };
  };
  const io = {
    args: { _: ["land", "t1"], ...(workflow ? { workflow: true } : {}), ...args }, name: "proj", id: "t1", p: { path: dir, branch: "main", ...project },
    request, git: fakeGit, print: (line) => lines.push(line), die: (message) => { throw new Error(message); },
    workspacePath: () => dir, atelier: "atelier.mjs", env: {}, redact: (text) => text, secrets: () => [], runCommand,
    adoptWorkspaceToken: () => {}, triage, triageTimeoutMs: 200,
  };
  const at = (pred) => log.findIndex(pred);
  return {
    io, log, lines, asked, recorded,
    commands: () => log.filter((c) => c.command).map((c) => c.command),
    triages: () => recorded.filter((e) => e.kind === "land.triage").map((e) => e.data),
    reviewAsked: () => log.some((c) => c.path === `${itemPath}/review-request`),
    released: () => log.some((c) => c.path === leasePath && c.body?.cancel === true),
    at, output: () => lines.join("\n"),
    reviewRouteTouched: () => log.some((c) => typeof c.path === "string" && /\/(review|reviews|review-claim|approve|reject)(\/|$)/.test(c.path)),
  };
}

// ── the pure parts ──────────────────────────────────────────────────────────

test("triage resolves --triage first, then the project's setting, and neither is no triage; conflicting flags are refused (t475)", () => {
  assert.deepEqual(resolveTriage({ triage: "codex/gpt-6-astra", project: "claude-code/opus-5.5" }), { mode: "model", actor: "codex/gpt-6-astra", source: "--triage", override: null });
  assert.deepEqual(resolveTriage({ project: "claude-code/opus-5.5" }), { mode: "model", actor: "claude-code/opus-5.5", source: "project.triage", override: null });
  assert.deepEqual(resolveTriage({}), { mode: "off" });
  assert.deepEqual(resolveTriage({ project: null }), { mode: "off" });
  assert.deepEqual(resolveTriage({ project: "codex/gpt-6-astra", noTriage: "  hotfix,  owner says  " }), { mode: "bypass", reason: "hotfix, owner says" });
  assert.equal(resolveTriage({ project: "codex/gpt-6-astra", override: "known flake" }).override, "known flake");
  const refused = (input, pattern) => assert.match(resolveTriage(input).error ?? "", pattern);
  refused({ triage: "codex/gpt-6-astra", noTriage: "why" }, /--triage and --no-triage together say two things/);
  refused({ project: "codex/gpt-6-astra", noTriage: "why", override: "why" }, /--no-triage and --override-triage together/);
  refused({ triage: "gpt-6-astra" }, /--triage needs harness\/model/);
  refused({ triage: true }, /--triage needs harness\/model/);
  refused({ project: "codex/gpt-6-astra", noTriage: true }, /--no-triage needs the reason/);
  refused({ project: "codex/gpt-6-astra", noTriage: "   " }, /--no-triage needs the reason/);
  refused({ project: "codex/gpt-6-astra", override: true }, /--override-triage needs the reason/);
  refused({ noTriage: "why" }, /this landing has none/);
  refused({ override: "why" }, /this landing has none/);
  refused({ project: 7 }, /project's triage setting must be harness\/model/);
  refused({ triage: "cursor/some-model" }, /ships adapters for claude-code, codex, opencode, antigravity only/);
});

test("the triage model follows the pool's access and cost rules, and a model of the builder's own company may triage (t475)", () => {
  // claude-code/opus-5.5 built t1; the same company triaging is allowed.
  assert.equal(triageModelRefusal("claude-code/opus-5.5", POOL), null);
  assert.equal(triageModelRefusal("CODEX/GPT-6-ASTRA", POOL), null);
  assert.match(triageModelRefusal("codex/gpt-7", POOL), /not in the model pool/);
  assert.match(triageModelRefusal("claude-code/sonnet-5.5", POOL), /status is refused, reported by home:mbp/);
  assert.match(triageModelRefusal("opencode/glm-9", POOL), /paid per token \(openrouter\)/);
});

test("a triage reply gives each criterion met, not-met or unsure with evidence and a location or a reason none applies (t475)", () => {
  const ok = parseTriage(reply([met(1), { criterion: 2, status: "Not met", evidence: "the route answers 500", noLocation: "the route is deployed config, not code" }], ["the Workers CPU limit"]), 2);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.results.map((r) => [r.n, r.status, r.file, r.line, r.noLocation]), [[1, "met", "src/widget.ts", 11, null], [2, "not-met", null, null, "the route is deployed config, not code"]]);
  assert.deepEqual(ok.unverified, ["the Workers CPU limit"]);
  assert.deepEqual(decideTriage(ok.results), { proceed: false, notMet: [2], unsure: [] });
  assert.equal(decideTriage(parseTriage(allMet(), 2).results).proceed, true);
  assert.deepEqual(decideTriage(parseTriage(reply([met(1), met(2, { status: "unsure" })]), 2).results), { proceed: false, notMet: [], unsure: [2] });
  assert.equal(decideTriage([]).proceed, false);

  const malformed = (text, pattern, count = 2) => { const r = parseTriage(text, count); assert.equal(r.ok, false, text); assert.match(r.error, pattern); };
  malformed("VERDICT: APPROVE\nAll good.", /no JSON object with a "triage" list/);
  malformed(reply([met(1)]), /criterion 2 has no triage entry/);
  malformed(reply([met(1), met(1), met(2)]), /criterion 1 is triaged more than once/);
  malformed(reply([met(1), met(3)]), /"criterion" must be a number from 1 to 2/);
  malformed(reply([met(1), met(2, { status: "probably" })]), /"status" must be met, not-met or unsure/);
  malformed(reply([met(1), met(2, { evidence: "  " })]), /criterion 2\) gives no evidence/);
  malformed(reply([met(1), met(2, { file: undefined, line: undefined })]), /neither a file nor noLocation/);
  malformed(reply([met(1), met(2, { file: undefined, noLocation: "n/a" })]), /gives a line without a file/);
  malformed(reply([met(1), met(2, { line: 0 })]), /"line" must be a positive whole number/);
  malformed(JSON.stringify({ triage: [met(1), met(2)] }), /"unverified" must be a list/);
  malformed(`${allMet()}\n${reply([met(1), met(2, { status: "unsure" })])}`, /2 triage objects that differ/);
  malformed(JSON.stringify({ triage: "all met", unverified: [] }), /"triage" must be a list/);
  malformed(42, /not text/);
  malformed("x".repeat(200_001), /over the 200000/);
  // The same object twice, as a model echoing its answer, reads as one.
  assert.equal(parseTriage(`${allMet()}\n${allMet()}`, 2).ok, true);
});

test("the triage brief binds the head, the merge base and the criteria, numbers a part's criteria after the task's, and asks for traced request paths and unverified runtime behaviour (t475)", () => {
  const binding = { head: HEAD, base: BASE, criteria: criteriaOf({ accept: CRITERIA, partAccept: ["The plan's own"] }) };
  const text = triageBrief({ project: "proj", id: "t1", title: "Widget", brief: "Render the widget.", task: CRITERIA, part: ["The plan's own"], binding, target: "main", changedPaths: ["src/widget.ts"] });
  assert.match(text, new RegExp(`Head: ${HEAD}`));
  assert.match(text, new RegExp(`Merge base with main: ${BASE}`));
  assert.match(text, new RegExp(`Criteria binding: ${binding.criteria}`));
  assert.match(text, /1\. The widget renders\n2\. The route answers 200\n3\. The plan's own \(the plan's criterion for this part\)/);
  assert.match(text, /Trace each relevant production request path end to end/);
  assert.match(text, /could not verify here .* in unverified/);
  assert.match(text, /exactly one entry for each of the 3 criteria/);
  assert.equal(triageFormat(3), text.slice(text.indexOf("End your reply with one JSON object")));
  assert.deepEqual(triageCriteria(CRITERIA, null), CRITERIA);
});

test("a triage result is bound to its head, merge base and criteria, and a recorded pass stands only for that binding and model (t475)", () => {
  const binding = { head: HEAD, base: BASE, criteria: criteriaOf({ accept: CRITERIA }) };
  assert.ok(sameBinding(binding, { ...binding }));
  for (const moved of [{ head: "c".repeat(40) }, { base: "c".repeat(40) }, { criteria: criteriaOf({ accept: ["Other"] }) }]) assert.ok(!sameBinding(binding, { ...binding, ...moved }));
  const events = [{ kind: "land.triage", seq: 3, data: triageRecord(binding, "passed", { triager: "codex/gpt-6-astra" }) }, { kind: "review.approved", seq: 4, data: { ...binding, outcome: "passed" } }];
  assert.equal(recordedTriage(events, binding, "passed", "codex/gpt-6-astra")?.seq, 3);
  assert.equal(recordedTriage(events, binding, "passed", "claude-code/opus-5.5"), null);
  assert.equal(recordedTriage(events, { ...binding, head: "c".repeat(40) }, "passed", "codex/gpt-6-astra"), null);
  assert.equal(recordedTriage(events, binding, "stopped"), null);
});

// ── the plain landing ───────────────────────────────────────────────────────

test("plain land with every criterion met triages after the push and checks, records the pass, then submits and asks for the review (t475)", async (t) => {
  const l = landing(t, { args: { triage: "codex/gpt-6-astra" }, review: { needed: true, approveBy: "antigravity/gemini-3.1-pro" } });
  await runLand(l.io);
  assert.deepEqual(l.commands(), ["push", "check", "submit", "accept", "merge"]);
  const triagedAt = l.at((c) => c.triage), submitAt = l.at((c) => c.command === "submit"), reviewAt = l.at((c) => c.path?.endsWith("/review-request"));
  assert.ok(l.at((c) => c.command === "check") < triagedAt && triagedAt < submitAt && submitAt < reviewAt, "check, triage, submit, review request, in that order");
  assert.equal(l.asked.length, 1);
  assert.equal(l.asked[0].harness, "codex");
  assert.equal(l.asked[0].model, "gpt-6-astra");
  assert.match(l.asked[0].brief, new RegExp(`Head: ${HEAD}`));
  assert.match(l.asked[0].brief, new RegExp(`Merge base with main: ${BASE}`));
  assert.match(l.asked[0].diff, /\+widget/);
  assert.deepEqual(l.triages(), [{ step: "triage", ms: l.triages()[0].ms, head: HEAD, base: BASE, criteria: criteriaOf({ accept: CRITERIA }), outcome: "passed", triager: "codex/gpt-6-astra", statuses: ["1:met", "2:met"] }]);
  assert.match(l.output(), /Triage by codex\/gpt-6-astra: every one of the 2 criteria are met/);
  // The existing review rules run after it: the gate's review is asked for and its approval lands the task.
  assert.match(l.output(), /antigravity\/gemini-3\.1-pro approved t1/);
  assert.ok(!l.reviewRouteTouched(), "triage is recorded as a land step, never through a review route");
});

test("the project's triage setting is used when no --triage is given, and a model of the builder's own company may triage (t475)", async (t) => {
  const l = landing(t, { args: { "no-review": true }, project: { triage: "claude-code/opus-5.5" } });
  await runLand(l.io);
  assert.equal(l.asked[0].actor, "claude-code/opus-5.5");
  assert.deepEqual(l.commands(), ["push", "check", "submit"]);
  assert.match(l.output(), /left for you to settle the review by hand \(--no-review\)/);
});

test("with neither --triage nor a project setting no triage runs and the landing goes on as before (t475)", async (t) => {
  const l = landing(t, { args: { "no-review": true } });
  await runLand(l.io);
  assert.equal(l.asked.length, 0);
  assert.deepEqual(l.triages(), []);
  assert.deepEqual(l.commands(), ["push", "check", "submit"]);
});

for (const [what, answers, pattern] of [
  ["a criterion not met", [reply([met(1), { criterion: 2, status: "not-met", evidence: "the route answers 500", file: "src/route.ts", line: 4 }])], /criterion 2 not met/],
  ["an unsure criterion", [reply([met(1), { criterion: 2, status: "unsure", evidence: "depends on the deployed limit", noLocation: "a platform limit" }], ["the deployed request limit"])], /unsure of criterion 2/],
  ["a malformed reply", ["VERDICT: APPROVE\nSUMMARY: fine."], /reply could not be read: the reply has no JSON object/],
  ["a reply missing a criterion", [reply([met(1)])], /reply could not be read: criterion 2 has no triage entry/],
  ["a harness that fails", [new Error("could not run codex: ENOENT")], /triage is unavailable: codex\/gpt-6-astra could not be run \(could not run codex: ENOENT\)/],
  ["a harness that never answers", ["hang"], /triage timed out: codex\/gpt-6-astra gave no answer within 200 ms/],
]) {
  test(`plain land stops before the review request on ${what}, shows the findings and the retry, releases the lease and leaves the task claimed (t475)`, async (t) => {
    const l = landing(t, { args: { triage: "codex/gpt-6-astra" }, answers });
    await assert.rejects(runLand(l.io), (error) => {
      assert.match(error.message, pattern);
      assert.match(error.message, /The landing stops before the review request: nothing was submitted for review, the merged head stays pushed to t1's fork, and t1 stays with its holder/);
      assert.match(error.message, /run atelier land t1 --triage codex\/gpt-6-astra again/);
      assert.match(error.message, /--override-triage "REASON"/);
      return true;
    });
    assert.deepEqual(l.commands(), ["push", "check"], "nothing submitted");
    assert.equal(l.reviewAsked(), false, "no review request");
    assert.ok(l.released(), "the lease is released");
    assert.deepEqual(l.triages().map((d) => [d.outcome, d.head, d.base, d.triager]), [["stopped", HEAD, BASE, "codex/gpt-6-astra"]]);
  });
}

test("a stopped triage shows each criterion's status, evidence and location, and the runtime behaviour it could not verify (t475)", async (t) => {
  const l = landing(t, { args: { triage: "codex/gpt-6-astra" }, answers: [reply([met(1), { criterion: 2, status: "unsure", evidence: "depends on the deployed limit", noLocation: "a platform limit" }], ["the deployed request limit"])] });
  await assert.rejects(runLand(l.io), (error) => {
    assert.match(error.message, /1\. met — The widget renders\n {5}criterion 1 holds \(src\/widget\.ts:11\)/);
    assert.match(error.message, /2\. unsure — The route answers 200\n {5}depends on the deployed limit \(no location: a platform limit\)/);
    assert.match(error.message, /could not verify: the deployed request limit/);
    return true;
  });
  assert.deepEqual(l.triages()[0].statuses, ["1:met", "2:unsure"]);
});

test("a triage model the pool refuses, or a task with no criteria, stops before any model is called, saying why (t475)", async (t) => {
  for (const [args, extra, pattern] of [
    [{ triage: "codex/gpt-7" }, {}, /triage is unavailable: codex\/gpt-7 is not in the model pool/],
    [{ triage: "opencode/glm-9" }, {}, /paid per token/],
    [{ triage: "claude-code/sonnet-5.5" }, {}, /status is refused/],
    [{ triage: "codex/gpt-6-astra" }, { criteria: [] }, /t1 has no acceptance criteria \(its list is empty\), so the triage has nothing to judge/],
  ]) {
    const l = landing(t, { args, ...extra });
    await assert.rejects(runLand(l.io), pattern);
    assert.equal(l.asked.length, 0, `${args.triage}: no model is called`);
    assert.deepEqual(l.commands(), ["push", "check"]);
    assert.equal(l.reviewAsked(), false);
  }
});

test("criteria that change while the model triages are triaged again before the submission, and a change after the submission stops before the review request, saying the task is submitted (t475)", async (t) => {
  // The item is read once as the landing starts (the post-merge resume
  // check, t477), then before the triage, after it (changed: triage again),
  // before the second, after it, and so on.
  const during = landing(t, { args: { triage: "codex/gpt-6-astra", "no-review": true }, criteria: (reads) => (reads < 4 ? CRITERIA : [...CRITERIA, "A third"]), answers: [allMet(2), allMet(3)] });
  await runLand(during.io);
  assert.equal(during.asked.length, 2);
  assert.match(during.asked[1].brief, /3\. A third/);
  assert.match(during.output(), /acceptance criteria changed since the triage .*triaging again/);
  assert.deepEqual(during.triages().map((d) => [d.outcome, d.criteria]), [["passed", criteriaOf({ accept: [...CRITERIA, "A third"] })]]);
  assert.deepEqual(during.commands(), ["push", "check", "submit"]);

  // Criteria changed after the triage answered and was confirmed, just
  // before the submission: the re-check there triages again, still with
  // nothing submitted.
  let confirmed = 0;
  const before = landing(t, { args: { triage: "codex/gpt-6-astra", "no-review": true }, answers: [allMet(2), allMet(3)] });
  const read = before.io.request;
  before.io.request = async (method, path, body) => {
    const r = await read(method, path, body);
    // The first read after the model answers confirms the criteria; the
    // next, just before the submission, finds a third, and it stays.
    if (path === "/projects/proj/items/t1" && before.asked.length >= 1 && (before.asked.length > 1 || ++confirmed >= 2)) r.item.accept = [...CRITERIA, "A third"];
    return r;
  };
  await runLand(before.io);
  assert.equal(before.asked.length, 2);
  assert.ok(before.at((c) => c.triage) < before.log.findLastIndex((c) => c.triage) && before.log.findLastIndex((c) => c.triage) < before.at((c) => c.command === "submit"), "both triages come before the submission");
  assert.deepEqual(before.triages().map((d) => d.outcome), ["passed", "passed"]);
  assert.equal(before.triages()[1].criteria, criteriaOf({ accept: [...CRITERIA, "A third"] }));

  // Criteria changed once the task was submitted: no model is asked again
  // and no review is asked for; the stop says the task is submitted.
  let submitted = false;
  const after = landing(t, { args: { triage: "codex/gpt-6-astra" }, criteria: () => (submitted ? [...CRITERIA, "A third"] : CRITERIA), answers: [allMet(2), allMet(3)] });
  const run = after.io.runCommand;
  after.io.runCommand = async (argv) => { const r = await run(argv); if (argv[2] === "submit") submitted = true; return r; };
  await assert.rejects(runLand(after.io), (error) => {
    assert.match(error.message, /t1 was submitted at aaaaaaaa, but its acceptance criteria changed after the triage \(binding [0-9a-f]{8}, now [0-9a-f]{8}\), so the landing stops before the review request: no review was asked for, and t1 stays submitted with its holder/);
    assert.match(error.message, /Run atelier land t1 --triage codex\/gpt-6-astra again/);
    assert.doesNotMatch(error.message, /nothing was submitted/);
    return true;
  });
  assert.equal(after.asked.length, 1);
  assert.equal(after.reviewAsked(), false);
  assert.ok(after.released());

  // Criteria that never settle stop the landing rather than triage for ever.
  let n = 0;
  const churn = landing(t, { args: { triage: "codex/gpt-6-astra" }, criteria: () => [`Criterion ${n++}`], answers: [allMet(1)] });
  await assert.rejects(runLand(churn.io), /kept changing while it was triaged/);
  assert.equal(churn.reviewAsked(), false);
  assert.deepEqual(churn.commands(), ["push", "check"]);
});

test("a pass recorded at the same head, merge base and criteria stands without asking the model again; any other binding asks again (t475)", async (t) => {
  const binding = { head: HEAD, base: BASE, criteria: criteriaOf({ accept: CRITERIA }) };
  const same = landing(t, { args: { triage: "codex/gpt-6-astra", "no-review": true }, events: [{ kind: "land.triage", seq: 1, data: triageRecord(binding, "passed", { triager: "codex/gpt-6-astra" }) }] });
  await runLand(same.io);
  assert.equal(same.asked.length, 0);
  assert.match(same.output(), /already found every criterion met at aaaaaaaa .*it stands/);
  assert.deepEqual(same.commands(), ["push", "check", "submit"]);
  for (const moved of [{ head: "c".repeat(40) }, { base: "c".repeat(40) }, { criteria: criteriaOf({ accept: ["Older"] }) }]) {
    const stale = landing(t, { args: { triage: "codex/gpt-6-astra", "no-review": true }, events: [{ kind: "land.triage", seq: 1, data: triageRecord({ ...binding, ...moved }, "passed", { triager: "codex/gpt-6-astra" }) }] });
    await runLand(stale.io);
    assert.equal(stale.asked.length, 1, JSON.stringify(moved));
  }
});

test("without an injected harness the triage runs through the harness's own adapter, read-only, and its answer is read (t475)", async (t) => {
  // A stand-in for claude, as ATELIER_CLAUDE names one for the adapter: it
  // keeps the prompt it was given and answers every criterion met, or fails.
  const scratch = resolve(".scratch"); mkdirSync(scratch, { recursive: true });
  const bin = mkdtempSync(join(scratch, "triage-claude-")); t.after(() => rmSync(bin, { recursive: true, force: true }));
  const fake = (name, body) => { const file = join(bin, name); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file; };
  const answering = fake("claude-ok", `cat > "${join(bin, "prompt.txt")}"\nprintf '%s\\n' "$*" > "${join(bin, "argv.txt")}"\necho '${allMet().replace(/\n/g, " ")}'`);
  const l = landing(t, { args: { triage: "claude-code/opus-5.5", "no-review": true } });
  delete l.io.triage;
  l.io.triageTimeoutMs = 60_000;
  l.io.env = { ...process.env, ATELIER_CLAUDE: answering };
  await runLand(l.io);
  assert.deepEqual(l.triages().map((d) => d.outcome), ["passed"]);
  const prompt = readFileSync(join(bin, "prompt.txt"), "utf8");
  assert.match(prompt, /Triage of proj\/t1: Widget/);
  assert.match(prompt, /\+widget/, "the diff from the merge base goes with the brief");
  // The review job's tools: nothing that edits.
  assert.match(readFileSync(join(bin, "argv.txt"), "utf8"), /--model claude-opus-5-5 .*--permission-mode default .*--disallowedTools .*,Edit,Write --output-format/);

  const failing = landing(t, { args: { triage: "claude-code/opus-5.5" } });
  delete failing.io.triage;
  failing.io.triageTimeoutMs = 60_000;
  failing.io.env = { ...process.env, ATELIER_CLAUDE: fake("claude-down", "echo 'not logged in' >&2\nexit 3") };
  await assert.rejects(runLand(failing.io), /triage is unavailable: claude-code\/opus-5\.5 could not be run \(exit 3/);
  assert.equal(failing.reviewAsked(), false);
});

// ── the owner's bypass and override ─────────────────────────────────────────

test("--no-triage records the owner's reason with the head and the criteria binding before the submission, and calls no model (t475)", async (t) => {
  const l = landing(t, { args: { "no-triage": "hotfix for the outage", "no-review": true }, project: { triage: "codex/gpt-6-astra" } });
  await runLand(l.io);
  assert.equal(l.asked.length, 0);
  assert.deepEqual(l.triages().map((d) => [d.outcome, d.reason, d.head, d.base, d.criteria]), [["bypassed", "hotfix for the outage", HEAD, BASE, criteriaOf({ accept: CRITERIA })]]);
  assert.ok(l.at((c) => c.path?.endsWith("/land") && c.body.step === "triage") < l.at((c) => c.command === "submit"));
  assert.match(l.output(), /Triage bypassed by the project owner \(--no-triage: hotfix for the outage\)/);
});

test("a bypass or an override the server does not record stops the landing before the submission (t475)", async (t) => {
  const bypass = landing(t, { args: { "no-triage": "hotfix" }, project: { triage: "codex/gpt-6-astra" }, landFails: (b) => b.step === "triage" });
  await assert.rejects(runLand(bypass.io), /The bypass of the triage \(--no-triage\) could not be recorded on the ledger, so the landing stops before the review request: not_project_owner/);
  assert.deepEqual(bypass.commands(), ["push", "check"]);
  assert.equal(bypass.reviewAsked(), false);
  assert.ok(bypass.released());

  const override = landing(t, { args: { triage: "codex/gpt-6-astra", "override-triage": "the route is checked by hand" }, answers: [reply([met(1), met(2, { status: "not-met" })])], landFails: (b) => b.outcome === "overridden" });
  await assert.rejects(runLand(override.io), /The override of the stopped triage \(--override-triage\) could not be recorded on the ledger/);
  assert.deepEqual(override.commands(), ["push", "check"]);
  assert.equal(override.reviewAsked(), false);
});

test("--override-triage goes past a stopped triage only once the stop and the owner's reason are recorded, and the review rules still apply (t475)", async (t) => {
  const l = landing(t, { args: { triage: "codex/gpt-6-astra", "override-triage": "the route is checked by hand" }, answers: [reply([met(1), met(2, { status: "not-met" })])], review: { needed: true, approveBy: "antigravity/gemini-3.1-pro" } });
  await runLand(l.io);
  assert.deepEqual(l.triages().map((d) => [d.outcome, d.reason ?? null]), [["stopped", "criterion 2 not met"], ["overridden", "the route is checked by hand"]]);
  assert.equal(l.triages()[1].head, HEAD);
  assert.equal(l.triages()[1].criteria, criteriaOf({ accept: CRITERIA }));
  // The override does not stand in for the independent review: the gate's review is still asked for.
  assert.ok(l.reviewAsked());
  assert.deepEqual(l.commands(), ["push", "check", "submit", "accept", "merge"]);
  // A triage that passes needs no override, and none is recorded.
  const passing = landing(t, { args: { triage: "codex/gpt-6-astra", "override-triage": "just in case", "no-review": true } });
  await runLand(passing.io);
  assert.deepEqual(passing.triages().map((d) => d.outcome), ["passed"]);
});

test("--override-triage after a stop overrides the stop recorded at the same binding without asking the model again; a stale stop is triaged afresh (t475)", async (t) => {
  const binding = { head: HEAD, base: BASE, criteria: criteriaOf({ accept: CRITERIA }) };
  const stopped = (b) => [{ kind: "land.triage", seq: 1, data: triageRecord(b, "stopped", { triager: "codex/gpt-6-astra", statuses: [met(1), met(2, { status: "not-met" })].map((r) => ({ n: r.criterion, status: r.status })), reason: "criterion 2 not met" }) }];
  const l = landing(t, { args: { triage: "codex/gpt-6-astra", "override-triage": "checked by hand", "no-review": true }, events: stopped(binding) });
  await runLand(l.io);
  assert.equal(l.asked.length, 0);
  assert.deepEqual(l.triages().map((d) => [d.outcome, d.reason]), [["stopped", "criterion 2 not met"], ["overridden", "checked by hand"]]);
  assert.match(l.output(), /criterion 2 not met \(as recorded at this head, merge base and criteria\)/);
  assert.ok(l.at((c) => c.path?.endsWith("/land") && c.body.outcome === "overridden") < l.at((c) => c.command === "submit"));

  // A stop recorded at another head is not this change's: the model is asked.
  const moved = landing(t, { args: { triage: "codex/gpt-6-astra", "override-triage": "checked by hand", "no-review": true }, events: stopped({ ...binding, head: "c".repeat(40) }) });
  await runLand(moved.io);
  assert.equal(moved.asked.length, 1);
  assert.deepEqual(moved.triages().slice(1).map((d) => d.outcome), ["passed"]);
});

test("passing triage hands the landing to the review rules as they were: no review needed, an existing approval (t475)", async (t) => {
  const none = landing(t, { args: { triage: "codex/gpt-6-astra" }, review: { needed: false, reason: "a direct change needs no review" } });
  await runLand(none.io);
  assert.match(none.output(), /No review was needed: this change touched no protected paths/);
  assert.deepEqual(none.commands(), ["push", "check", "submit", "accept", "merge"]);
  const approved = landing(t, { args: { triage: "codex/gpt-6-astra" }, review: { needed: false, reason: "the gate already counts an independent approval of aaaaaaaa" } });
  await runLand(approved.io);
  assert.match(approved.output(), /an independent approval already covers this change/);
});

test("conflicting triage flags are refused before the lease is taken or anything is pushed (t475)", async (t) => {
  for (const [args, pattern] of [
    [{ triage: "codex/gpt-6-astra", "no-triage": "why" }, /--triage and --no-triage together/],
    [{ "no-triage": "why" }, /this landing has none/],
    [{ "release-lease": true, triage: "codex/gpt-6-astra" }, /--release-lease frees the project's landing lease and does nothing else/],
  ]) {
    const l = landing(t, { args });
    await assert.rejects(runLand(l.io), pattern);
    assert.deepEqual(l.commands(), []);
    assert.ok(!l.log.some((c) => c.path?.endsWith("/landing-lease") && c.method === "POST"));
  }
});

test("--dry-run reports the triage choice and its source without calling a model or recording anything (t475)", async (t) => {
  const flag = landing(t, { args: { "dry-run": true, triage: "codex/gpt-6-astra" } });
  await runLand(flag.io);
  assert.match(flag.output(), /6\. triage the pushed head's diff against its merge base with main and t1's 2 acceptance criteria with codex\/gpt-6-astra \(from --triage\), going on only when every criterion is met/);
  const project = landing(t, { args: { "dry-run": true }, project: { triage: "codex/gpt-7" } });
  await runLand(project.io);
  assert.match(project.output(), /with codex\/gpt-7 \(from project\.triage\); as the pool stands it would stop: codex\/gpt-7 is not in the model pool/);
  const off = landing(t, { args: { "dry-run": true } });
  await runLand(off.io);
  assert.match(off.output(), /6\. run no triage \(no --triage, and the project sets no triage\), then submit t1/);
  const bypass = landing(t, { args: { "dry-run": true, "no-triage": "hotfix" }, project: { triage: "codex/gpt-6-astra" } });
  await runLand(bypass.io);
  assert.match(bypass.output(), /record your bypass of the triage \(--no-triage: "hotfix"\)/);
  const empty = landing(t, { args: { "dry-run": true, triage: "codex/gpt-6-astra", "override-triage": "ok" }, criteria: [] });
  await runLand(empty.io);
  assert.match(empty.output(), /of which it has none, so the triage would stop and say so/);
  assert.match(empty.output(), /unless the stop is overridden \(--override-triage: "ok"\)/);
  for (const l of [flag, project, off, bypass, empty]) {
    assert.equal(l.asked.length, 0);
    assert.deepEqual(l.triages(), []);
    assert.deepEqual(l.commands(), []);
    assert.match(l.output(), /Nothing was changed\./);
  }
});

// ── the Workflow landing ────────────────────────────────────────────────────

test("a Workflow landing triages after the local checks and reports the head only once every criterion is met, with the binding the Workflow checks (t475)", async (t) => {
  const l = landing(t, { workflow: true, args: { triage: "codex/gpt-6-astra" } });
  await runLand(l.io);
  const triagedAt = l.at((c) => c.triage);
  const reportedAt = l.at((c) => c.body?.event?.type === "workspace");
  assert.ok(l.at((c) => c.command === "check") < triagedAt && triagedAt < reportedAt, "checks, triage, then the head is reported");
  // The Workflow is started as one that triages, and the head goes with
  // the merge base and the criteria the triage read, which the Workflow
  // checks against the Ledger before it submits and before the review.
  assert.equal(l.log.find((c) => c.method === "POST" && c.path?.endsWith("/landing-workflow") && !c.body?.event)?.body.triage, true);
  assert.deepEqual(l.log[reportedAt].body.event.payload, { round: 0, head: HEAD, mainHead: HEAD, mergedIn: false, triage: { base: BASE, criteria: criteriaOf({ accept: CRITERIA }) } });
  assert.deepEqual(l.triages().map((d) => d.outcome), ["passed"]);

  // Without a triage the Workflow is started as before, and the report carries no binding.
  const off = landing(t, { workflow: true });
  await runLand(off.io);
  assert.equal(off.log.find((c) => c.method === "POST" && c.path?.endsWith("/landing-workflow") && !c.body?.event)?.body.triage, undefined);
  assert.equal(off.log.find((c) => c.body?.event?.type === "workspace")?.body.event.payload.triage, undefined);
});

test("a Workflow landing whose triage stops reports a failed workspace, so the Workflow submits nothing, asks for no review and releases the lease (t475)", async (t) => {
  for (const answers of [[reply([met(1), met(2, { status: "unsure" })])], [new Error("codex is down")], ["hang"]]) {
    const l = landing(t, { workflow: true, args: { triage: "codex/gpt-6-astra" }, answers });
    await assert.rejects(runLand(l.io), (error) => {
      assert.match(error.message, /The landing stops before the review request/);
      assert.match(error.message, /atelier land t1 --workflow --triage codex\/gpt-6-astra again/);
      return true;
    });
    const reports = l.log.filter((c) => c.body?.event?.type === "workspace").map((c) => c.body.event.payload);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].failed, true);
    assert.equal(reports[0].head, undefined, "no head is reported, so the Workflow submits nothing");
    assert.match(reports[0].reason, /triage of t1 by codex\/gpt-6-astra stopped/);
    assert.deepEqual(l.commands(), ["push", "check"]);
    assert.equal(l.reviewAsked(), false);
  }
});

test("a Workflow landing with --no-triage records the bypass before reporting the head, and a refused record fails the workspace (t475)", async (t) => {
  const l = landing(t, { workflow: true, args: { "no-triage": "hotfix" }, project: { triage: "codex/gpt-6-astra" } });
  await runLand(l.io);
  assert.ok(l.at((c) => c.path?.endsWith("/land") && c.body.step === "triage") < l.at((c) => c.body?.event?.type === "workspace"));
  assert.deepEqual(l.triages().map((d) => d.outcome), ["bypassed"]);
  const refused = landing(t, { workflow: true, args: { "no-triage": "hotfix" }, project: { triage: "codex/gpt-6-astra" }, landFails: (b) => b.step === "triage" });
  await assert.rejects(runLand(refused.io), /could not be recorded on the ledger/);
  assert.equal(refused.log.find((c) => c.body?.event?.type === "workspace")?.body.event.payload.failed, true);
});

// ── review findings on f1f371c ──────────────────────────────────────────────

test("a status Object.prototype has, such as constructor, is malformed, and only every status met proceeds (t475)", async (t) => {
  for (const status of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    const parsed = parseTriage(reply([met(1), met(2, { status })]), 2);
    assert.equal(parsed.ok, false, status);
    assert.match(parsed.error, /entry 2: "status" must be met, not-met or unsure/, status);
  }
  // A result whose status is none of the three, however it got there, stops.
  const forged = [{ n: 1, status: "met" }, { n: 2, status: "constructor" }];
  assert.deepEqual(decideTriage(forged), { proceed: false, notMet: [2], unsure: [] });
  assert.equal(decideTriage([{ n: 1, status: "met" }, { n: 2, status: undefined }]).proceed, false);

  const l = landing(t, { args: { triage: "codex/gpt-6-astra" }, answers: [reply([met(1), met(2, { status: "constructor" })])] });
  await assert.rejects(runLand(l.io), /reply could not be read: entry 2: "status" must be met, not-met or unsure, not "constructor"/);
  assert.deepEqual(l.commands(), ["push", "check"], "nothing submitted");
  assert.equal(l.reviewAsked(), false);
});

// The owner's commands a stop advertises, as runLand's arguments.
function advertised(message) {
  return [...message.matchAll(/atelier land t1((?: --[a-z-]+(?: [^\s"]+)?)*?) --(override-triage|no-triage) "REASON"/g)].map(([, rest, flag]) => {
    const args = {};
    const words = rest.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      if (words[i] === "--workflow") args.workflow = true;
      else if (words[i] === "--triage") args.triage = words[++i];
      else throw new Error(`unexpected ${words[i]} in ${rest}`);
    }
    return { flag, args: { ...args, [flag]: "checked by hand" } };
  });
}

for (const workflow of [false, true]) {
  test(`every way past a stopped triage the ${workflow ? "Workflow" : "plain"} landing advertises runs as given and is recorded, with --triage H/M or the project's setting (t475)`, async (t) => {
    const notMet = reply([met(1), met(2, { status: "not-met" })]);
    for (const [setup, flags] of [
      [{ args: { triage: "codex/gpt-6-astra" } }, ["override-triage"]],
      [{ project: { triage: "codex/gpt-6-astra" } }, ["override-triage", "no-triage"]],
    ]) {
      const first = landing(t, { ...setup, workflow, answers: [notMet] });
      let message = "";
      await assert.rejects(runLand(first.io), (error) => { message = error.message; return true; });
      assert.match(message, /triage of t1 by codex\/gpt-6-astra stopped/);
      const ways = advertised(message);
      assert.deepEqual(ways.map((w) => w.flag), flags, message);
      for (const way of ways) {
        assert.deepEqual(resolveTriage({ triage: way.args.triage, noTriage: way.args["no-triage"], override: way.args["override-triage"], project: setup.project?.triage }).error, undefined, JSON.stringify(way.args));
        const { workflow: wf, ...args } = way.args;
        assert.equal(wf === true, workflow, "the retry keeps --workflow");
        const again = landing(t, { ...setup, workflow, args: { ...args, "no-review": true }, events: first.recorded, answers: [notMet] });
        await runLand(again.io);
        assert.equal(again.asked.length, 0, `${way.flag}: the model is not asked again`);
        const outcome = way.flag === "no-triage" ? "bypassed" : "overridden";
        const record = again.triages().find((d) => d.outcome === outcome && d.reason === "checked by hand");
        assert.ok(record, `${way.flag} is recorded`);
        assert.deepEqual([record.head, record.base, record.criteria], [HEAD, BASE, criteriaOf({ accept: CRITERIA })]);
        if (workflow) assert.ok(again.at((c) => c.path?.endsWith("/land") && c.body.outcome === outcome) < again.at((c) => c.body?.event?.type === "workspace" && c.body.event.payload.head));
        else assert.deepEqual(again.commands(), ["push", "check", "submit"]);
      }
    }
  });
}

// ── the binding the Workflow checks, and the project's setting ──────────────

test("a triage stands for a landing only while the head and criteria are the bound ones and a pass, bypass or override is recorded at that binding (t475)", () => {
  const binding = { head: HEAD, base: BASE, criteria: criteriaOf({ accept: CRITERIA }) };
  const item = { head: HEAD, accept: CRITERIA };
  const at = (outcome, b = binding) => [{ kind: "land.triage", seq: 1, data: triageRecord(b, outcome, { triager: "codex/gpt-6-astra" }) }];
  for (const outcome of ["passed", "bypassed", "overridden"]) assert.equal(triageStandsRefusal(item, at(outcome), binding), null, outcome);
  assert.match(triageStandsRefusal(item, at("stopped"), binding), /no triage that lets the landing go on/);
  assert.match(triageStandsRefusal(item, [], binding), /no triage that lets the landing go on/);
  assert.match(triageStandsRefusal(item, at("passed", { ...binding, base: "c".repeat(40) }), binding), /no triage that lets the landing go on/);
  assert.match(triageStandsRefusal({ ...item, head: "c".repeat(40) }, at("passed"), binding), /the head moved from the triaged aaaaaaaa to cccccccc/);
  assert.match(triageStandsRefusal({ ...item, accept: [...CRITERIA, "A third"] }, at("passed"), binding), /the acceptance criteria changed since the triage/);
  assert.match(triageStandsRefusal(item, at("passed"), null), /reported no triage binding/);
  assert.match(triageStandsRefusal(item, at("passed"), { head: HEAD, base: BASE, criteria: "short" }), /reported no triage binding/);
});

test("the project's triage setting is harness/model under a harness Atelier ships an adapter for (t475)", () => {
  assert.equal(triageSettingRefusal("codex/gpt-6-astra"), null);
  assert.equal(triageSettingRefusal("claude-code/opus-5.5"), null);
  assert.match(triageSettingRefusal("gpt-6-astra"), /must be harness\/model/);
  assert.match(triageSettingRefusal(7), /must be harness\/model/);
  assert.match(triageSettingRefusal("cursor/composer-2"), /runs under cursor, and Atelier ships adapters for/);
});

test("init --triage needs a model, and a bare one is refused before anything is sent (t475)", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-init-triage-"));
  try {
    const r = spawnSync(process.execPath, [resolve("cli/atelier.mjs"), "init", "--triage"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--triage needs a model: atelier init --triage H\/M, or --triage "" to clear it/);
    assert.doesNotMatch(r.stderr, /fetch failed|ECONNREFUSED|ENOTFOUND/);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
