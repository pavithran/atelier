// Part 2 of 2 of the tests that were in cli-flags.test.mjs, split so no file runs for more than about a minute (t771).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "../cli/atelier.mjs";
import { fixture, cli } from "./cli-flags-shared.mjs";

test("ls --json and status --json print each item with its times, for Observatory", (t) => {
  const f = fixture(t);
  const TIMES = { createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-10-05T09:30:00.000Z", lastPushAt: "2026-10-05T09:00:00.000Z" };
  const ls = f.run(f.checkout, ["ls", "--project", "demo", "--json"]);
  assert.equal(ls.status, 0, ls.stderr);
  assert.deepEqual(JSON.parse(ls.stdout), [
    { id: "t1", title: "Task t1", state: "submitted", owner: "codex/test", head: f.head, ...TIMES },
    { id: "t2", title: "Task t2", state: "submitted", owner: "codex/test", head: f.head, ...TIMES },
  ]);

  const status = f.run(f.checkout, ["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), [{
    name: "demo",
    title: "Demo",
    inbox: [],
    items: [
      { id: "t1", title: "Task t1", state: "submitted", owner: "codex/test", head: f.head, ...TIMES },
      { id: "t2", title: "Task t2", state: "submitted", owner: "codex/test", head: f.head, ...TIMES },
    ],
    overlaps: [],
    // The waiting rule's placement (src/attention.ts): nothing waits on the
    // owner, and both submitted tasks are in review.
    attention: {
      owner: [],
      pipeline: [{ id: "t1", title: "Task t1", stage: "submitted", notices: [] }, { id: "t2", title: "Task t2", stage: "submitted", notices: [] }],
      unknown: [],
    },
    mergedByOverride: [],
    // stageOf's stage for each task (t210): pushed at its head, nothing later.
    stages: ["t1", "t2"].map((id) => ({ id, stage: "built", detail: { head: f.head, source: "push" } })),
  }]);

  // The JSON listing honours --all as the text one does (test/status.test.mjs
  // covers the text).
});


test("new and edit send the framing as lists and a line, block sends its reason, and an empty value clears only on edit", (t) => {
  const f = fixture(t);
  const made = f.run(f.checkout, ["new", "Frame it", "--scope", "src/**", "--non-goal", "no CSS", "--non-goal", "no routes", "--stop-when", "a check fails twice", "--next-gate", "design review", "--project", "demo"]);
  assert.equal(made.status, 0, made.stderr);
  assert.deepEqual(f.requests().filter((q) => q.method === "POST").map((q) => [q.path, q.body]), [
    ["/api/projects/demo/items", { title: "Frame it", scope: ["src/**"], nonGoals: ["no CSS", "no routes"], stopWhen: ["a check fails twice"], nextGate: "design review" }],
  ]);
  f.clear();
  // A field not given is not sent, so the server keeps what the item has.
  const plain = f.run(f.checkout, ["new", "Plain", "--project", "demo"]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(f.requests().filter((q) => q.method === "POST").map((q) => q.body), [{ title: "Plain", scope: [] }]);
  f.clear();
  for (const [argv, message] of [
    [["new", "Title", "--non-goal", "", "--project", "demo"], /--non-goal needs text: atelier new --non-goal "TEXT", once per entry/],
    [["new", "Title", "--stop-when", "  ", "--project", "demo"], /--stop-when needs text: atelier new --stop-when "TEXT", once per entry/],
    [["new", "Title", "--next-gate", "--project", "demo"], /--next-gate needs text: atelier new --next-gate "TEXT"/],
    [["new", "Title", "--next-gate", "  ", "--project", "demo"], /--next-gate needs text: atelier new --next-gate "TEXT"/],
    [["edit", "t1", "--project", "demo"], /usage: atelier edit ID \[--title TEXT\] \[--brief TEXT\] \[--scope GLOB\]\.\.\. \[--accept TEXT\]\.\.\. \[--non-goal TEXT\]/],
    [["edit", "t1", "--non-goal", "", "--non-goal", "x", "--project", "demo"], /--non-goal needs text: atelier edit ID --non-goal "TEXT", once per entry, or --non-goal "" alone to clear/],
    [["edit", "t1", "--scope", "", "--scope", "src/**", "--project", "demo"], /--scope needs text: atelier edit ID --scope "GLOB", once per entry, or --scope "" alone to clear/],
    [["block", "t1", "--project", "demo"], /usage: atelier block \[ID\] "what it is waiting on"/],
    [["block", "--project", "demo"], /usage: atelier block/],
  ]) {
    const r = f.run(f.checkout, argv);
    assert.equal(r.status, 1, argv.join(" "));
    assert.match(r.stderr, message, argv.join(" "));
  }
  assert.deepEqual(f.requests(), []);
  // edit sends exactly what it is given: a replacement list, an empty list, a cleared gate.
  const edited = f.run(f.checkout, ["edit", "t1", "--non-goal", "no CSS", "--stop-when", "", "--next-gate", "", "--project", "demo"]);
  assert.equal(edited.status, 0, edited.stderr);
  assert.deepEqual(f.requests().map((q) => [q.method, q.path, q.body, q.actor]), [["POST", "/api/projects/demo/items/t1/edit", { nonGoals: ["no CSS"], stopWhen: [], nextGate: null }, "owner"]]);
  assert.match(edited.stdout, /^t1 edited\.\nNon-goals: no CSS\n$/);
  f.clear();
  // --context sets, replaces and (empty) clears the reviewers' context, and is sent trimmed.
  for (const [text, sent] of [["Keep the ledger column out.", "Keep the ledger column out."], ["  padded  ", "padded"], ["", ""]]) {
    const ctx = f.run(f.checkout, ["edit", "t1", "--context", text, "--project", "demo"]);
    assert.equal(ctx.status, 0, ctx.stderr);
    assert.deepEqual(f.requests().map((q) => [q.path, q.body]), [["/api/projects/demo/items/t1/edit", { context: sent }]]);
    f.clear();
  }
  const bare = f.run(f.checkout, ["edit", "t1", "--context", "--project", "demo"]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /--context needs text/);
  assert.deepEqual(f.requests(), []);
  // --scope is repeatable; one empty value clears it.
  const scoped = f.run(f.checkout, ["edit", "t1", "--scope", "src/**", "--scope", "test/**", "--project", "demo"]);
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.deepEqual(f.requests().map((q) => q.body), [{ scope: ["src/**", "test/**"] }]);
  assert.match(scoped.stdout, /Scope: src\/\*\*, test\/\*\*/);
  f.clear();
  const unscoped = f.run(f.checkout, ["edit", "t1", "--scope", "", "--project", "demo"]);
  assert.equal(unscoped.status, 0, unscoped.stderr);
  assert.deepEqual(f.requests().map((q) => q.body), [{ scope: [] }]);
  f.clear();
  // block takes the id first when given, else the workspace's item; the reason is the words after it.
  const blocked = f.run(f.checkout, ["block", "t2", "waiting", "on", "the", "keys", "--project", "demo"]);
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.deepEqual(f.requests().map((q) => [q.path, q.body]), [["/api/projects/demo/items/t2/block", { reason: "waiting on the keys" }]]);
  assert.match(blocked.stdout, /^t2 is blocked: waiting on the keys\. It keeps its holder and workspace; run atelier unblock t2 when it can go on\.\n$/);
  f.clear();
  const here = f.run(f.workspace, ["block", "needs a decision"], { ATELIER_ACTOR: "codex/test" });
  assert.equal(here.status, 0, here.stderr);
  assert.deepEqual(f.requests().map((q) => [q.path, q.body, q.actor]), [["/api/projects/demo/items/t1/block", { reason: "needs a decision" }, "codex/test"]]);
  f.clear();
  const unblocked = f.run(f.workspace, ["unblock"], { ATELIER_ACTOR: "codex/test" });
  assert.equal(unblocked.status, 0, unblocked.stderr);
  assert.deepEqual(f.requests().map((q) => [q.path, q.body, q.actor]), [["/api/projects/demo/items/t1/unblock", {}, "codex/test"]]);
  assert.match(unblocked.stdout, /^t1 is unblocked and claimed again\.\n$/);
});


// t315: a short title, a brief and acceptance criteria. One long string is
// sent as the title, as an older CLI sends it, and the answer says the
// server kept it as the brief.
// t402: a session is pointed at the orchestrator guide by the commands it runs
// until the project's AGENTS.md states the review path.
const POINTER = "Review path for demo: atelier guide --role orchestrate --project demo prints how to run, review and land work here, including atelier land --reviewer.\n";


test("ls and new name the orchestrator guide until AGENTS.md states the review path, and not in a task workspace or in --json", (t) => {
  const f = fixture(t);
  for (const argv of [["ls", "--project", "demo"], ["new", "A task", "--project", "demo"]]) {
    const r = f.run(f.checkout, argv);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.endsWith(`\n\n${POINTER}`), `${argv[0]}: ${r.stdout}`);
    assert.equal(r.stdout.split("atelier guide --role orchestrate").length, 2, "one line");
  }
  assert.doesNotMatch(f.run(f.checkout, ["ls", "--json", "--project", "demo"]).stdout, /atelier guide/);
  assert.doesNotMatch(f.run(f.workspace, ["ls"]).stdout, /atelier guide/);
  writeFileSync(join(f.checkout, "AGENTS.md"), "Land with `atelier land ID --reviewer H/M`.\n");
  for (const argv of [["ls", "--project", "demo"], ["new", "A task", "--project", "demo"]]) {
    const r = f.run(f.checkout, argv);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /atelier guide/, argv[0]);
  }
});


test("status --brief names the orchestrator guide until AGENTS.md states the review path, and not with --json", (t) => {
  const f = fixture(t);
  const brief = f.run(f.checkout, ["status", "--brief", "--project", "demo"]);
  assert.equal(brief.status, 0, brief.stderr);
  assert.ok(brief.stdout.endsWith(`\n\n${POINTER}`), brief.stdout);
  assert.equal(brief.stdout.split("atelier guide --role orchestrate").length, 2, "one line");
  assert.doesNotMatch(f.run(f.checkout, ["status", "--brief", "--json", "--project", "demo"]).stdout, /atelier guide/);
  writeFileSync(join(f.checkout, "AGENTS.md"), "Land with `atelier land ID --reviewer H/M`.\n");
  assert.doesNotMatch(f.run(f.checkout, ["status", "--brief", "--project", "demo"]).stdout, /atelier guide/);
});


test("new sends a title, a brief and repeatable criteria; one long string alone is said to become the brief; edit takes --title, --brief and --accept", (t) => {
  const f = fixture(t);
  const made = f.run(f.checkout, ["new", "Short titles", "--brief", "The whole task.", "--accept", "Lists show it", "--accept", "The page shows the brief", "--project", "demo"]);
  assert.equal(made.status, 0, made.stderr);
  assert.deepEqual(f.requests().filter((q) => q.method === "POST").map((q) => q.body), [{ title: "Short titles", scope: [], brief: "The whole task.", accept: ["Lists show it", "The page shows the brief"] }]);
  assert.equal(made.stdout, "t9  Short titles\nAcceptance criterion 1: Lists show it\nAcceptance criterion 2: The page shows the brief\n\n" + POINTER);
  f.clear();
  const long = "word ".repeat(30).trim();
  const derived = f.run(f.checkout, ["new", long, "--project", "demo"]);
  assert.equal(derived.status, 0, derived.stderr);
  assert.deepEqual(f.requests().filter((q) => q.method === "POST").map((q) => q.body), [{ title: long, scope: [] }]);
  assert.equal(derived.stdout, 't9  Derived title\nThe text is longer than a title, so it is kept as the brief and the title is its first clause; change it with atelier edit t9 --title "TEXT".\n\n' + POINTER);
  f.clear();
  for (const [argv, message] of [
    [["new", "Title", "--brief", "", "--project", "demo"], /--brief needs text: atelier new "short title" --brief "TEXT"/],
    [["new", "Title", "--accept", " ", "--project", "demo"], /--accept needs text: atelier new --accept "TEXT", once per criterion/],
    [["new", "Title", "--title", "x", "--project", "demo"], /new does not take --title/],
    [["edit", "t1", "--title", "", "--project", "demo"], /--title needs text: atelier edit ID --title "TEXT", at most 80 characters/],
    [["edit", "t1", "--accept", "", "--accept", "x", "--project", "demo"], /--accept needs text: atelier edit ID --accept "TEXT", once per criterion, or --accept "" alone to clear/],
  ]) {
    const r = f.run(f.checkout, argv);
    assert.equal(r.status, 1, argv.join(" "));
    assert.match(r.stderr, message, argv.join(" "));
  }
  assert.deepEqual(f.requests(), []);
  const edited = f.run(f.checkout, ["edit", "t1", "--title", "Shorter", "--brief", "", "--accept", "One", "--project", "demo"]);
  assert.equal(edited.status, 0, edited.stderr);
  assert.deepEqual(f.requests().map((q) => [q.path, q.body]), [["/api/projects/demo/items/t1/edit", { title: "Shorter", brief: null, accept: ["One"] }]]);
  assert.equal(edited.stdout, "t1 edited.\nTitle: Shorter\nBrief: cleared.\nAcceptance criterion 1: One\n");
  f.clear();
  const cleared = f.run(f.checkout, ["edit", "t1", "--accept", "", "--project", "demo"]);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.deepEqual(f.requests().map((q) => q.body), [{ accept: [] }]);
});


// t326: the review command sends the binding of the criteria it judged and
// the request it claimed only as given, never the task's own; edit says what
// a change of the criteria withdrew; show prints the criteria and their binding.
test("review sends the criteria binding and the request only as given, and refuses malformed ones before any request", (t) => {
  const f = fixture(t);
  const C = "c".repeat(64);
  const r = f.run(f.workspace, ["review", "t2", "--approve", "--criteria", C, "--request", "7", "--note", "read them"], { ATELIER_ACTOR: "claude-code/opus" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.requests().filter((q) => q.path.endsWith("/review")).map((q) => q.body), [{ approve: true, note: "read them", head: f.head, criteria: C, request: 7 }]);
  f.clear();
  // Without --criteria none is sent, and the server refuses it with how to refresh.
  const bare = f.run(f.workspace, ["review", "t2", "--approve"], { ATELIER_ACTOR: "claude-code/opus" });
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(f.requests().find((q) => q.path.endsWith("/review")).body.criteria, undefined);
  f.clear();
  for (const [argv, message] of [
    [["review", "t2", "--approve", "--criteria", "abc"], /--criteria needs the 64-digit binding atelier show prints/],
    [["review", "t2", "--approve", "--criteria", C, "--request", "x"], /--request needs the request number the review claim gave/],
  ]) {
    const bad = f.run(f.workspace, argv, { ATELIER_ACTOR: "claude-code/opus" });
    assert.equal(bad.status, 1, argv.join(" "));
    assert.match(bad.stderr, message);
  }
  assert.equal(f.requests().filter((q) => q.path.endsWith("/review")).length, 0);
});


// t575: on 2026-10-13 a hand-served review of t573 lost its claim to the
// 5-minute lease during a 6-minute run, and its verdict, sent without
// --request, was refused for "request undefined". The claim now prints the
// exact verdict command and how to renew; --renew renews through the route a
// runner uses; review without --request answers the request claimed here.
test("review-claim prints the verdict command and the lease, --renew renews it, and review remembers the request", (t) => {
  const f = fixture(t);
  const C = "c".repeat(64), as = { ATELIER_ACTOR: "opencode/glm-5.3" };
  const claim = f.run(f.workspace, ["review-claim", "t2", "--runner", "home:hand"], as);
  assert.equal(claim.status, 0, claim.stderr);
  // The JSON stays the one line on stdout, which a runner parses.
  assert.equal(JSON.parse(claim.stdout).request, 7);
  assert.equal(claim.stdout.trim().split("\n").length, 1);
  assert.match(claim.stderr, new RegExp(`^Claimed t2's review request 7 at ${f.head} as opencode/glm-5\\.3\\.$`, "m"));
  assert.match(claim.stderr, new RegExp(`^Criteria binding: ${C}$`, "m"));
  assert.ok(claim.stderr.includes(`Record the verdict with: atelier review t2 --head ${f.head} --request 7 --criteria ${C} --approve|--reject --note "…" --as opencode/glm-5.3`), claim.stderr);
  // Astra's review of t575 (2026-10-13): the server skips a renewal within
  // 30 seconds of its last one (REVIEW_RENEW_MS) and answers only
  // {renewed: true}, so "five more minutes" after an early renewal was
  // wrong, and renewing at its last moment lost the claim. The guidance
  // now renews every 2 minutes, inside the 4 minutes 30 seconds a renewal
  // is sure of.
  assert.match(claim.stderr, /lease lasts 5 minutes .*atelier review-claim t2 --renew --request 7 --as opencode\/glm-5\.3 every 2 minutes/);
  assert.doesNotMatch(claim.stderr, /within every 5 minutes/);
  f.clear();
  // --renew without --request renews the request claimed here, by the runner's route.
  const renew = f.run(f.workspace, ["review-claim", "t2", "--renew"], as);
  assert.equal(renew.status, 0, renew.stderr);
  assert.match(renew.stdout, /Renewed the lease on t2's review request 7, the one this machine last claimed, as opencode\/glm-5\.3: it lasts at least 4 minutes 30 seconds from now \(the server skips a renewal within 30 seconds of the last\); renew again within 2 minutes\./);
  assert.doesNotMatch(renew.stdout, /5 more minutes/);
  assert.deepEqual(f.requests().map((q) => [q.method, q.path, q.body, q.actor]), [["POST", "/api/projects/demo/items/t2/review-renew", { request: 7 }, "opencode/glm-5.3"]]);
  f.clear();
  const named = f.run(f.workspace, ["review-claim", "t2", "--renew", "--request", "9"], as);
  assert.equal(named.status, 0, named.stderr);
  assert.deepEqual(f.requests().map((q) => q.body), [{ request: 9 }]);
  f.clear();
  // review without --request answers the remembered request and says which.
  const verdict = f.run(f.workspace, ["review", "t2", "--approve", "--criteria", C, "--note", "fine"], as);
  assert.equal(verdict.status, 0, verdict.stderr);
  assert.match(verdict.stdout, /^Answering review request 7, the one this machine last claimed for t2 as opencode\/glm-5\.3/m);
  assert.deepEqual(f.requests().filter((q) => q.path.endsWith("/review")).map((q) => q.body.request), [7]);
  f.clear();
  // Another reviewer, or a task never claimed here, sends no request at all.
  for (const [id, env] of [["t2", { ATELIER_ACTOR: "claude-code/opus" }], ["t4", as]]) {
    const other = f.run(f.workspace, ["review", id, "--approve", "--criteria", C], env);
    assert.equal(other.status, 0, other.stderr);
    assert.doesNotMatch(other.stdout, /Answering/);
    assert.ok(!("request" in f.requests().find((q) => q.path.endsWith("/review")).body));
    f.clear();
  }
  // Nothing to renew for a task never claimed here; --request without --renew is refused.
  const none = f.run(f.workspace, ["review-claim", "t4", "--renew"], as);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no review request of t4 was claimed on this machine; name it with --request N/);
  const stray = f.run(f.workspace, ["review-claim", "t2", "--request", "7"], as);
  assert.equal(stray.status, 1);
  assert.match(stray.stderr, /--request names the claim --renew renews/);
  assert.equal(f.requests().length, 0);
  // Astra's review of t575 (2026-10-13): the remembered claim does not supply
  // the reviewer, so a renewal without --as fails or is refused by the
  // server's actor check; the help and the handbook name it.
  const help = spawnSync(process.execPath, [resolve("cli/atelier.mjs"), "review-claim", "--help"], { encoding: "utf8" });
  assert.match(help.stdout, /review-claim ID --renew --as H\/M/);
  assert.match(help.stdout, /renew every 2 minutes/);
  const handbook = readFileSync("docs/orchestrating.md", "utf8").replace(/\s+/g, " ");
  assert.match(handbook, /`atelier review-claim ID --renew --as HARNESS\/MODEL`/);
  assert.doesNotMatch(handbook, /`atelier review-claim ID --renew`/);
});


test("review-release forwards the claim generation and preserves owner recovery without a number", (t) => {
  const f = fixture(t);
  const run = (...flags) => f.run(f.workspace, ["review-release", "t2", ...flags], { ATELIER_ACTOR: "claude-code/opus" });
  const numbered = run("--request", "7", "--note", "harness stopped");
  assert.equal(numbered.status, 0, numbered.stderr);
  assert.deepEqual(f.requests().map((q) => [q.path, q.body]), [["/api/projects/demo/items/t2/review-release", { request: 7, note: "harness stopped" }]]);
  f.clear();
  const owner = run("--note", "manual recovery");
  assert.equal(owner.status, 0, owner.stderr);
  assert.deepEqual(f.requests().map((q) => q.body), [{ note: "manual recovery" }]);
  f.clear();
  for (const value of ["x", "0", "-1", "1.5", "1e2", "9007199254740992", ""]) {
    const bad = run(`--request=${value}`);
    assert.equal(bad.status, 1, value);
    assert.match(bad.stderr, /--request needs the request number the review claim gave/);
  }
  const bare = run("--request");
  assert.equal(bare.status, 1);
  assert.equal(f.requests().length, 0, "invalid generations never reach the server");
});


test("edit says when the acceptance criteria changed, what that withdrew, and that a fresh review is needed; otherwise nothing of them", (t) => {
  const f = fixture(t);
  const edit = (id, ...flags) => {
    const r = f.run(f.checkout, ["edit", id, ...flags, "--project", "demo"]);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  assert.equal(edit("t4", "--accept", "One", "--accept", "Two"), [
    "t4 edited.", "Acceptance criterion 1: One", "Acceptance criterion 2: Two",
    "The acceptance criteria of t4 changed (binding bbbbbbbbbbbb, was aaaaaaaaaaaa).",
    "Withdrawn: 2 reviews, 1 review request. They stay in the record and never count again, even if the criteria change back; t4 needs a fresh review of the new criteria.",
    "Asked again at the same head: codex/gpt-6-astra.", "",
  ].join("\n"));
  assert.match(edit("t5", "--accept", "One"), /\nWithdrawn: 1 review request\. They stay in the record and never count again, even if the criteria change back; t5 needs a fresh review of the new criteria\.\n$/);
  assert.match(edit("t6", "--accept", ""), /^t6 edited\. No framing is set now\.\nThe acceptance criteria of t6 changed \(binding bbbbbbbbbbbb, was aaaaaaaaaaaa\)\.\nNo review or review request stood, so nothing was withdrawn; any review of t6 from now on judges the new criteria\.\n$/);
  assert.match(edit("t7", "--accept", "One"), /Withdrawn: 1 review, the acceptance, the override of the review\..*\nt7 is claimed again: its holder submits it, and it is reviewed and accepted again before it can merge\.\n$/s);
  // The same criteria again, or an unrelated edit: no word of the criteria.
  for (const flags of [["--accept", "One"], ["--next-gate", "Owner"]]) assert.doesNotMatch(edit("t1", ...flags), /criteria of|Withdrawn|fresh review/);
  assert.deepEqual(f.requests().map((q) => q.body).filter((b) => b.accept !== undefined).map((b) => b.accept), [["One", "Two"], ["One"], [], ["One"], ["One"]]);
});


test("show prints the task's criteria, the plan's for a part, and their binding a review names", (t) => {
  const f = fixture(t);
  const r = f.run(f.checkout, ["show", "t2", "--project", "demo"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\nAcceptance criterion 1: Nested lists parse\nPlan acceptance criterion 1: It works\nCriteria binding: c{64} \(a review of these criteria names it with --criteria\)\n/);
});



test("review-request sends a named reviewer as an owner-requested runner job", (t) => {
  const f = fixture(t);
  const r = f.run(f.checkout, ["review-request", "t1", "--reviewer", "codex/gpt-6-astra"]);
  assert.equal(r.status, 0, r.stderr);
  const sent = f.requests().find((r) => r.path.endsWith("/review-request"));
  assert.deepEqual(sent.body, { reviewer: "codex/gpt-6-astra", wanted: true });
});


test("parseArgs: --brief is a switch only for status, found after flag values", () => {
  const other = parseArgs(["--project", "status", "new", "--brief", "text"]);
  assert.deepEqual(other._, ["new"]);
  assert.equal(other.brief, "text");
  const status = parseArgs(["--project", "demo", "status", "--brief"]);
  assert.deepEqual(status._, ["status"]);
  assert.equal(status.brief, true);
});
