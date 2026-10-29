// Atelier 2.0, task 11 (t406; design-branches-2026-10-28.md, section 5,
// steps 4 to 7): a project's repository moves to the Studio server with
// `atelier projects move-host`, an open task's work with `atelier migrate
// tN`, and during the bake each landing pushes the project's branch back to
// the old baseline. A local bare repository stands in for the Artifacts
// baseline and another for a task's fork; the project's Ledger is the 1.0
// dump test/fixtures/ledger-v1.0-relic.json, imported first as the
// cut-over does. Everything runs through the real CLI, the real server and
// its real pre-receive hook, with the real git client. Every credential is
// a dummy.
import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";
import { makeV1History } from "./helpers/v1-history.mjs";
import { criteriaOf } from "../src/criteria.ts";

const OWNER = "atl_00112233445566778899aabbccddeeff00112233";
const ACTING = "claude-code/opus-5.5";
const HOLDER = "claude-code/opus-5.5";
const SOURCE_TOKEN = "artifacts-read-token-0123456789abcdef";
const FIXTURE = new URL("./fixtures/ledger-v1.0-relic.json", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "atelier-move-host-"));
after(() => rmSync(root, { recursive: true, force: true }));

const gitEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
for (const k of Object.keys(gitEnv)) if (k.startsWith("ATELIER_") || k.startsWith("GIT_CONFIG_")) delete gitEnv[k];
gitEnv.GIT_CONFIG_NOSYSTEM = "1";
const git = (cwd, ...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const netGit = (cwd, ...args) => new Promise((ok) => execFile("git", ["-c", "credential.helper=", ...args], { cwd, env: gitEnv, encoding: "utf8", timeout: 60_000 },
  (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, stdout: stdout.trim(), stderr })));
const bearer = (token) => ["-c", `http.extraHeader=Authorization: Bearer ${token}`];

let server, base, agentToken;
const cache = join(root, "cache");
const cli = (argv, { token = OWNER, env = {}, cwd = root } = {}) => new Promise((ok) => execFile(process.execPath, [join(process.cwd(), "cli/atelier.mjs"), ...argv], {
  cwd, encoding: "utf8", timeout: 120_000,
  env: { ...gitEnv, ATELIER_CONFIG_DIR: join(root, "config"), ATELIER_CACHE: cache, ATELIER_TOKEN: token, ATELIER_SERVER: base, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: ACTING, ...env },
}, (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
const api = async (method, path, body, token = OWNER, actor = "owner") => {
  const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": actor, ...(token === OWNER ? { "x-atelier-acting": ACTING } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const L = () => server.namespace.get(server.namespace.idFromName("project:relic"));
const bare = () => join(root, "data", "repos", "relic.git");
const tipOf = (dir, ref) => { try { return git(dir, "rev-parse", "--verify", "--quiet", ref); } catch { return null; } };
const events = async (kind) => (await L().dumpRows("events")).rows.filter((r) => r[4] === kind).map((r) => ({ item: r[1], actor: r[3], data: JSON.parse(r[5]) }));

// The old host: the Artifacts baseline of relic (main, Atelier's notes and a
// tag) and t2's fork, whose main is one commit past the baseline's.
const history = join(root, "history");
const artifacts = join(root, "artifacts", "relic.git");
const fork = join(root, "artifacts", "relic-t2.git");
let c;

before(async () => {
  c = makeV1History(history);
  git(history, "notes", "--ref=atelier", "add", "-m", "landed on 1.x", c.main);
  git(history, "tag", "v0.1", c.first);
  git(root, "init", "-q", "--bare", "-b", "main", artifacts);
  git(history, "push", "-q", artifacts, "main:refs/heads/main", "refs/notes/atelier:refs/notes/atelier", "refs/tags/v0.1:refs/tags/v0.1");
  git(root, "init", "-q", "--bare", "-b", "main", fork);
  git(history, "push", "-q", fork, "fork:refs/heads/main");
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER } });
  base = server.url.replace("localhost", "127.0.0.1");
  assert.equal((await cli(["login", "--server", base])).code, 0);
  const imported = await cli(["ledger", "import", "--file", FIXTURE, "--project", "relic"]);
  assert.equal(imported.code, 0, `${imported.stdout}\n${imported.stderr}`);
  agentToken = (await api("POST", "/tokens", { actor: HOLDER, projects: ["relic"] })).body.token;
  assert.ok(agentToken);
});
after(async () => { await server?.close(); });

test("before the move, a claim of a task on an Artifacts fork and a Git credential for it are refused, each naming atelier migrate", async () => {
  const claim = await cli(["claim", "t2", "--as", HOLDER, "--project", "relic"], { token: agentToken });
  assert.notEqual(claim.code, 0);
  assert.match(claim.stderr, /fork_elsewhere: t2's workspace is relic-t2, a fork on Artifacts/);
  assert.match(claim.stderr, /next: only the developer can: atelier migrate t2 --from REMOTE, then run atelier claim t2 --as claude-code\/opus-5\.5/);
  const grant = await api("POST", "/projects/relic/git-token", { kind: "task", item: "t2" }, agentToken, HOLDER);
  assert.equal(grant.status, 409);
  assert.equal(grant.body.error, "fork_elsewhere");
  assert.match(grant.body.next, /atelier migrate t2/);
});

test("move-host mirrors the baseline's branch, notes and tags into the project's repository, the branch verified equal; a re-run carries what changed since, and a diverged remote is refused", async () => {
  const r = await cli(["projects", "move-host", "relic", "--from", artifacts, "--token-env", "RELIC_SOURCE", "--way-back", "--project", "relic"], { env: { RELIC_SOURCE: SOURCE_TOKEN } });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, new RegExp(`relic's repository on 127\\.0\\.0\\.1:\\d+ now holds main @ ${c.main.slice(0, 8)}, equal to .*relic\\.git's`));
  assert.match(r.stdout, /Notes: created; tags: 1\./);
  assert.match(r.stdout, /each landing pushes main back to .*relic\.git/);
  assert.equal(tipOf(bare(), "refs/heads/main"), c.main);
  assert.equal(tipOf(bare(), "refs/notes/atelier"), tipOf(artifacts, "refs/notes/atelier"));
  assert.equal(tipOf(bare(), "refs/tags/v0.1"), c.first);
  assert.equal(readFileSync(join(bare(), "HEAD"), "utf8").trim(), "ref: refs/heads/main");
  assert.equal(git(bare(), "config", "core.hooksPath"), server.git.hooksDir, "the repository names the server's hooks");
  assert.deepEqual(git(bare(), "for-each-ref", "--format=%(refname)", "refs/atelier-move"), "", "no staging ref is left");
  const moved = await events("project.host_moved");
  assert.equal(moved.length, 1);
  assert.equal(moved[0].data.moved, "created");
  assert.equal(moved[0].data.head, c.main);
  assert.equal(moved[0].data.acting, ACTING, "the developer token's write names the acting model (G18)");
  // The old host's token is in no event, no answer and no log of the
  // Ledger; the way back keeps it in a file of the server's, mode 600.
  assert.doesNotMatch(JSON.stringify((await L().dumpRows("events")).rows), new RegExp(SOURCE_TOKEN));
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(SOURCE_TOKEN));
  const kept = join(root, "data", "way-back", "relic.json");
  assert.equal(statSync(kept).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(kept, "utf8")).token, SOURCE_TOKEN);

  // Between the rehearsal and the cut-over the old baseline moved on: a
  // second run moves the branch on, and reads the prose standard the 1.x
  // Ledger never stored.
  writeFileSync(join(history, "README.md"), "# relic\n\nMoved.\n");
  execFileSync("mkdir", ["-p", join(history, "docs")]);
  writeFileSync(join(history, "docs", "style.md"), "# Style\n\nPlain words.\n");
  git(history, "add", ".");
  git(history, "commit", "-q", "-m", "after the rehearsal");
  const later = git(history, "rev-parse", "HEAD");
  git(history, "push", "-q", artifacts, "main:refs/heads/main");
  const again = await cli(["projects", "move-host", "relic", "--from", artifacts, "--project", "relic"]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, new RegExp(`moved main on from ${c.main.slice(0, 8)} to ${later.slice(0, 8)}`));
  assert.match(again.stdout, /prose standard's text was read from docs\/style\.md/);
  assert.equal(tipOf(bare(), "refs/heads/main"), later);
  assert.equal(await L().proseStandardText(), "# Style\n\nPlain words.\n");
  assert.ok(existsSync(kept), "a re-run without --way-back keeps the way back it had");

  // A remote whose branch this server's history already holds moves nothing.
  const older = join(root, "artifacts", "older.git");
  git(root, "init", "-q", "--bare", "-b", "main", older);
  git(history, "push", "-q", older, `${c.main}:refs/heads/main`);
  const behind = await cli(["projects", "move-host", "relic", "--from", older, "--project", "relic"]);
  assert.equal(behind.code, 0, behind.stderr);
  assert.match(behind.stdout, /already holds .*nothing moved/);
  assert.equal(tipOf(bare(), "refs/heads/main"), later);

  // One whose branch has moved apart from this server's is refused.
  const other = join(root, "other");
  git(root, "init", "-q", "-b", "main", other);
  writeFileSync(join(other, "x.txt"), "x\n");
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "unrelated");
  const apart = join(root, "artifacts", "apart.git");
  git(root, "init", "-q", "--bare", "-b", "main", apart);
  git(other, "push", "-q", apart, "main:refs/heads/main");
  const refused = await cli(["projects", "move-host", "relic", "--from", apart, "--project", "relic"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /diverged: main here .* and on the remote .* have each moved apart/);
  assert.match(refused.stderr, /next: only the developer can:/);
  assert.equal(tipOf(bare(), "refs/heads/main"), later);
  // A remote with credentials in it, or another transport, is refused before anything is fetched.
  const creds = await api("POST", "/projects/relic/move-host", { remote: "https://user:secret@artifacts.example/relic.git" });
  assert.equal(creds.body.error, "bad_remote");
  assert.ok(creds.body.next);
  assert.equal((await api("POST", "/projects/relic/move-host", { remote: "ext::sh -c touch% /tmp/x" })).body.error, "bad_remote");
});

test("migrate carries an open task: its fork's work becomes t/N at the recorded head, its claim stands, and the holder's next claim clones and pushes t/N through the hook", async () => {
  // A task whose fork does not hold its recorded head is refused.
  const missing = await cli(["migrate", "t3", "--from", artifacts, "--project", "relic"]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, new RegExp(`head_missing: refs/heads/main on the remote is at .*, whose history does not hold the recorded head ${c.fork.slice(0, 8)}`));
  assert.match(missing.stderr, /next: name the fork that holds/);
  assert.equal(tipOf(bare(), "refs/heads/t/3"), null);

  const r = await cli(["migrate", "t2", "--from", fork, "--token-env", "RELIC_SOURCE", "--project", "relic"], { env: { RELIC_SOURCE: SOURCE_TOKEN } });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, new RegExp(`t2 moved to t/2 @ ${c.fork.slice(0, 8)} in relic's repository`));
  assert.match(r.stdout, /next: the holder runs atelier claim t2 --as claude-code\/opus-5\.5/);
  assert.equal(tipOf(bare(), "refs/heads/t/2"), c.fork);
  const item = await L().item("t2");
  assert.equal(item.fork, "relic/t/2");
  assert.equal(item.owner, HOLDER, "the claim stands");
  assert.equal(item.state, "claimed");
  assert.equal(item.head, c.fork, "and the head");
  assert.equal(item.base, c.main);
  const migrated = await events("item.migrated");
  assert.deepEqual(migrated.map((e) => [e.item, e.data.from, e.data.fork, e.data.head, e.data.acting]), [["t2", "relic-t2", "relic/t/2", c.fork, ACTING]]);
  assert.doesNotMatch(JSON.stringify(migrated), new RegExp(SOURCE_TOKEN));
  // Run again, it moves nothing.
  const again = await cli(["migrate", "t2", "--from", fork, "--project", "relic"]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already on t\/2 .* nothing moved/);

  // The holder claims again: the claim mints a task grant in place of the
  // Artifacts token, and the workspace is a clone of t/2 at the head.
  const claimed = await cli(["claim", "t2", "--as", HOLDER, "--project", "relic"], { token: agentToken });
  assert.equal(claimed.code, 0, `${claimed.stdout}\n${claimed.stderr}`);
  assert.match(await L().tokenId("t2"), /^git:[0-9a-f]{64}$/);
  const dir = join(cache, "work", "relic", "t2");
  assert.equal(git(dir, "rev-parse", "HEAD"), c.fork);
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "t/2");
  writeFileSync(join(dir, "b.txt"), "two, revised\n");
  git(dir, "add", "b.txt");
  git(dir, "commit", "-q", "-m", "t2: revise b");
  const pushed = await cli(["push", "t2", "--as", HOLDER, "--project", "relic"], { token: agentToken, cwd: dir });
  assert.equal(pushed.code, 0, `${pushed.stdout}\n${pushed.stderr}`);
  const head = git(dir, "rev-parse", "HEAD");
  assert.equal(tipOf(bare(), "refs/heads/t/2"), head);
  assert.equal((await L().item("t2")).head, head);
});

test("during the bake a landing's recorded merge pushes main back to the old baseline; --push-back retries and --end-bake ends it", async () => {
  const item = await L().item("t2");
  const head = item.head;
  // The landing, step by step as atelier merge --landing makes it: submit,
  // accept, the landing lease, a landing grant, the
  // merge pushed to main through the hook, and the merge recorded.
  assert.equal((await api("POST", "/projects/relic/items/t2/submit", { summary: "b revised" }, agentToken, HOLDER)).status, 200);
  // The head's check and an independent review, recorded through the Ledger
  // as the landing tests record them.
  await L().addEvidence({ itemId: "t2", claim: "npm test", grade: "observed", head, passed: true, by: HOLDER, at: new Date().toISOString(), changedPaths: ["b.txt"] });
  await L().addReview({ itemId: "t2", by: "codex/gpt-6-astra", head, approve: true, criteria: criteriaOf(await L().item("t2")), note: "Fine", at: new Date().toISOString() }, undefined, true);
  const accepted = await api("POST", "/projects/relic/items/t2/accept", { head });
  assert.ok(accepted.status < 300, JSON.stringify(accepted.body));
  const lease = await api("POST", "/projects/relic/landing-lease", { item: "t2" });
  assert.ok(lease.status < 300, JSON.stringify(lease.body));
  const grant = await api("POST", "/projects/relic/git-token", { kind: "landing", item: "t2", head });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  const work = join(root, "landing");
  const remote = `${base}/git/relic.git`;
  assert.equal((await netGit(root, ...bearer(OWNER), "clone", "-q", "--branch", "main", remote, work)).code, 0);
  assert.equal((await netGit(work, ...bearer(OWNER), "fetch", "-q", remote, "refs/heads/t/2")).code, 0);
  git(work, "merge", "-q", "--no-ff", "-m", "Merge t2", "FETCH_HEAD");
  const merge = git(work, "rev-parse", "HEAD");
  const landed = await netGit(work, ...bearer(grant.body.token), "push", remote, "HEAD:refs/heads/main");
  assert.equal(landed.code, 0, landed.stderr);
  const recorded = await api("POST", "/projects/relic/items/t2/merged", { mergeCommit: merge });
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal(recorded.body.state, "merged");
  assert.equal(recorded.body.wayBack.state, "pushed");
  assert.equal(tipOf(artifacts, "refs/heads/main"), merge, "the old baseline holds the landing");
  const back = await events("project.way_back");
  assert.equal(back.at(-1).data.state, "pushed");
  assert.equal(back.at(-1).data.head, merge);

  // Someone moved the old baseline: the push back is refused, recorded, and
  // retried by hand once it is put right.
  git(history, "fetch", "-q", artifacts, "main");
  git(history, "checkout", "-q", "-B", "elsewhere", "FETCH_HEAD");
  writeFileSync(join(history, "c.txt"), "moved by hand\n");
  git(history, "add", "c.txt");
  git(history, "commit", "-q", "-m", "a commit made on the old host");
  git(history, "push", "-q", artifacts, "HEAD:refs/heads/main");
  const retry = await cli(["projects", "move-host", "relic", "--push-back", "--project", "relic"]);
  assert.notEqual(retry.code, 0);
  assert.match(retry.stderr, /push_back_failed: main was not pushed back to .*relic\.git/);
  assert.match(retry.stderr, /next: check the old baseline and its token, then run atelier projects move-host relic --push-back/);
  assert.equal((await events("project.way_back")).at(-1).data.state, "failed");
  git(history, "push", "-q", "--force", artifacts, `${merge}:refs/heads/main`);
  const ok = await cli(["projects", "move-host", "relic", "--push-back", "--project", "relic"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, new RegExp(`main @ ${merge.slice(0, 8)} pushed back to`));

  const ended = await cli(["projects", "move-host", "relic", "--end-bake", "--project", "relic"]);
  assert.equal(ended.code, 0, ended.stderr);
  assert.match(ended.stdout, /the way back is forgotten/);
  assert.ok(!existsSync(join(root, "data", "way-back", "relic.json")), "the old host's token is gone");
  const none = await cli(["projects", "move-host", "relic", "--push-back", "--project", "relic"]);
  assert.match(none.stderr, /no_way_back: relic keeps no way back on this server/);
});

test("the old host's token reaches git as a header over HTTP, and a fetch without it is refused, naming no token", async () => {
  // This server's own repository of relic stands in for an Artifacts
  // baseline over HTTP: it answers 401 without a credential.
  const { mirrorBranch } = await import("../src/git/move.mjs");
  const into = join(root, "over-http.git");
  git(root, "init", "-q", "--bare", "-b", "main", into);
  const remote = `${base}/git/relic.git`;
  await assert.rejects(mirrorBranch({ dir: into, branch: "main", remote, token: null }), /401|Authentication|could not read/i);
  const wrong = await mirrorBranch({ dir: into, branch: "main", remote, token: "atl_wrong" }).catch((error) => error);
  assert.ok(wrong instanceof Error);
  assert.doesNotMatch(wrong.message, /atl_wrong/);
  const done = await mirrorBranch({ dir: into, branch: "main", remote, token: OWNER });
  assert.equal(done.moved, "created");
  assert.equal(tipOf(into, "refs/heads/main"), tipOf(bare(), "refs/heads/main"));
  assert.doesNotMatch(readFileSync(join(into, "config"), "utf8"), /Bearer|atl_/, "nothing of the token is written to the repository");
  // A project whose record names no branch takes the remote's HEAD branch.
  const unnamed = join(root, "unnamed.git");
  git(root, "init", "-q", "--bare", "-b", "main", unnamed);
  const taken = await mirrorBranch({ dir: unnamed, branch: null, remote: artifacts, token: null });
  assert.equal(taken.branch, "main");
  assert.equal(tipOf(unnamed, "refs/heads/main"), tipOf(artifacts, "refs/heads/main"));
});
