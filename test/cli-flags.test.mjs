import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { noProjectMessage, parseArgs, unregisteredMessage } from "../cli/atelier.mjs";

// How the CLI reads its flags. A switch (--approve, --cancel, --json,
// --sandbox-only) never takes the word after it, so an item id written after
// one is the item id; a flag that needs a value refuses a bare one before any
// request; a flag a command does not take is refused the same way. The
// commands run against a fake server: a preload replaces fetch, answers every
// route from local state and logs each request, and the server named in the
// configuration cannot be reached even if the preload were bypassed.

const cli = resolve("cli/atelier.mjs");

test("parseArgs: a switch keeps the next word as a positional, a text flag takes it", () => {
  const review = parseArgs(["review", "--approve", "t2", "--note", "fine"]);
  assert.deepEqual(review._, ["review", "t2"]);
  assert.equal(review.approve, true);
  assert.equal(review.note, "fine");
  assert.deepEqual([review.bare, review.problems], [[], []]);
  // The words true and false, and only those, set a switch.
  assert.equal(parseArgs(["init", "--sandbox-only", "false"])["sandbox-only"], false);
  assert.deepEqual(parseArgs(["init", "--sandbox-only", "false"])._, ["init"]);
  assert.equal(parseArgs(["init", "--sandbox-only=false"])["sandbox-only"], false);
  assert.equal(parseArgs(["init", "--sandbox-only=true"])["sandbox-only"], true);
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

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-flags-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  const identity = (cwd) => { git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "test@example.invalid"); };
  // The owner's checkout, the baseline it was copied to, and the task fork.
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  identity(checkout);
  writeFileSync(join(checkout, "STATE.md"), "Current state\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "Initial");
  const head = git(checkout, "rev-parse", "HEAD");
  const baseline = join(dir, "baseline.git");
  git(dir, "init", "-q", "--bare", "-b", "main", baseline);
  git(checkout, "push", "-q", baseline, "main");
  const fork = join(dir, "fork.git");
  git(dir, "clone", "-q", "--bare", baseline, fork);
  // t1's workspace, as a claim leaves it: the clone records its project, item and actor.
  const workspace = join(dir, "cache", "work", "demo", "t1");
  mkdirSync(join(dir, "cache", "work", "demo"), { recursive: true });
  git(dir, "clone", "-q", fork, workspace);
  identity(workspace);
  for (const [k, v] of Object.entries({ project: "demo", item: "t1", actor: "codex/test", branch: "main" })) git(workspace, "config", "--local", `atelier.${k}`, v);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", owner: "owner", ownerName: "Pavi", projects: { demo: { path: checkout, branch: "main" } } }));
  const log = join(dir, "requests.jsonl");
  const preload = join(dir, "server.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
const HEAD = ${JSON.stringify(head)}, BASELINE = ${JSON.stringify(baseline)};
const TIMES = { createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-10-05T09:30:00.000Z", lastPushAt: "2026-10-05T09:00:00.000Z" };
// t3 is open and held by nobody; every other item is submitted by codex/test.
const item = (id) => ({ id, title: "Task " + id, scope: [], state: id === "t3" ? "open" : "submitted", owner: id === "t3" ? null : "codex/test", head: HEAD, acceptedHead: null, base: HEAD, fork: "demo-" + id, dispatch: null, ...TIMES });
const detail = (id) => ({ item: item(id), policy: { checks: ["exit 0"], protected: [], sandboxOnly: false }, gate: { ready: true, blockers: [] }, evidence: [], reviews: [], events: [], acceptanceProtected: [] });
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname, method = options.method ?? "GET";
  const body = options.body ? JSON.parse(options.body) : undefined;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, path, body, actor: options.headers?.["x-atelier-actor"] ?? null }) + "\\n");
  let data = {};
  const m = /^\\/api\\/projects\\/demo(?:\\/(.*))?$/.exec(path);
  if (path === "/api/config") data = { ownerActor: "owner", ownerName: "Pavi" };
  else if (path === "/api/projects") data = [{ name: "demo", title: "Demo" }];
  else if (path === "/api/inbox") data = [];
  else if (m) {
    const rest = m[1] ?? "";
    const project = { name: "demo", title: "Demo", repo: "demo", policy: { checks: body?.checks ?? ["exit 0"], protected: body?.protected ?? [], eligible: [], refuseOverlap: body?.refuseOverlap ?? false, sandboxOnly: body?.sandboxOnly ?? false } };
    if (rest === "" && method === "GET") data = { project, items: [item("t1"), item("t2")], events: [] };
    else if (rest === "" && method === "PUT") data = { project, baseline: { remote: BASELINE, token: "fake-baseline-token", defaultBranch: "main" } };
    else if (rest === "items" && method === "POST") data = { id: "t9", title: body.title, scope: body.scope };
    else {
      const [, id, verb] = /^items\\/([^/]+)(?:\\/(.*))?$/.exec(rest) ?? [];
      if (verb === "handoff") data = { item: { ...item(id), owner: body.to }, next: "next" };
      else if (verb === "dispatch") data = { ...item(id), dispatch: { to: body.to ?? "any" } };
      else if (verb === "block") data = { ...item(id), state: "blocked", blocked: { reason: body.reason, by: "codex/test" } };
      else if (verb === "unblock") data = { ...item(id), state: "claimed" };
      else if (verb === "edit") data = { ...item(id), ...body };
      else data = detail(id);
    }
  }
  // Any other project is one the server does not know, as the Worker answers it.
  const status = !m && path.startsWith("/api/projects/") ? 404 : 200;
  if (status === 404) data = { error: "no_project", detail: "project not initialised; run atelier init" };
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
};
`);
  const run = (cwd, args, env = {}) => spawnSync(process.execPath, ["--import", preload, cli, ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "fake-owner-token", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "owner", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  const requests = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
  const clear = () => rmSync(log, { force: true });
  return { dir, checkout, workspace, run, requests, clear, head };
}

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
    return { sandboxOnly: put.body.sandboxOnly, refuseOverlap: put.body.refuseOverlap };
  };
  assert.deepEqual(sent(["--sandbox-only"]), { sandboxOnly: true, refuseOverlap: undefined });
  assert.deepEqual(sent(["--sandbox-only", "false"]), { sandboxOnly: false, refuseOverlap: undefined });
  assert.deepEqual(sent(["--sandbox-only=false", "--refuse-overlap"]), { sandboxOnly: false, refuseOverlap: true });
  assert.deepEqual(sent(["--refuse-overlap", "false"]), { sandboxOnly: undefined, refuseOverlap: false });
  assert.deepEqual(sent([]), { sandboxOnly: undefined, refuseOverlap: undefined });
  f.clear();
  const bad = f.run(f.checkout, ["init", "--sandbox-only=yes"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--sandbox-only takes no value: write --sandbox-only, or --sandbox-only=false to turn it off/);
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
  assert.deepEqual(f.requests().map((q) => q.body), [{ title: "Plain", scope: [] }]);
  f.clear();
  for (const [argv, message] of [
    [["new", "Title", "--non-goal", "", "--project", "demo"], /--non-goal needs text: atelier new --non-goal "TEXT", once per entry/],
    [["new", "Title", "--stop-when", "  ", "--project", "demo"], /--stop-when needs text: atelier new --stop-when "TEXT", once per entry/],
    [["new", "Title", "--next-gate", "--project", "demo"], /--next-gate needs text: atelier new --next-gate "TEXT"/],
    [["new", "Title", "--next-gate", "  ", "--project", "demo"], /--next-gate needs text: atelier new --next-gate "TEXT"/],
    [["edit", "t1", "--project", "demo"], /usage: atelier edit ID \[--non-goal TEXT\]/],
    [["edit", "t1", "--non-goal", "", "--non-goal", "x", "--project", "demo"], /--non-goal needs text: atelier edit ID --non-goal "TEXT", once per entry, or --non-goal "" alone to clear/],
    [["edit", "t1", "--scope", "src/**", "--project", "demo"], /edit does not take --scope/],
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
  // block takes the id first when given, else the workspace's item; the reason is the words after it.
  const blocked = f.run(f.checkout, ["block", "t2", "waiting", "on", "the", "keys", "--project", "demo"]);
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.deepEqual(f.requests().map((q) => [q.path, q.body]), [["/api/projects/demo/items/t2/block", { reason: "waiting on the keys" }]]);
  assert.match(blocked.stdout, /^t2 is blocked: waiting on the keys\. It keeps its owner and workspace; run atelier unblock t2 when it can go on\.\n$/);
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
