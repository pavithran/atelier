import { SERVER_CAPABILITIES } from "../src/route-level.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The t105 audit's gl-force-push.sh, run through the CLI. A holds t3 and
// pushes H1; after a handoff B pushes H2 to the same fork; main moves; the
// task comes back to A, whose workspace still ends at H1. Re-claiming,
// updating and pushing with --force must keep B's commit on the fork. Every
// command runs against a fake server: fetch is replaced by a preload that
// answers from local bare repositories and logs each request, and the
// server name cannot resolve.

const cli = resolve("cli/atelier.mjs");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-force-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  const identity = (cwd) => { git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "test@example.invalid"); };
  const commit = (cwd, file, subject) => { writeFileSync(join(cwd, file), `${subject}\n`); git(cwd, "add", "."); git(cwd, "commit", "-qm", subject); return git(cwd, "rev-parse", "HEAD"); };

  // The baseline and the fork, seeded with one commit; the owner's checkout
  // is the seed clone.
  const baseline = join(dir, "baseline.git"), fork = join(dir, "fork.git"), seed = join(dir, "seed");
  git(dir, "init", "-q", "--bare", "-b", "main", baseline);
  git(dir, "init", "-q", "--bare", "-b", "main", fork);
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  identity(seed);
  const base = commit(seed, "base.txt", "Base");
  git(seed, "remote", "add", "origin", baseline);
  git(seed, "push", "-q", "origin", "main");
  git(seed, "push", "-q", fork, "main:main");

  // A's workspace, as claimWorkspace leaves it; A pushes H1.
  const workspace = join(dir, "cache", "work", "demo", "t3");
  mkdirSync(join(dir, "cache", "work", "demo"), { recursive: true });
  git(dir, "clone", "-q", fork, workspace);
  identity(workspace);
  for (const [k, v] of Object.entries({ project: "demo", item: "t3", actor: "codex/a", branch: "main" })) git(workspace, "config", "--local", `atelier.${k}`, v);
  const h1 = commit(workspace, "a.txt", "A: H1");
  git(workspace, "push", "-q", "origin", "HEAD:main");

  // B, on another machine, clones the fork at H1 and pushes H2; then main moves.
  const other = join(dir, "B");
  git(dir, "clone", "-q", fork, other);
  identity(other);
  const h2 = commit(other, "b.txt", "B: H2");
  git(other, "push", "-q", "origin", "HEAD:main");
  const moved = commit(seed, "main.txt", "Main moved");
  git(seed, "push", "-q", "origin", "main");

  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", owner: "owner", ownerName: "Pavi", projects: { demo: { path: seed, branch: "main" } } }));
  const log = join(dir, "requests.jsonl");
  const preload = join(dir, "server.mjs");
  // The item's head is what the fork's branch holds, as the Worker reads it
  // from Artifacts, unless FAKE_RECORDED_HEAD says the Ledger is behind.
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const BASE = ${JSON.stringify(base)}, BASELINE = ${JSON.stringify(baseline)}, FORK = ${JSON.stringify(fork)};
const forkHead = () => execFileSync("git", ["--git-dir", FORK, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
const item = () => ({ id: "t3", title: "Task three", scope: [], state: "claimed", owner: "codex/a", head: process.env.FAKE_RECORDED_HEAD ?? forkHead(), acceptedHead: null, base: BASE, fork: "demo-t3", dispatch: null });
globalThis.fetch = async (url, options = {}) => {
  if (new URL(url).pathname === "/api/version") return Response.json({ capabilities: ${JSON.stringify(SERVER_CAPABILITIES)} });
  const path = new URL(url).pathname, method = options.method ?? "GET";
  const body = options.body ? JSON.parse(options.body) : undefined;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, path, body }) + "\\n");
  let data = {};
  const verb = /^\\/api\\/projects\\/demo\\/(?:items\\/t3\\/)?(.*)$/.exec(path)?.[1];
  if (path === "/api/config") data = { ownerActor: "owner", ownerName: "Pavi" };
  else if (verb === "baseline-token" || verb === "base-token") data = { remote: BASELINE, token: "fake-baseline-token", defaultBranch: "main" };
  else if (verb === "claim") data = { item: item(), workspace: { remote: FORK, token: "fake-fork-token", defaultBranch: "main", expiresAt: "later" }, baseline: { remote: BASELINE, token: "fake-baseline-token", defaultBranch: "main" } };
  else if (verb === "push") data = { ...item(), head: forkHead() };
  else data = { item: item(), policy: { checks: [], protected: [], sandboxOnly: false }, gate: { ready: true, blockers: [] }, evidence: [], reviews: [], events: [], acceptanceProtected: [] };
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
};
`);
  const run = (args, env = {}) => spawnSync(process.execPath, ["--import", preload, cli, ...args], {
    cwd: workspace, encoding: "utf8",
    env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "fake-owner-token", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "codex/a", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  const pushes = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : []).filter((q) => q.path.endsWith("/push")).map((q) => q.body);
  const forkMain = () => git(dir, "--git-dir", fork, "rev-parse", "refs/heads/main");
  const forkHolds = (sha) => spawnSync("git", ["--git-dir", fork, "merge-base", "--is-ancestor", sha, "refs/heads/main"]).status === 0;
  // The commits reachable from `sha` that the fork's branch holds neither as
  // themselves nor as a replayed copy: what a rebase and a force push lost.
  const forkDropped = (sha) => git(dir, "--git-dir", fork, "rev-list", "--cherry-pick", "--left-only", "--no-merges", "--format=%s", `${sha}...refs/heads/main`).split("\n").filter((line) => line && !line.startsWith("commit "));
  const subjects = (cwd, ref) => git(cwd, "log", "--format=%s", ref).split("\n");
  const forkSubjects = () => git(dir, "--git-dir", fork, "log", "--format=%s", "refs/heads/main").split("\n");
  return { dir, workspace, fork, base, h1, h2, moved, git, commit, run, pushes, forkMain, forkHolds, forkDropped, subjects, forkSubjects };
}

test("a re-claim takes the commits the fork gained, update keeps them on the new baseline, and push --force declares the rebase", (t) => {
  const f = fixture(t);
  assert.equal(f.forkMain(), f.h2);
  const claimed = f.run(["claim", "t3", "--project", "demo"]);
  assert.equal(claimed.status, 0, claimed.stderr);
  assert.match(claimed.stdout, /This workspace was behind t3's fork; it now holds the 1 commit pushed there since:\n\w+ B: H2/);
  assert.equal(f.git(f.workspace, "rev-parse", "HEAD"), f.h2);

  const updated = f.run(["update"]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(updated.stdout, new RegExp(`t3 rebased onto baseline ${f.moved.slice(0, 8)}\\. Push with: atelier push --force`));
  assert.deepEqual(f.subjects(f.workspace, "HEAD"), ["B: H2", "A: H1", "Main moved", "Base"]);

  const pushed = f.run(["push", "--force"]);
  assert.equal(pushed.status, 0, pushed.stderr);
  // B's commit is replayed onto the moved baseline, so it survives by patch, not by hash.
  assert.deepEqual(f.forkDropped(f.h2), [], `B's work is gone from the fork's branch`);
  assert.deepEqual(f.forkSubjects(), ["B: H2", "A: H1", "Main moved", "Base"]);
  assert.ok(f.forkHolds(f.moved), "the fork does not hold the moved baseline");
  assert.equal(f.forkMain(), f.git(f.workspace, "rev-parse", "HEAD"));
  assert.deepEqual(f.pushes(), [{ head: f.forkMain(), rebasedFrom: f.h2 }]);
});

test("update puts this workspace's own commits on the fork's head before the baseline, so push --force keeps both", (t) => {
  const f = fixture(t);
  f.commit(f.workspace, "local.txt", "A: local, unpushed");
  const updated = f.run(["update"]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(updated.stdout, /t3: this workspace's commits now sit on the 1 commit the fork held that it lacked:\n\w+ B: H2/);
  assert.deepEqual(f.subjects(f.workspace, "HEAD"), ["A: local, unpushed", "B: H2", "A: H1", "Main moved", "Base"]);
  const pushed = f.run(["push", "--force"]);
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.deepEqual(f.forkDropped(f.h2), [], "B's work is gone from the fork's branch");
  assert.deepEqual(f.forkSubjects(), ["A: local, unpushed", "B: H2", "A: H1", "Main moved", "Base"]);
  assert.equal(f.forkMain(), f.git(f.workspace, "rev-parse", "HEAD"));
});

test("update stopped on a conflict names the same push as a finished update", (t) => {
  const f = fixture(t);
  // The baseline and this workspace change base.txt differently.
  const seed = join(f.dir, "seed");
  f.commit(seed, "base.txt", "Main: base changed");
  f.git(seed, "push", "-q", "origin", "main");
  f.commit(f.workspace, "base.txt", "A: base changed");
  const r = f.run(["update"]);
  assert.notEqual(r.status, 0, "update went ahead through a conflict");
  assert.match(r.stderr, /^atelier: rebase stopped on a conflict\. Resolve it, then git rebase --continue\. Push with: atelier push --force$/m);
  assert.ok(existsSync(join(f.workspace, ".git", "rebase-merge")), "the rebase is left for the agent to finish");
  assert.match(f.git(f.workspace, "ls-files", "-u"), /base\.txt/);
  assert.deepEqual(f.pushes(), []);
});

test("update after a committed conflict merge of the baseline does nothing and says so (t686: it rebased the task's commit again)", (t) => {
  const f = fixture(t);
  const seed = join(f.dir, "seed");
  f.commit(seed, "base.txt", "Main: base changed");
  f.git(seed, "push", "-q", "origin", "main");
  // The workspace is in step with the fork, then changes base.txt too.
  f.git(f.workspace, "fetch", "-q", "origin");
  f.git(f.workspace, "reset", "-q", "--hard", f.h2);
  f.commit(f.workspace, "base.txt", "A: base changed");
  // The agent resolves the conflict by merging the baseline by hand, as update asked.
  f.git(f.workspace, "fetch", "-q", join(f.dir, "baseline.git"), "main");
  assert.throws(() => f.git(f.workspace, "merge", "--no-edit", "FETCH_HEAD"));
  writeFileSync(join(f.workspace, "base.txt"), "resolved\n");
  f.git(f.workspace, "add", "base.txt");
  f.git(f.workspace, "commit", "-qm", "Merge baseline");
  const head = f.git(f.workspace, "rev-parse", "HEAD");
  const r = f.run(["update"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^t3 already holds baseline \w+; nothing to update\.$/m);
  assert.equal(f.git(f.workspace, "rev-parse", "HEAD"), head);
  assert.ok(!existsSync(join(f.workspace, ".git", "rebase-merge")), "update started a rebase");
});

test("push --force refuses to drop commits Atelier recorded, whatever the lease would allow", (t) => {
  const f = fixture(t);
  // The old claim's fetch alone: origin/main is H2, the workspace still ends at H1.
  f.git(f.workspace, "fetch", "-q", "origin");
  assert.equal(f.git(f.workspace, "rev-parse", "refs/remotes/origin/main"), f.h2);
  const r = f.run(["push", "--force"]);
  assert.notEqual(r.status, 0, "push --force from a workspace behind the fork went ahead");
  assert.match(r.stderr, /push --force would drop 1 commit Atelier recorded for t3 at \w{8}:\n\w+ B: H2\nRun atelier update to carry them/);
  assert.equal(f.forkMain(), f.h2, "the fork's branch was overwritten");
  assert.deepEqual(f.pushes(), []);
});

test("push --force leases against the head Atelier recorded, not the ref this workspace last fetched", (t) => {
  const f = fixture(t);
  // The workspace has taken H2 and rebased, but the Ledger still records H1:
  // the fork stands past what Atelier knows, so nothing may be forced over it.
  assert.equal(f.run(["update"]).status, 0);
  const r = f.run(["push", "--force"], { FAKE_RECORDED_HEAD: f.h1 });
  assert.notEqual(r.status, 0, "push --force went ahead against a fork past the recorded head");
  assert.match(r.stderr, new RegExp(`t3's fork no longer stands at ${f.h1.slice(0, 8)}, the head Atelier recorded: something was pushed to it since\\. Run atelier update`));
  assert.equal(f.forkMain(), f.h2);
  assert.deepEqual(f.pushes(), []);
});

test("a claim that finds the workspace and the fork diverged stops and names the fork's commits", (t) => {
  const f = fixture(t);
  const local = f.commit(f.workspace, "local.txt", "A: local, unpushed");
  const r = f.run(["claim", "t3", "--project", "demo"]);
  assert.notEqual(r.status, 0, "the claim went ahead with a diverged workspace");
  assert.match(r.stderr, /t3's fork holds 1 commit this workspace lacks, and this workspace holds commits the fork lacks\. The fork's:\n\w+ B: H2\nPut this workspace's commits on top of them first: cd ".*t3" && git rebase refs\/remotes\/origin\/main, then run atelier claim t3 again/);
  assert.equal(f.git(f.workspace, "rev-parse", "HEAD"), local);
  assert.equal(f.forkMain(), f.h2);
  // After the rebase the claim finds the workspace in step and says nothing about it.
  f.git(f.workspace, "rebase", "-q", "refs/remotes/origin/main");
  const again = f.run(["claim", "t3", "--project", "demo"]);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /behind|lacks/);
});

// The plan integrator's rollback: the workspace is reset to an earlier commit
// of the recorded history, and push --rollback returns the fork there and
// declares the head it replaces, which push --force refuses to do.
test("push --rollback returns the fork to an earlier recorded commit and declares the head it replaces", (t) => {
  const f = fixture(t);
  f.git(f.workspace, "fetch", "-q", "origin");
  f.git(f.workspace, "reset", "-q", "--hard", f.h1);
  const forced = f.run(["push", "--force"]);
  assert.notEqual(forced.status, 0, "push --force dropped a recorded commit");
  const r = f.run(["push", "--rollback"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.forkMain(), f.h1);
  assert.deepEqual(f.pushes(), [{ head: f.h1, rebasedFrom: f.h2 }]);
});

test("push --rollback refuses a head that is not an ancestor of the recorded one, or is the recorded one", (t) => {
  const f = fixture(t);
  f.git(f.workspace, "fetch", "-q", "origin");
  f.git(f.workspace, "reset", "-q", "--hard", f.h2);
  const same = f.run(["push", "--rollback"]);
  assert.notEqual(same.status, 0);
  assert.match(same.stderr, /is at the recorded head/);
  f.git(f.workspace, "reset", "-q", "--hard", f.h1);
  f.commit(f.workspace, "side.txt", "A: a side commit");
  const side = f.run(["push", "--rollback"]);
  assert.notEqual(side.status, 0);
  assert.match(side.stderr, /is not an ancestor of the recorded head/);
  assert.equal(f.forkMain(), f.h2, "the fork's branch was overwritten");
  assert.deepEqual(f.pushes(), []);
});

// ── update through the merge pipeline (t463) ───────────────────────────────

// Both the baseline and this workspace declare command entries one per file
// under cmds/, a generator writing out/index.txt from them, and that index
// routed to the generated driver. The workspace has taken the baseline, and
// the fork holds what the workspace holds.
const GENERATOR = `import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
const names = readdirSync("cmds").sort().map((f) => /^name: (\\S+)/m.exec(readFileSync("cmds/" + f, "utf8"))[1]);
mkdirSync("out", { recursive: true });
writeFileSync("out/index.txt", names.map((n) => n + "\\n").join(""));
`;
function declaring(t) {
  const f = fixture(t);
  const seed = join(f.dir, "seed");
  const manifest = { version: 1, generators: [{ name: "index", command: [process.execPath, "gen.mjs"], inputs: ["cmds/**", "gen.mjs"], outputs: ["out/index.txt"] }], registries: [{ name: "commands", dir: "cmds", key: "^name: (\\S+)" }] };
  mkdirSync(join(seed, "bin")); mkdirSync(join(seed, "cmds"));
  writeFileSync(join(seed, "bin", "merge-manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(seed, ".gitattributes"), "out/index.txt merge=atelier-generated\n");
  writeFileSync(join(seed, "gen.mjs"), GENERATOR);
  writeFileSync(join(seed, "cmds", "help.txt"), "name: help\n");
  const add = (cwd, file, entry, subject) => {
    writeFileSync(join(cwd, "cmds", file), `name: ${entry}\n`);
    execFileSync(process.execPath, ["gen.mjs"], { cwd });
    f.git(cwd, "add", "-A"); f.git(cwd, "commit", "-qm", subject);
    return f.git(cwd, "rev-parse", "HEAD");
  };
  execFileSync(process.execPath, ["gen.mjs"], { cwd: seed });
  f.git(seed, "add", "-A"); f.git(seed, "commit", "-qm", "Declare merges");
  f.git(seed, "push", "-q", "origin", "main");
  f.git(f.workspace, "fetch", "-q", join(f.dir, "baseline.git"), "main");
  f.git(f.workspace, "rebase", "-q", "FETCH_HEAD");
  f.git(f.workspace, "push", "-q", "--force", "origin", "HEAD:main");
  f.git(f.workspace, "fetch", "-q", "origin");
  return { ...f, seed, add };
}

test("update merges independent command additions through the pipeline, regenerating the index a rebase would stop on", (t) => {
  const f = declaring(t);
  f.add(f.seed, "push.txt", "push", "Main adds push");
  f.git(f.seed, "push", "-q", "origin", "main");
  const mine = f.add(f.workspace, "land.txt", "land", "A adds land");
  const r = f.run(["update"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /t3 merged baseline \w{8} through the merge pipeline, which regenerated its outputs\. Push with: atelier push$/m);
  assert.equal(readFileSync(join(f.workspace, "out", "index.txt"), "utf8"), "help\nland\npush\n");
  assert.equal(f.git(f.workspace, "status", "--porcelain"), "");
  assert.deepEqual(f.git(f.workspace, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1), [mine, f.git(f.seed, "rev-parse", "HEAD")]);
  assert.match(f.git(f.workspace, "log", "-1", "--format=%B"), /Atelier-Regenerated: index \(.+ gen\.mjs\): out\/index\.txt matches neither side; log sha256 [0-9a-f]{64}/);
  assert.equal(existsSync(join(f.workspace, ".git", "rebase-merge")), false);
});

test("update refuses a baseline whose registry key this workspace declares too, and moves nothing", (t) => {
  const f = declaring(t);
  f.add(f.seed, "push.txt", "ship", "Main adds ship as push.txt");
  f.git(f.seed, "push", "-q", "origin", "main");
  const mine = f.add(f.workspace, "ship.txt", "ship", "A adds ship");
  const r = f.run(["update"]);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /would leave a declaration problem, so nothing was rebased or merged:\nDeclaration problems:\n {2}the commands registry key ship is declared by both cmds\/push\.txt and cmds\/ship\.txt\n/);
  assert.match(r.stderr, /Fix them in this workspace's own commits .*, commit, and run atelier update again\./);
  assert.equal(f.git(f.workspace, "rev-parse", "HEAD"), mine);
  assert.equal(f.git(f.workspace, "status", "--porcelain"), "");
  assert.equal(existsSync(join(f.workspace, ".git", "rebase-merge")), false);
  assert.equal(existsSync(join(f.workspace, ".git", "MERGE_HEAD")), false);
});

test("update with nothing to regenerate still rebases, through the clone's merge drivers", (t) => {
  const f = declaring(t);
  writeFileSync(join(f.seed, "main-only.txt"), "main\n");
  f.git(f.seed, "add", "-A"); f.git(f.seed, "commit", "-qm", "Main adds a plain file");
  f.git(f.seed, "push", "-q", "origin", "main");
  f.add(f.workspace, "land.txt", "land", "A adds land");
  const r = f.run(["update"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /t3 rebased onto baseline \w{8}\. Push with: atelier push --force/);
  assert.equal(f.git(f.workspace, "rev-list", "--merges", "--count", "HEAD"), "0");
  assert.match(f.git(f.workspace, "config", "--local", "merge.atelier-generated.driver"), /merge-driver\.mjs' generated/);
});

// The help and the docs say what update does now (t463): a preview first,
// a pipeline merge that regenerates and names atelier push where a declared
// generator must run, and a rebase naming push --force only otherwise.
test("update's help and the gate's command table describe the pipeline merge and the rebase, and which push each names", async () => {
  const { default: spec } = await import("../src/usage/commands/update.ts");
  const about = spec.forms[0].about;
  const row = readFileSync(resolve("docs/gate.md"), "utf8").split("\n").find((line) => line.startsWith("| `atelier update` |"));
  for (const text of [about, row]) {
    assert.doesNotMatch(text, /^(\| `atelier update` \| the item's owner \| )?Rebases the workspace/, "update no longer only rebases");
    assert.match(text, /previewed first/);
    assert.match(text, /bin\/merge-manifest\.json/);
    assert.match(text, /merge pipeline[^.]*regenerates the outputs/);
    assert.match(text, /names `atelier push`/);
    assert.match(text, /rebases through the clone's merge drivers and names `atelier push --force`/);
  }
  const usage = JSON.parse(readFileSync(resolve("test/fixtures/cli/usage.json"), "utf8"));
  assert.match(usage.update, /merges through the merge pipeline/);
});
