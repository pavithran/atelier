// Part 1 of 2 of the tests that were in cli-flags.test.mjs, split so no file runs for more than about a minute (t771).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { noProjectMessage, parseArgs, unregisteredMessage } from "../cli/atelier.mjs";
import { fixture, cli } from "./cli-flags-shared.mjs";
// How the CLI reads its flags. A switch (--approve, --cancel, --json,
// --refuse-overlap) never takes the word after it, so an item id written after
// one is the item id; a flag that needs a value refuses a bare one before any
// request; a flag a command does not take is refused the same way. The
// commands run against a fake server: a preload replaces fetch, answers every
// route from local state and logs each request, and the server named in the
// configuration cannot be reached even if the preload were bypassed.
test("parseArgs: a switch keeps the next word as a positional, a text flag takes it", () => {
  const review = parseArgs(["review", "--approve", "t2", "--note", "fine"]);
  assert.deepEqual(review._, ["review", "t2"]);
  assert.equal(review.approve, true);
  assert.equal(review.note, "fine");
  assert.deepEqual([review.bare, review.problems], [[], []]);
  // The words true and false, and only those, set a switch.
  assert.equal(parseArgs(["init", "--refuse-overlap", "false"])["refuse-overlap"], false);
  assert.deepEqual(parseArgs(["init", "--refuse-overlap", "false"])._, ["init"]);
  assert.equal(parseArgs(["init", "--refuse-overlap=false"])["refuse-overlap"], false);
  assert.equal(parseArgs(["init", "--refuse-overlap=true"])["refuse-overlap"], true);
  assert.equal(parseArgs(["ls", "--all", "t1"]).all, true);
  assert.deepEqual(parseArgs(["ls", "--all", "t1"])._, ["ls", "t1"]);
  assert.match(parseArgs(["ls", "--all=maybe"]).problems[0], /--all takes no value/);
  // A text flag with no word after it, or a flag after it, is bare.
  assert.deepEqual(parseArgs(["handoff", "t1", "--to"]).bare, ["to"]);
  assert.deepEqual(parseArgs(["review", "t1", "--note", "--approve"]).bare, ["note"]);
  assert.equal(parseArgs(["review", "t1", "--note", "--approve"]).approve, true);
  assert.equal(parseArgs(["submit", "--summary="]).summary, "");
  assert.deepEqual(parseArgs(["submit", "--summary="]).bare, []);
  // -- ends the flags; --help is read wherever it stands.
  assert.deepEqual(parseArgs(["check", "--", "npm", "test"]).rest, ["npm", "test"]);
  assert.equal(parseArgs(["models", "add", "--help", "m1"]).help, true);
  assert.deepEqual(parseArgs(["models", "add", "--help", "m1"])._, ["models", "add", "m1"]);
});


// t360: --version parses like --help, wherever it stands, and never takes a
// value or lands in the flag table's way.
test("parseArgs: --version is read before any flag, wherever it stands", () => {
  assert.equal(parseArgs(["ls", "--version"]).version, true);
  assert.deepEqual(parseArgs(["ls", "--version"]).bare, []);
  assert.deepEqual(parseArgs(["ls", "--version"]).multi, {});
  // A word after --version is never its value: --all is still a switch.
  assert.equal(parseArgs(["ls", "--version", "--all"]).all, true);
  assert.deepEqual(parseArgs(["ls", "--version", "--all"])._, ["ls"]);
  assert.equal(parseArgs(["--version", "ls"]).version, true);
  assert.deepEqual(parseArgs(["--version", "ls"])._, ["ls"]);
  // After -- it is a word for the command, like any flag.
  const rest = parseArgs(["check", "--", "--version"]);
  assert.equal(rest.version, undefined);
  assert.deepEqual(rest.rest, ["--version"]);
});


// t360: --version=… is refused as a value the flag does not take, never a
// string that slips through and answers anyway.
test("parseArgs: --version= is a problem, not a version", () => {
  const parsed = parseArgs(["ls", "--version=x"]);
  assert.equal(parsed.version, false);
  assert.deepEqual(parsed.multi.version, [false]);
  assert.match(parsed.problems[0], /^--version takes no value/);
  assert.equal(parseArgs(["ls", "--version="]).version, false);
});


test("new warns when a task has no acceptance criteria, and init sends --require-criteria as a switch", (t) => {
  const f = fixture(t);
  const bare = f.run(f.checkout, ["new", "Title", "--project", "demo"]);
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /^t9  Title$/m);
  assert.match(bare.stderr, /^Warning: t9 has no acceptance criteria, so a review of it will have none to judge the change against\. Give them with atelier edit t9 --accept "TEXT", once per criterion\.$/m);
  f.clear();
  const judged = f.run(f.checkout, ["new", "Title", "--accept", "It works", "--project", "demo"]);
  assert.equal(judged.status, 0, judged.stderr);
  assert.doesNotMatch(judged.stderr, /no acceptance criteria/);
  const put = (argv) => {
    f.clear();
    const r = f.run(f.checkout, ["init", ...argv]);
    assert.equal(r.status, 0, r.stderr);
    return { stdout: r.stdout, requireCriteria: f.requests().find((q) => q.method === "PUT").body.requireCriteria };
  };
  const required = put(["--require-criteria"]);
  assert.equal(required.requireCriteria, true);
  assert.match(required.stdout, /^Criteria: +optional$/m);
  assert.match(required.stdout, /^Warning: the server did not record the criteria requirement; deploy the server, then run atelier init --require-criteria again\.$/m);
  assert.deepEqual(put(["--require-criteria=false"]).requireCriteria, false);
  assert.equal(put([]).requireCriteria, undefined);
  assert.equal(put(["--reset"]).requireCriteria, false);
});


test("a folder that is no registered checkout is named, with every registered project and its folder", (t) => {
  const f = fixture(t);
  const elsewhere = join(f.dir, "elsewhere");
  mkdirSync(elsewhere);
  const r = f.run(elsewhere, ["unwrap"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^atelier: which project\? \S*\/elsewhere is not a registered checkout or a task workspace\. Pass --project NAME, or run the command in a registered checkout or in a task workspace\.$/m);
  assert.match(r.stderr, new RegExp(`^Registered on this Mac:\\n  demo  \\S*/checkout$`, "m"));
  assert.doesNotMatch(r.stderr, /named like this folder/);
  assert.deepEqual(f.requests(), []);
  // A folder named like a registered project: a copy or a second clone of its checkout.
  const copy = join(f.dir, "copies", "demo");
  mkdirSync(copy, { recursive: true });
  const named = f.run(copy, ["ls"]);
  assert.equal(named.status, 1);
  assert.match(named.stderr, /^demo, named like this folder, is registered at \S*\/checkout; run the command there, or pass --project demo\.$/m);
  assert.deepEqual(f.requests(), []);
  // With nothing registered, init is the way to register a project.
  assert.equal(unregisteredMessage("/work/x", {}), "which project? /work/x is not a registered checkout or a task workspace. Pass --project NAME, or run the command in a registered checkout or in a task workspace.\nNo project is registered on this Mac: run atelier init in a project's checkout to register it.");
  assert.equal(unregisteredMessage("/work/Photograph", { photograph: { path: "/p" }, demo: { path: "/d" } }).split("\n").slice(1).join("\n"), "Registered on this Mac:\n  demo        /d\n  photograph  /p\nphotograph, named like this folder, is registered at /p; run the command there, or pass --project photograph.");
});


test("a project the server does not know is answered with the registered names, closest first, and init only away from a checkout", (t) => {
  const f = fixture(t);
  const typo = f.run(f.checkout, ["ls", "--project", "demp"]);
  assert.equal(typo.status, 1);
  assert.equal(typo.stderr, "atelier: no project named demp on https://fake.invalid.\nRegistered on this Mac, closest first: demo.\nThis folder is demo's checkout: run the command with --project demo, or without --project.\n");
  const elsewhere = join(f.dir, "elsewhere");
  mkdirSync(elsewhere);
  const away = f.run(elsewhere, ["show", "t1", "--project", "demp"]);
  assert.equal(away.status, 1);
  assert.equal(away.stderr, "atelier: no project named demp on https://fake.invalid.\nRegistered on this Mac, closest first: demo.\nTo register a new project, run atelier init in its checkout.\n");
  // A refused claim keeps exit code 3, which the runner reads, whatever the message.
  const claim = f.run(elsewhere, ["claim", "t1", "--project", "demp", "--as", "codex/test"]);
  assert.equal(claim.status, 3, claim.stderr);
  assert.match(claim.stderr, /^atelier: no project named demp on https:\/\/fake\.invalid\.$/m);
  // The nearest name comes first; a name this Mac registers but the server lacks is its own case.
  const projects = { atelier: { path: "/a" }, photograph: { path: "/p" }, demo: { path: "/d" } };
  assert.match(noProjectMessage("atelir", "https://x", projects, null), /^Registered on this Mac, closest first: atelier, demo, photograph\.$/m);
  assert.doesNotMatch(noProjectMessage("atelir", "https://x", projects, "demo"), /atelier init/);
  assert.match(noProjectMessage("demo", "https://x", projects, "demo"), /^This Mac registers demo's checkout at \/d, but the server has no project under that name: .* run atelier init in that checkout\.$/m);
  assert.equal(noProjectMessage("x", "https://x", {}, null), "no project named x on https://x.\nNo project is registered on this Mac. To register one, run atelier init in its checkout.");
});


test("abandon says whose write token is revoked, or that nobody held the item", (t) => {
  const f = fixture(t);
  const held = f.run(f.checkout, ["abandon", "t1", "--project", "demo"]);
  assert.equal(held.status, 0, held.stderr);
  assert.equal(held.stdout, "t1 abandoned; codex/test's write token is revoked.\n");
  assert.deepEqual(f.requests().filter((q) => q.method === "POST").map((q) => [q.path, q.body]), [["/api/projects/demo/items/t1/abandon", { note: "" }]]);
  const open = f.run(f.checkout, ["abandon", "t3", "--note", "Superseded by t5", "--project", "demo"]);
  assert.equal(open.status, 0, open.stderr);
  assert.equal(open.stdout, "t3 abandoned; nobody held it, so no write token was revoked.\n");
  assert.deepEqual(f.requests().filter((q) => q.path.endsWith("/t3/abandon")).map((q) => q.body), [{ note: "Superseded by t5" }]);
});


test("init refuses to run in a task workspace, names its project and task, and registers nothing", (t) => {
  const f = fixture(t);
  const config = () => readFileSync(join(f.dir, "config.json"), "utf8");
  const before = config();
  const r = f.run(f.workspace, ["init"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^atelier: this folder is demo\/t1's task workspace, not a project checkout; nothing was registered\. Run atelier init in demo's checkout: cd ".*checkout" && atelier init$/m);
  assert.deepEqual(f.requests(), [], "a request was sent");
  assert.equal(config(), before, "config.json changed");
});


test("when git itself cannot run, the error says why instead of showing an empty detail", (t) => {
  const f = fixture(t);
  const empty = join(f.dir, "no-bin");
  mkdirSync(empty);
  const r = f.run(f.checkout, ["init"], { PATH: empty });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^atelier: git rev-parse --show-toplevel could not run: git was not found on PATH$/m);
  assert.deepEqual(f.requests(), []);
  // A registered checkout that is gone is named as the cause, not PATH.
  const gone = join(f.dir, "gone");
  writeFileSync(join(f.dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", owner: "owner", projects: { demo: { path: gone, branch: "main" } } }));
  const missing = f.run(f.dir, ["notes-remote", "origin", "--project", "demo"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^atelier: git remote could not run: the folder \S*\/gone does not exist$/m);
});


test("review --approve t2 in t1's workspace reviews t2, never the workspace's item", (t) => {
  const f = fixture(t);
  const r = f.run(f.workspace, ["review", "--approve", "t2", "--note", "looks right"], { ATELIER_ACTOR: "claude-code/opus" });
  assert.equal(r.status, 0, r.stderr);
  const reviews = f.requests().filter((q) => q.method === "POST" && q.path.endsWith("/review"));
  assert.deepEqual(reviews.map((q) => [q.path, q.body.approve, q.body.note]), [["/api/projects/demo/items/t2/review", true, "looks right"]]);
  assert.match(r.stdout, /^Approved t2 @/);
  // --reject with a note that follows another switch: the note is the note.
  f.clear();
  const rejected = f.run(f.workspace, ["review", "t2", "--reject", "--note", "not yet"], { ATELIER_ACTOR: "claude-code/opus" });
  assert.equal(rejected.status, 0, rejected.stderr);
  assert.deepEqual(f.requests().filter((q) => q.path.endsWith("/review")).map((q) => [q.path, q.body.approve, q.body.note]), [["/api/projects/demo/items/t2/review", false, "not yet"]]);
});


test("merge --cancel t1 in the checkout cancels t1 instead of asking which item", (t) => {
  const f = fixture(t);
  const r = f.run(f.checkout, ["merge", "--cancel", "t1", "--project", "demo"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /which item\?/);
  assert.match(r.stdout, /t1: the merge is cancelled/);
  assert.deepEqual(f.requests().filter((q) => q.method === "POST").map((q) => [q.path, q.body]), [["/api/projects/demo/items/t1/landing", { cancel: true }]]);
});


// The owner's dispatch of a merge-main job (t243): the request carries the
// job and the head the server reads when none is named, the message says
// what the job does and what follows it, and the other jobs are refused.
test("dispatch --job merge-main sends the conflicted task back to its builder, and no other job is dispatched by hand", (t) => {
  const f = fixture(t);
  const r = f.run(f.checkout, ["dispatch", "t1", "--job", "merge-main", "--agent", "codex", "--model", "test", "--project", "demo"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.requests().filter((q) => q.method === "POST").map((q) => [q.path, q.body]),
    [["/api/projects/demo/items/t1/dispatch", { agent: "codex", model: "test", job: "merge-main" }]]);
  assert.equal(r.stdout, "t1 goes back to its builder to merge main at 55555555 into its workspace and resolve the conflicts: a runner that offers the merge-main job claims it, merges main there and leaves the conflicts for the harness to resolve and commit (built by codex with test). Then run atelier land t1 again.\n");
  // --head names the head when the owner gives one; without the job it is refused.
  f.clear();
  const named = f.run(f.checkout, ["dispatch", "t3", "--job", "merge-main", "--head", "a".repeat(40), "--project", "demo"]);
  assert.equal(named.status, 0, named.stderr);
  assert.deepEqual(f.requests().at(-1).body, { job: "merge-main", head: "a".repeat(40) });
  for (const [argv, why] of [
    [["dispatch", "t1", "--job", "plan"], /only merge-main is dispatched by hand: atelier dispatch t1 --job merge-main/],
    [["dispatch", "t1", "--head", "a".repeat(40)], /--head names the main head a merge-main job merges; give it with --job merge-main/],
  ]) {
    const refused = f.run(f.checkout, [...argv, "--project", "demo"]);
    assert.equal(refused.status, 1, argv.join(" "));
    assert.match(refused.stderr, why, argv.join(" "));
  }
  // An ordinary dispatch that names its agent is unchanged.
  f.clear();
  const plain = f.run(f.checkout, ["dispatch", "t3", "--to", "home", "--agent", "codex", "--project", "demo"]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(f.requests().at(-1).body, { to: "home", agent: "codex" });
  assert.equal(plain.stdout, "t3 is waiting for a home runner, codex.\n");
});


// With no --agent the server suggests the builder (t370): the CLI asks for
// the suggestion and prints which builder it chose and why.
test("dispatch with no --agent asks the server to suggest a builder and prints the choice and its reason", (t) => {
  const f = fixture(t);
  const r = f.run(f.checkout, ["dispatch", "t3", "--to", "home", "--project", "demo"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.requests().at(-1).body, { to: "home", suggest: true });
  assert.equal(r.stdout, "Builder: claude-code/opus-5.5. Eligible pool models ranked by recorded successful and failed outcomes. Passed over codex/gpt-6.1-sol: two consecutive stalled builds; no successful build since.\nt3 is waiting for a home runner, claude-code with opus-5.5.\n");
});


// t389: the owner's standing for a model is set with models set and comes
// back from models, in its listing and as JSON.
test("models set sends state, note, roles and tier; models lists them and --json returns them", (t) => {
  const f = fixture(t);
  const set = f.run(f.checkout, ["models", "set", "gpt-6-astra", "--state", "paused", "--note", "AI Studio down", "--roles", "build,review", "--tier", "execution"]);
  assert.equal(set.status, 0, set.stderr);
  const sent = f.requests().at(-1);
  assert.equal(sent.method, "POST");
  assert.equal(sent.path, "/api/models/gpt-6-astra/set");
  assert.deepEqual(sent.body, { state: "paused", note: "AI Studio down", roles: "build,review", tier: "execution" });
  assert.equal(set.stdout, "gpt-6-astra: paused since 2026-10-10T08:00Z roles build,review tier execution (AI Studio down).\n");

  const listed = f.run(f.checkout, ["models"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, "cloud codex/gpt-6-astra  openai  not checked  reserved since 2026-10-08T09:00Z  roles: review  tier: frontier\n");

  const json = f.run(f.checkout, ["models", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const [entry] = JSON.parse(json.stdout);
  assert.deepEqual({ state: entry.state, stateAt: entry.stateAt, roles: entry.roles, tier: entry.tier, note: entry.note }, { state: "reserved", stateAt: "2026-10-08T09:00:00.000Z", roles: ["review"], tier: "frontier", note: "credits held for t370" });

  // A set that names nothing to change is refused before any request.
  f.clear();
  const empty = f.run(f.checkout, ["models", "set", "gpt-6-astra"]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /name at least one/);
  assert.deepEqual(f.requests().filter((r) => r.path.startsWith("/api/models")), []);
});


// t360: --version answers after any command, before any request.
test("--version after a command prints the version and contacts no server", (t) => {
  const f = fixture(t);
  const r = f.run(f.checkout, ["ls", "--version"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^atelier \d+\.\d+\.\d+ \(route level \d+\)\n$/);
  assert.deepEqual(f.requests(), []);
});


// t690: the developer sends accepted work back to building with their own
// token and no --as; the command used to demand "say who you are" and a
// model name, which the server then refused as not_project_owner.
test("handoff with no --as and no workspace acts as the developer, and --as still wins", (t) => {
  const f = fixture(t);
  const noActor = { ATELIER_ACTOR: undefined };
  const r = f.run(f.checkout, ["handoff", "t1", "--to", "codex/test", "--project", "demo"], noActor);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /say who you are/);
  const sent = f.requests().find((q) => q.path.endsWith("/items/t1/handoff"));
  assert.equal(sent.actor, "owner");
  f.clear();
  const named = f.run(f.checkout, ["handoff", "t1", "--to", "codex/test", "--project", "demo", "--as", "claude-code/opus-5.5"], noActor);
  assert.equal(named.status, 0, named.stderr);
  assert.equal(f.requests().find((q) => q.path.endsWith("/items/t1/handoff")).actor, "claude-code/opus-5.5");
});


test("a flag that needs a value refuses a bare one before any request", (t) => {
  const f = fixture(t);
  for (const [argv, flag] of [
    [["handoff", "t1", "--to"], "to"],
    [["handoff", "t1", "--to", "--note", "why"], "to"],
    [["ls", "--project"], "project"],
    [["show", "t1", "--as", "--project", "demo"], "as"],
    [["dispatch", "t1", "--to", "--project", "demo"], "to"],
  ]) {
    f.clear();
    const r = f.run(f.checkout, argv);
    assert.equal(r.status, 1, argv.join(" "));
    assert.match(r.stderr, new RegExp(`--${flag} needs a value: --${flag} VALUE or --${flag}=VALUE`), argv.join(" "));
    assert.deepEqual(f.requests(), [], argv.join(" "));
  }
  // A flag with its own wording keeps it.
  const title = f.run(f.checkout, ["init", "--title"]);
  assert.equal(title.status, 1);
  assert.match(title.stderr, /give the title as --title TEXT, or --title "" to clear it/);
  const summary = f.run(f.workspace, ["submit", "--summary"]);
  assert.equal(summary.status, 1);
  assert.match(summary.stderr, /--summary needs text: atelier submit ID --summary "TEXT"/);
  // --check, --protect and --scope keep the wording their empty values get (test/list-flags.test.mjs).
  for (const [argv, message] of [
    [["init", "--check"], /--check needs text: atelier init --check "TEXT", once per entry/],
    [["init", "--protect", "--check", "npm test"], /--protect needs text: atelier init --protect "TEXT", once per entry/],
    [["new", "Title", "--scope", "--project", "demo"], /--scope needs text: atelier new --scope "TEXT", once per entry/],
  ]) {
    const r = f.run(f.checkout, argv);
    assert.equal(r.status, 1, argv.join(" "));
    assert.match(r.stderr, message, argv.join(" "));
  }
  assert.deepEqual(f.requests(), []);
});


test("init sends a switch as true or false, as it was written, and refuses any other word", (t) => {
  const f = fixture(t);
  const sent = (argv) => {
    f.clear();
    const r = f.run(f.checkout, ["init", ...argv]);
    assert.equal(r.status, 0, r.stderr);
    const put = f.requests().find((q) => q.method === "PUT");
    return { refuseOverlap: put.body.refuseOverlap, noOverride: put.body.noOverride };
  };
  assert.deepEqual(sent(["--refuse-overlap"]), { refuseOverlap: true, noOverride: undefined });
  assert.deepEqual(sent(["--refuse-overlap", "false"]), { refuseOverlap: false, noOverride: undefined });
  assert.deepEqual(sent(["--refuse-overlap=false"]), { refuseOverlap: false, noOverride: undefined });
  assert.deepEqual(sent(["--refuse-overlap=true", "--no-override"]), { refuseOverlap: true, noOverride: true });
  // The sandbox check mode is gone (t768): its flag is refused like any other unknown one.
  f.clear();
  const gone = f.run(f.checkout, ["init", "--sandbox-only"]);
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /--sandbox-only/);
  assert.deepEqual(f.requests(), []);
  for (const argv of [["check", "t1", "--sandbox"], ["finish", "--sandbox"], ["done", "x", "--sandbox"]]) {
    f.clear();
    const refused = f.run(f.checkout, argv);
    assert.equal(refused.status, 1, argv.join(" "));
    assert.match(refused.stderr, /--sandbox/, argv.join(" "));
    assert.deepEqual(f.requests(), [], argv.join(" "));
  }
  // --no-override (t371) is a switch like the others: it sends noOverride
  // true, false when turned off, and nothing when it is not given.
  assert.deepEqual(sent(["--no-override"]), { refuseOverlap: undefined, noOverride: true });
  assert.deepEqual(sent(["--no-override=false"]), { refuseOverlap: undefined, noOverride: false });
  assert.deepEqual(sent(["--no-override", "false"]), { refuseOverlap: undefined, noOverride: false });
  assert.deepEqual(sent([]), { refuseOverlap: undefined, noOverride: undefined });
  f.clear();
  const bad = f.run(f.checkout, ["init", "--refuse-overlap=yes"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--refuse-overlap takes no value: write --refuse-overlap, or --refuse-overlap=false to turn it off/);
  assert.deepEqual(f.requests(), []);
});


// t394: init --single-family COMPANY sends the company, --cross-family sends
// null, neither sends nothing, both together are refused, and the answer's
// mode is printed with who switched and when.
test("init sends --single-family as the company and --cross-family as null, prints the mode, and refuses both at once", (t) => {
  const f = fixture(t);
  const sent = (argv) => {
    f.clear();
    const r = f.run(f.checkout, ["init", ...argv]);
    assert.equal(r.status, 0, r.stderr);
    const put = f.requests().find((q) => q.method === "PUT");
    return { singleFamily: put.body.singleFamily, has: "singleFamily" in put.body, stdout: r.stdout };
  };
  const single = sent(["--single-family", "anthropic"]);
  assert.equal(single.singleFamily, "anthropic");
  assert.match(single.stdout, /^Models:     single-family, anthropic: building and reviewing use anthropic models only, and a review counts from a different anthropic model than every contributor \(set by owner at 2026-10-09T10:00:00\.000Z\)$/m);
  const cross = sent(["--cross-family"]);
  assert.equal(cross.singleFamily, null);
  assert.ok(cross.has);
  assert.match(cross.stdout, /^Models:     cross-family, the default: a protected change needs approval from a model of another company than every contributor \(set by owner at 2026-10-09T10:00:00\.000Z\)$/m);
  const none = sent([]);
  assert.equal(none.has, false);
  assert.match(none.stdout, /^Models:     cross-family, the default: a protected change needs approval from a model of another company than every contributor$/m);
  f.clear();
  const bare = f.run(f.checkout, ["init", "--single-family"]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /--single-family needs a company: atelier init --single-family anthropic/);
  assert.deepEqual(f.requests(), []);
  const both = f.run(f.checkout, ["init", "--single-family", "anthropic", "--cross-family"]);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /--single-family and --cross-family contradict each other; give one of them/);
  assert.deepEqual(f.requests(), []);
});


test("a flag the command does not take, or a stray --, is refused before any request", (t) => {
  const f = fixture(t);
  for (const [argv, message] of [
    [["ls", "--bogus", "--project", "demo"], /ls does not take --bogus; see atelier ls --help/],
    [["wrap", "Done", "--no-chcek"], /wrap does not take --no-chcek; see atelier wrap --help/],
    [["show", "t1", "--project", "demo", "--", "extra", "words"], /show does not take "--" and the words after it/],
  ]) {
    f.clear();
    const r = f.run(f.checkout, argv);
    assert.equal(r.status, 1, argv.join(" "));
    assert.match(r.stderr, message);
    assert.deepEqual(f.requests(), [], argv.join(" "));
  }
  // --help wins over a bad flag, and check takes --.
  assert.equal(f.run(f.checkout, ["wrap", "--bogus", "--help"]).status, 0);
  f.clear();
  const ok = f.run(f.checkout, ["ls", "--project", "demo", "--all"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /t1 .*Task t1/);
});
