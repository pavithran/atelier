import { SERVER_CAPABILITIES } from "../src/route-level.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { composeShip, knownKinds, neededKinds, ORDERS, stepEnv } from "../cli/ship.mjs";

// atelier ship and its approvals. The composition is read from files in
// temporary folders. ControlPlane's ship files are retired and never read.
// The command runs end to end in a temporary
// repository against a stand-in server, with a stand-in deploy script, a
// stand-in live site and local bare repositories as the baseline and the
// github remote: nothing here deploys, installs or pushes anywhere real.

const cli = resolve("cli/atelier.mjs");

function files(tree) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-ship-plan-"));
  for (const [path, value] of Object.entries(tree)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof value === "string" ? value : JSON.stringify(value));
  }
  return dir;
}
const plan = (t, tree) => {
  const dir = files(tree);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return composeShip(dir);
};
const outline = (p) => p.steps.map((s) => [s.step, ...s.runs.map((r) => (r.argv ? r.argv.join(" ") : r.request) + (r.kind ? ` [${r.kind}]` : ""))]);

// ControlPlane's ship files as the projects held them: a policy, the adapter
// whose capabilities carried the commands, and a canonical device set.
const CP_FILES = {
  "docs/control-plane/ship-policy.v1.json": { kind: "control-plane.ship-policy", schema_version: 1, application_classes: { web: ORDERS.web }, effect_order: { rule: "compose-from-declared-capabilities", base: ORDERS.other, delivery: {}, precedence: [] }, push: { force: false } },
  "docs/control-plane/project-adapter.v1.json": { capabilities: {
    deploy: { action_class: "deploy", command: ["./cp-deploy"], description: "x" },
    "captioning-run": { action_class: "paid-provider", command: ["./cp-caption"], description: "y" },
  } },
  "docs/control-plane/canonical-device-set.v3.json": { application_class: "web", targets: [] },
};
const WEB_SHIP = { schema_version: 1, kind: "atelier.ship", class: "web", deploy: { run: ["./atelier-deploy"] }, "verify-deploy": { run: ["./atelier-verify"] } };

test("Atelier's own ship file composes its deploy, the live check and the push to github", () => {
  const p = composeShip(resolve("."));
  assert.deepEqual(p.problems, []);
  assert.equal(p.source, "docs/atelier/ship.json");
  assert.equal(p.class, "web");
  assert.deepEqual(outline(p), [
    ["commit"], ["typecheck", "npm run typecheck"], ["deploy", "node scripts/ship-worker.mjs deploy [deploy]"],
    ["verify-delivery", "node scripts/ship-worker.mjs verify"], ["wrap"],
    ["scan", "node scripts/privacy-scan.mjs --remote github --branch main --project atelier"], ["push"],
    ["baseline", "node cli/atelier.mjs sync --project atelier"], ["studio", "node scripts/studio-ff.mjs --remote github --branch main"],
  ]);
  const by = Object.fromEntries(p.steps.map((s) => [s.step, s]));
  assert.equal(by["verify-delivery"].runs[0].timeoutMs, 45_000);
  assert.deepEqual(by.push.push, { remote: "github", branch: "main" });
  assert.equal(by.deploy.runs[0].timeoutMs, 1200_000);
  assert.equal(by.deploy.runs[0].retries, 1, "the deploy is retried once");
  assert.equal(by.deploy.runs[0].ifChanged.since, "https://atelier.zone/api/version");
  assert.ok(by.deploy.runs[0].ifChanged.paths.includes("src/**"));
  assert.deepEqual(neededKinds(p.steps), ["deploy"], "only the deploy needs an approval");
});

test("with both formats present Atelier's ship file wins, and a malformed ControlPlane file is ignored", (t) => {
  const both = plan(t, { ...CP_FILES, "docs/atelier/ship.json": WEB_SHIP });
  assert.deepEqual(both.problems, []);
  assert.equal(both.source, "docs/atelier/ship.json");
  assert.deepEqual(outline(both), [["commit"], ["deploy", "./atelier-deploy [deploy]"], ["verify-delivery", "./atelier-verify"], ["wrap"], ["push"]]);
  const broken = plan(t, {
    "docs/control-plane/ship-policy.v1.json": "{ not json",
    "docs/control-plane/project-adapter.v1.json": "[",
    "docs/control-plane/canonical-device-set.v3.json": "nope",
    "docs/atelier/ship.json": WEB_SHIP,
  });
  assert.deepEqual(broken.problems, []);
  assert.equal(broken.source, "docs/atelier/ship.json");
  assert.deepEqual(outline(broken), outline(both));
});

test("a ControlPlane-only checkout, valid or malformed, or none, has no ship order and names the Atelier file it needs", (t) => {
  for (const tree of [CP_FILES, { "docs/control-plane/ship-policy.v1.json": "{ not json" }, { "README.md": "x" }]) {
    const p = plan(t, tree);
    assert.deepEqual(p.steps, []);
    assert.equal(p.problems.length, 1, p.problems.join("\n"));
    assert.match(p.problems[0], /has no ship file: atelier ship reads only docs\/atelier\/ship\.json/);
    assert.match(p.problems[0], /Add docs\/atelier\/ship\.json/);
  }
  assert.match(plan(t, { "docs/atelier/ship.json": "{ not json" }).problems[0], /docs\/atelier\/ship\.json is not valid JSON/);
});

test("the Atelier ship file is read strictly", (t) => {
  const ship = (doc) => plan(t, { "docs/atelier/ship.json": { schema_version: 1, kind: "atelier.ship", ...doc } });
  const good = ship({ class: "installable", install: [{ run: ["./install", "a"] }, { run: ["./install", "b"], approval: "photos-writeback" }], "verify-install": { run: ["./verify"] } });
  assert.deepEqual(good.problems, []);
  assert.deepEqual(outline(good), [["install", "./install a [install]", "./install b [photos-writeback]"], ["verify-delivery", "./verify"], ["commit"], ["wrap"], ["push"]]);
  assert.deepEqual(neededKinds(good.steps), ["install", "photos-writeback"]);
  const other = ship({ class: "other" });
  assert.deepEqual(other.problems, []);
  assert.deepEqual(outline(other), [["commit"], ["wrap"], ["push"]]);
  for (const [doc, problem] of [
    [{ class: "web", deploy: { run: ["x"] }, "verify-deploy": { run: ["y"] }, verify: {} }, /a field atelier ship does not read: verify/],
    [{ class: "web", deploy: { run: ["x"] }, "verify-deploy": { run: ["y"] }, install: { run: ["z"] } }, /gives install, which a web project's order has no step for/],
    [{ class: "mobile" }, /needs "class": web, installable, hybrid or other/],
    [{ class: "web", deploy: { run: "npx wrangler deploy" }, "verify-deploy": { run: ["y"] } }, /deploy "run" must be the command and its arguments, as a list of strings/],
    [{ class: "web", deploy: { run: ["x"] }, "verify-deploy": { request: "ftp://x.test" } }, /"request" must be an http or https URL/],
    [{ class: "web", deploy: { run: ["x"] }, "verify-deploy": { request: "https://x.test", run: ["y"] } }, /needs "run" or "request", not both/],
    [{ class: "web", deploy: { run: ["x"], approval: "Deploy" }, "verify-deploy": { run: ["y"] } }, /"approval" must be a kind/],
    [{ class: "web", deploy: { run: ["x"] } }, /verifies the deploy and has nothing to run for it: give "verify-deploy"/],
    [{ class: "web", deploy: { run: ["x"] }, "verify-deploy": { run: ["y"] }, push: { remote: "github", branch: "main", force: true } }, /"push" must be \{"remote": NAME, "branch": NAME\}/],
  ]) assert.match(ship(doc).problems.join("\n"), problem);
  assert.match(plan(t, { "docs/atelier/ship.json": { kind: "atelier.ship" } }).problems[0], /"schema_version": 1/);
});

test("the kinds approve accepts: Atelier's own and those its ship file names, never an adapter's capability names", (t) => {
  const dir = files({
    ...CP_FILES,
    "docs/atelier/ship.json": { ...WEB_SHIP, deploy: [{ run: ["./atelier-deploy"] }, { run: ["./caption"], approval: "photos-writeback" }, { run: ["./other"], approval: "caption-spend" }] },
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const kinds = knownKinds(dir);
  for (const k of ["deploy", "install", "paid-run", "photos-writeback", "caption-spend"]) assert.ok(kinds.has(k), k);
  // ControlPlane's capability names and action classes supply no kind now.
  for (const k of ["captioning-run", "paid-provider", "device"]) assert.ok(!kinds.has(k), k);
  assert.ok(!kinds.has("deplyo"));
  // Push is no approval kind: --push is the owner's own act at the exact head.
  assert.ok(!kinds.has("push"));
  // A ControlPlane-only checkout names none either.
  const only = files(CP_FILES);
  t.after(() => rmSync(only, { recursive: true, force: true }));
  assert.deepEqual([...knownKinds(only)], [...knownKinds(null)]);
  assert.deepEqual([...knownKinds(null)], ["deploy", "install", "paid-run", "photos-writeback"]);
});

// ── the command, end to end ─────────────────────────────────────────────────

const gitAs = (email) => (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: email } }).trim();
const git = gitAs("t@x.test");
const PUBLIC_EMAIL = "123+t@users.noreply.github.com";
const SECRET = "s3cret-value-for-the-deploy";

// A stand-in for the Worker's routes ship, approve and wrap use. Approvals
// live in `state.approvals` and follow the Ledger's rules closely enough for
// the command: the oldest active one for the kind and revision is used once.
function standIn(state) {
  return createServer(async (req, res) => {
    if (req.url === "/api/version") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ capabilities: SERVER_CAPABILITIES })); }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const path = new URL(req.url, "http://x").pathname;
    state.requests.push({ method: req.method, path, body });
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    const view = (a) => ({ ...a, status: a.consumed ? "consumed" : a.withdrawn ? "withdrawn" : "active" });
    if (path === "/live") return send(state.live ?? 200, {});
    if (path === "/version") return send(200, { commit: state.liveCommit });
    if (path === "/api/projects/demo/baseline-head") return send(200, { head: git(state.baseline, "rev-parse", "main") });
    if (path === "/api/projects/demo/actions" && req.method === "GET") return send(200, { approvals: [...state.approvals].reverse().map(view), runs: [] });
    if (path === "/api/projects/demo/actions" && req.method === "POST") {
      const a = { id: `a${state.approvals.length + 1}`, kind: body.kind, commit: body.commit, note: body.note, by: "owner", at: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString() };
      state.approvals.push(a);
      return send(201, view(a));
    }
    if (path === "/api/projects/demo/actions/consume") {
      const a = state.approvals.find((x) => x.kind === body.kind && x.commit === body.commit && !x.consumed && !x.withdrawn);
      if (!a) return send(409, { error: "not_approved", detail: `no active approval for ${body.kind}` });
      a.consumed = { by: "owner", at: new Date().toISOString() };
      return send(200, view(a));
    }
    if (path === "/api/projects/demo/actions/runs") { state.runs.push(body); return send(201, body); }
    const withdraw = /^\/api\/projects\/demo\/actions\/(a\d+)\/withdraw$/.exec(path);
    if (withdraw) {
      const a = state.approvals.find((x) => x.id === withdraw[1]);
      a.withdrawn = { by: "owner", at: new Date().toISOString(), note: body.note };
      return send(200, view(a));
    }
    if (path === "/api/projects/demo" && req.method === "GET") return send(200, { project: { policy: { checks: state.checks ?? [], ...(state.identity ? { commitIdentity: state.identity } : {}) } }, items: [] });
    if (path === "/api/projects/demo/sessions" && req.method === "GET") return send(200, []);
    if (path === "/api/projects/demo/sessions" && req.method === "POST") return send(201, { actor: "owner", at: new Date().toISOString(), data: body });
    if (path === "/api/projects/demo/baseline-token") return send(200, { remote: state.baseline, token: "t", defaultBranch: "main" });
    send(404, { error: "not_found", detail: `the stand-in has no ${req.method} ${path}` });
  });
}

// A checkout registered as demo, whose docs/atelier/ship.json deploys with a
// stand-in script, checks a stand-in live site and pushes to a local bare
// repository named github. The baseline is a local bare repository at HEAD.
async function fixture(t, { approve = [], ship, extra = {}, email = "t@x.test" } = {}) {
  const git = gitAs(email);
  const dir = mkdtempSync(join(tmpdir(), "atelier-ship-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = { approvals: [], runs: [], requests: [] };
  const server = standIn(state);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const checkout = join(dir, "checkout");
  mkdirSync(join(checkout, "bin"), { recursive: true });
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "config", "user.name", "T");
  git(checkout, "config", "user.email", email);
  writeFileSync(join(checkout, "README.md"), "demo\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "one");
  const github = join(dir, "github.git");
  git(dir, "clone", "-q", "--bare", checkout, github);
  git(checkout, "remote", "add", "github", github);
  writeFileSync(join(checkout, "bin", "deploy.sh"), `#!/bin/sh
echo "deploying; atelier token: \${ATELIER_TOKEN:-none}; api token: $MY_API_TOKEN; source: $ATELIER_SHIP_HEAD"
echo deployed >> "$SHIP_MARKER"
exit \${DEPLOY_EXIT:-0}
`);
  chmodSync(join(checkout, "bin", "deploy.sh"), 0o755);
  mkdirSync(join(checkout, "docs", "atelier"), { recursive: true });
  for (const [path, value] of Object.entries(extra)) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), typeof value === "string" ? value : JSON.stringify(value));
  }
  if (ship !== null) writeFileSync(join(checkout, "docs", "atelier", "ship.json"), JSON.stringify((typeof ship === "function" ? ship(url) : ship) ?? {
    schema_version: 1, kind: "atelier.ship", class: "web",
    deploy: { run: ["bin/deploy.sh"] },
    "verify-deploy": { request: `${url}/live`, status: 200 },
    push: { remote: "github", branch: "main" },
  }, null, 2));
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "ship file");
  const head = git(checkout, "rev-parse", "HEAD");
  const baseline = join(dir, "baseline.git");
  git(dir, "clone", "-q", "--bare", checkout, baseline);
  Object.assign(state, { baseline, liveCommit: git(checkout, "rev-list", "--max-parents=0", "HEAD") });
  for (const kind of approve) state.approvals.push({ id: `a${state.approvals.length + 1}`, kind, commit: head, note: "", by: "owner", at: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString() });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: url, owner: "owner", projects: { demo: { path: checkout, branch: "main" } } }));
  const marker = join(dir, "deployed.txt");
  const run = (args, env = {}, cwd = checkout) => new Promise((done) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ATELIER_")));
    const child = spawn(process.execPath, [cli, ...args], {
      cwd, env: { ...clean, ATELIER_PRIVATE_ROOT: join(dir, "no-icloud"), ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "test-token", ATELIER_SERVER: url, MY_API_TOKEN: SECRET, SHIP_MARKER: marker, ...env },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => { stdout += s; });
    child.stderr.on("data", (s) => { stderr += s; });
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
  const writes = () => state.requests.filter((r) => r.method !== "GET");
  return { dir, checkout, github, baseline, head, state, url, marker, run, writes };
}

test("ship --dry-run prints the steps and the approvals missing, and runs nothing", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["ship", "--dry-run", "--push"]);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.split("\n");
  assert.equal(out[0], `Ship demo at main @ ${f.head.slice(0, 8)}, from docs/atelier/ship.json, class web:`);
  assert.ok(out.includes("  2. deploy           bin/deploy.sh  [deploy: no approval at this revision]"), r.stdout);
  assert.ok(out.includes(`  3. verify-delivery  GET ${f.url}/live, expecting 200`), r.stdout);
  assert.ok(out.includes("  5. push             git push --no-force github refs/heads/main:refs/heads/main  (no approval: the developer's own act at this revision)"), r.stdout);
  assert.ok(out.includes(`  atelier approve deploy --head ${f.head} --project demo`), r.stdout);
  // The push takes no approval, so none is asked for.
  assert.ok(!out.includes("atelier approve push"), r.stdout);
  assert.match(r.stdout, /Dry run: nothing was run, approved or recorded\.\n$/);
  assert.ok(!existsSync(f.marker), "the deploy did not run");
  assert.deepEqual(f.writes(), []);
  // Without --push the push is shown as not run.
  const quiet = await f.run(["ship", "--dry-run"]);
  assert.match(quiet.stdout, /5\. push             not run without --push \(git push --no-force github refs\/heads\/main:refs\/heads\/main\)/);
  assert.doesNotMatch(quiet.stdout, /approve push/);
});

test("ship with an approval missing refuses before running anything, naming the command", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["ship", "--push"]);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.stderr, `atelier: ship refused before running anything: an approval is missing at ${f.head.slice(0, 8)}. The developer approves with:\n  atelier approve deploy --head ${f.head} --project demo\nthen runs atelier ship again.\n`);
  assert.match(r.stdout, /bin\/deploy\.sh  \[deploy: no approval at this revision\]/);
  assert.ok(!existsSync(f.marker));
  assert.deepEqual(f.writes(), [], "nothing used, run or recorded");
});

test("a ControlPlane-only checkout refuses before any command, approval or run record, naming the Atelier ship file", async (t) => {
  const f = await fixture(t, { ship: null, approve: ["deploy"], extra: CP_FILES });
  const cpDeploy = join(f.checkout, "cp-deploy");
  for (const args of [["ship", "--push"], ["ship"]]) {
    const r = await f.run(args);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /ship refused before running anything:\n  this project has no ship file: atelier ship reads only docs\/atelier\/ship\.json/);
    assert.ok(!existsSync(f.marker) && !existsSync(cpDeploy), "no command ran");
    assert.deepEqual(f.writes(), [], "nothing used, run or recorded");
    assert.ok(f.state.approvals.every((a) => !a.consumed), "the approval is not consumed");
  }
  const dry = await f.run(["ship", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /from no ship file:/);
  assert.match(dry.stdout, /Refused: this project has no ship file: atelier ship reads only docs\/atelier\/ship\.json/);
  assert.deepEqual(f.writes(), []);
});

test("ship runs each step in order with its approvals, records each one redacted, and pushes without force or a push approval", async (t) => {
  const f = await fixture(t, { approve: ["deploy"] });
  // The github remote is behind: the push fast-forwards it.
  assert.notEqual(git(f.github, "rev-parse", "main"), f.head);
  const r = await f.run(["ship", "--push"], { ATELIER_SHIP_HEAD: "untrusted-caller-value" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`source: ${f.head}`));
  assert.doesNotMatch(r.stdout, /untrusted-caller-value/);
  assert.equal(readFileSync(f.marker, "utf8"), "deployed\n", "the deploy ran once");
  assert.match(r.stdout, /deploy: using approval a1 for deploy at /);
  assert.doesNotMatch(r.stdout, /push: using approval/, "--push is the owner's own act and takes no approval");
  assert.match(r.stdout, new RegExp(`Shipped demo at ${f.head.slice(0, 8)}: commit, deploy, verify-delivery, wrap, push ran, each recorded on the ledger\\.`));
  const runs = f.state.runs;
  assert.deepEqual(runs.map((x) => [x.step, x.kind, x.approval, x.passed]), [
    ["commit", null, null, true], ["deploy", "deploy", "a1", true], ["verify-delivery", null, null, true], ["wrap", null, null, true], ["push", null, null, true],
  ]);
  assert.equal(new Set(runs.map((x) => x.ship)).size, 1, "one ship id on every step");
  assert.ok(runs.every((x) => x.commit === f.head));
  const deploy = runs[1];
  assert.equal(deploy.command, "bin/deploy.sh");
  assert.equal(deploy.exitStatus, 0);
  assert.ok(Number.isInteger(deploy.durationMs));
  assert.match(deploy.outputTail, /atelier token: none; api token: \[redacted\]/, "no ATELIER_ variable reaches a step, and secrets are cut from the record");
  assert.ok(!JSON.stringify(f.state.requests).includes(SECRET), "the secret went nowhere");
  assert.match(runs[2].outputTail, /\/live answered 200; expected 200/);
  assert.equal(runs[2].note, "verifies the deploy");
  assert.match(runs[3].command, /^atelier wrap 'Ship [0-9a-f]{8}: commit, deploy, verify-delivery'$/);
  assert.match(runs[4].command, /^git push --no-force github refs\/heads\/main:refs\/heads\/main$/);
  assert.ok(f.state.approvals.every((a) => a.consumed), "the deploy approval is used");
  assert.ok(f.state.requests.some((q) => q.method === "POST" && q.path === "/api/projects/demo/sessions"), "wrap recorded the session");
  assert.equal(git(f.github, "rev-parse", "main"), git(f.checkout, "rev-parse", "HEAD"), "github holds the shipped head");
  // The spent deploy approval cannot ship again; the push never needed one.
  const again = await f.run(["ship", "--push"]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /an approval is missing at .*\n  atelier approve deploy --head /);
});

test("ship stops at the first step that fails, says what ran and what did not, and records it", async (t) => {
  const f = await fixture(t, { approve: ["deploy"] });
  const r = await f.run(["ship"], { DEPLOY_EXIT: "3" });
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.stderr, [
    "atelier: ship stopped at deploy: bin/deploy.sh exited 3.",
    "Ran before it: commit. Not run: verify-delivery, wrap. Each step that ran is recorded on the ledger.",
    `The approval used here (a1 for deploy) is spent; after fixing the cause, the developer approves again: atelier approve deploy --head ${f.head} --project demo`,
    "",
  ].join("\n"));
  assert.deepEqual(f.state.runs.map((x) => [x.step, x.passed, x.exitStatus]), [["commit", true, null], ["deploy", false, 3]]);
  assert.ok(!f.state.requests.some((q) => q.path.endsWith("/sessions")), "wrap did not run");
  assert.notEqual(git(f.github, "rev-parse", "main"), f.head, "nothing was pushed");
});

test("a live site that does not answer as expected stops the ship after the deploy", async (t) => {
  const f = await fixture(t, { approve: ["deploy"] });
  f.state.live = 503;
  const r = await f.run(["ship"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^atelier: ship stopped at verify-delivery: GET .*\/live, expecting 200 failed\.\nRan before it: commit, deploy\. Not run: wrap\./);
  assert.deepEqual(f.state.runs.map((x) => [x.step, x.passed]), [["commit", true], ["deploy", true], ["verify-delivery", false]]);
  assert.match(f.state.runs[2].outputTail, /answered 503; expected 200/);
});

test("ship never forces a push: a remote that moved on refuses it, and keeps its own commit", async (t) => {
  const f = await fixture(t, { approve: ["deploy"] });
  const other = join(f.dir, "other");
  git(f.dir, "clone", "-q", f.github, other);
  writeFileSync(join(other, "theirs.txt"), "theirs\n");
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "theirs");
  git(other, "push", "-q", "origin", "main");
  const theirs = git(f.github, "rev-parse", "main");
  const r = await f.run(["ship", "--push"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /^atelier: ship stopped at push: git push --no-force github refs\/heads\/main:refs\/heads\/main exited 1\./);
  assert.equal(git(f.github, "rev-parse", "main"), theirs, "the remote's commit stands");
  assert.deepEqual(f.state.runs.map((x) => [x.step, x.passed]), [["commit", true], ["deploy", true], ["verify-delivery", true], ["wrap", true], ["push", false]]);
});

test("ship refuses a dirty checkout, a HEAD the baseline does not hold, another actor and another directory", async (t) => {
  const f = await fixture(t, { approve: ["deploy"] });
  writeFileSync(join(f.checkout, "loose.txt"), "x\n");
  const dirty = await f.run(["ship"]);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /ship refused before running anything:\n  the checkout has uncommitted changes, and ship runs only on a clean checkout/);
  const shown = await f.run(["ship", "--dry-run"]);
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /Refused: the checkout has uncommitted changes/);
  rmSync(join(f.checkout, "loose.txt"));
  writeFileSync(join(f.checkout, "more.txt"), "x\n");
  git(f.checkout, "add", ".");
  git(f.checkout, "commit", "-q", "-m", "not on the baseline");
  const ahead = await f.run(["ship"]);
  assert.equal(ahead.status, 1);
  assert.match(ahead.stderr, /HEAD [0-9a-f]{8} is not the baseline's head [0-9a-f]{8}; ship runs only the revision Atelier holds/);
  const agent = await f.run(["ship"], { ATELIER_ACTOR: "codex/gpt-6-astra" });
  assert.equal(agent.stderr, "atelier: only the developer ships: run ship as owner, without --as or ATELIER_ACTOR naming another actor\n");
  const elsewhere = await f.run(["ship", "--project", "demo"], {}, f.dir);
  assert.match(elsewhere.stderr, /^atelier: run ship in demo's registered checkout: cd /);
  assert.ok(!existsSync(f.marker));
  assert.deepEqual(f.writes(), []);
});

test("approve sends the kind, the full revision and the expiry; approvals lists and withdraws", async (t) => {
  const f = await fixture(t);
  const bad = await f.run(["approve", "deplyo", "--head", f.head]);
  assert.match(bad.stderr, /^atelier: demo has no action called deplyo\. Atelier knows deploy, install, paid-run, photos-writeback; demo's ship files name no others\n$/);
  const short = await f.run(["approve", "deploy", "--head", f.head.slice(0, 8)]);
  assert.match(short.stderr, /--head needs the full revision of the main line/);
  const long = await f.run(["approve", "deploy", "--head", f.head, "--expires", "45d"]);
  assert.match(long.stderr, /--expires: an expiry is minutes, hours or days/);
  assert.deepEqual(f.writes(), [], "every refusal came before a request");
  const r = await f.run(["approve", "deploy", "--head", f.head.toUpperCase(), "--note", "release 12", "--expires", "2h"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^a1: deploy approved at ${f.head.slice(0, 8)} until .* UTC\\. The next atelier ship at that revision uses it, once\\. To withdraw it: atelier approvals withdraw a1\\n$`));
  assert.deepEqual(f.writes()[0], { method: "POST", path: "/api/projects/demo/actions", body: { kind: "deploy", commit: f.head, note: "release 12", expires: "2h" } });
  const list = await f.run(["approvals"]);
  assert.match(list.stdout, new RegExp(`^a1   deploy           ${f.head.slice(0, 8)}  active until .* UTC  approved .* UTC  note: release 12\\n$`));
  const w = await f.run(["approvals", "withdraw", "a1", "--note", "not yet"]);
  assert.equal(w.stdout, `a1: deploy at ${f.head.slice(0, 8)} is withdrawn; no ship will use it.\n`);
  assert.equal((await f.run(["approvals"])).stdout, "No approval stands for demo; atelier approvals --all lists the used, withdrawn and expired ones.\n");
  assert.match((await f.run(["approvals", "--all"])).stdout, /^a1   deploy .* withdrawn .* \(not yet\)/);
  assert.match((await f.run(["approvals", "frobnicate"])).stderr, /usage: atelier approvals/);
});

// A remote the policy declares a public mirror takes ship --push only commits
// under the project's public address (cli/checkout-push.mjs).
test("ship --push sends a declared public mirror only commits under the public address", async (t) => {
  const mirrorPolicy = () => ({ name: "T", email: PUBLIC_EMAIL, agentEmails: [], publicMirrors: ["github"] });
  const clean = await fixture(t, { approve: ["deploy"], email: PUBLIC_EMAIL });
  clean.state.identity = mirrorPolicy();
  const ok = await clean.run(["ship", "--push"]);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.equal(git(clean.github, "rev-parse", "main"), clean.head, "the head reached the mirror");
  assert.ok(clean.state.runs.at(-1).passed);

  // A commit under a private address is refused, named, and nothing reaches the mirror.
  const f = await fixture(t, { approve: ["deploy"] });
  f.state.identity = mirrorPolicy();
  const before = git(f.github, "rev-parse", "main");
  const r = await f.run(["ship", "--push"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /ship stopped at push/);
  assert.match(f.state.runs.at(-1).outputTail, new RegExp(`Not pushed to github: commit ${f.head.slice(0, 12)}: the author email .* is not the project's public address ${PUBLIC_EMAIL.replace(/[+]/g, "\\+")}`));
  assert.equal(git(f.github, "rev-parse", "main"), before, "the mirror was not pushed");
  assert.equal(f.state.runs.at(-1).step, "push");
  assert.equal(f.state.runs.at(-1).passed, false);

  // A ship file may name another branch on the mirror: the same check applies, and the branch is pushed there.
  const other = await fixture(t, { approve: ["deploy"], email: PUBLIC_EMAIL, ship: { schema_version: 1, kind: "atelier.ship", class: "other", push: { remote: "github", branch: "release" } } });
  other.state.identity = mirrorPolicy();
  const named = await other.run(["ship", "--push"]);
  assert.equal(named.status, 0, named.stderr + named.stdout);
  assert.equal(git(other.github, "rev-parse", "release"), other.head);
});

// Both reviews of t645: ship --push pushed the checkout's history to the
// project's own remote unchecked, so a commit holding a private file that
// was later removed (one from before the file was named private) reached it.
test("ship --push carries no commit holding a private file to the remote", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.checkout, "PROJECT.md"), "the plan\n");
  git(f.checkout, "add", "-f", "PROJECT.md");
  git(f.checkout, "commit", "-q", "-m", "before it was private");
  const leak = git(f.checkout, "rev-parse", "HEAD");
  git(f.checkout, "rm", "-q", "--cached", "PROJECT.md");
  git(f.checkout, "commit", "-q", "-m", "now private");
  rmSync(join(f.checkout, "PROJECT.md"));
  const head = git(f.checkout, "rev-parse", "HEAD");
  git(f.checkout, "push", "-q", f.baseline, "main");
  f.state.approvals.push({ id: "a9", kind: "deploy", commit: head, note: "", by: "owner", at: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString() });
  const config = JSON.parse(readFileSync(join(f.dir, "config.json"), "utf8"));
  config.projects.demo.private = ["PROJECT.md"];
  writeFileSync(join(f.dir, "config.json"), JSON.stringify(config));
  const before = git(f.github, "rev-parse", "main");
  const r = await f.run(["ship", "--push"]);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /ship stopped at push/);
  const push = f.state.runs.find((x) => x.step === "push");
  assert.match(push.outputTail, new RegExp(`Not pushed to github: main would carry private files: PROJECT\\.md in ${leak.slice(0, 12)}`));
  assert.equal(git(f.github, "rev-parse", "main"), before, "the remote got nothing");
});

test("ship source binding replaces caller input without exposing Atelier credentials (t182)", () => {
  const head = "a".repeat(40);
  assert.deepEqual(stepEnv({ PATH: "/bin", MY_API_TOKEN: "provider-secret", ATELIER_TOKEN: "owner-secret", ATELIER_SHIP_HEAD: "spoofed" }, head), { PATH: "/bin", MY_API_TOKEN: "provider-secret", ATELIER_SHIP_HEAD: head });
});

for (const matches of [true, false]) test(`canonical ship source verification ${matches ? "passes" : "stops wrap and push on mismatch"} (t182)`, async (t) => {
  // The deploy and verify wiring alone: the fixture has no package.json or live version, so the added steps and the deploy's condition are left out.
  const { typecheck, scan, baseline, studio, ...canonical } = JSON.parse(readFileSync(resolve("docs/atelier/ship.json"), "utf8"));
  const plan = { ...canonical, deploy: { ...canonical.deploy, if_changed: undefined } };
  const f = await fixture(t, { approve: ["deploy"], ship: plan, extra: { "scripts/ship-worker.mjs": readFileSync(resolve("scripts/ship-worker.mjs"), "utf8") } });
  const bin = join(f.dir, "tools"); mkdirSync(bin);
  const argsFile = join(f.dir, "deploy-args.txt");
  writeFileSync(join(bin, "npx"), `#!/bin/sh\nprintf '%s\\n' "$@" > "$DEPLOY_ARGS"\n`);
  chmodSync(join(bin, "npx"), 0o755);
  const preload = join(f.dir, "version-response.mjs");
  writeFileSync(preload, `const original = globalThis.fetch; globalThis.fetch = (url, options) => String(url) === "https://atelier.zone/api/version" ? Promise.resolve(Response.json({commit:process.env.SHIP_TEST_COMMIT,main:process.env.SHIP_TEST_MAIN})) : original(url, options);`);
  const r = await f.run(["ship", "--push"], { PATH: bin + ":" + process.env.PATH, DEPLOY_ARGS: argsFile, NODE_OPTIONS: "--import=" + preload, SHIP_TEST_COMMIT: matches ? f.head : "a".repeat(40), SHIP_TEST_MAIN: f.head, ATELIER_SHIP_HEAD: "spoofed" });
  assert.ok(existsSync(argsFile), r.stderr + r.stdout);
  assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), ["wrangler", "deploy", "--keep-vars", "--var", `DEPLOYED_MAIN:${f.head}`]);
  const verified = f.state.runs.find(run => run.step === "verify-delivery");
  assert.equal(verified.passed, matches);
  if (matches) {
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(f.state.runs.some(run => run.step === "wrap"));
    assert.ok(f.state.runs.some(run => run.step === "push"));
  } else {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /live deployed commit does not match/);
    assert.ok(!f.state.runs.some(run => ["wrap", "push"].includes(run.step)));
    assert.notEqual(git(f.github, "rev-parse", "main"), f.head);
  }
});

// ── the steps beyond deploy and push: typecheck, scan, baseline, studio ──────

const OK = "#!/bin/sh\necho \"step $1 ran\"\nexit 0\n";
const FLAKY = `if [ -e "$SHIP_MARKER.once" ]; then echo "second try ok"; exit 0; fi\ntouch "$SHIP_MARKER.once"\necho "first try fails"\nexit 1\n`;
const FAIL = "echo \"scan found a leak\"\nexit 4\n";
const sh = (script, ...args) => ({ run: ["sh", script, ...args] });
const FULL = (deploy) => (url) => ({
  schema_version: 1, kind: "atelier.ship", class: "web",
  typecheck: sh("bin/ok.sh", "typecheck"),
  deploy: { ...deploy, if_changed: { paths: deploy.paths ?? ["bin/**"], since: `${url}/version` }, paths: undefined },
  "verify-deploy": { request: `${url}/live`, status: 200 },
  scan: sh("bin/ok.sh", "scan"),
  push: { remote: "github", branch: "main" },
  baseline: sh("bin/ok.sh", "baseline"),
  studio: sh("bin/ok.sh", "studio"),
});
const STEPS_FILES = { "bin/ok.sh": OK, "bin/flaky.sh": FLAKY, "bin/fail.sh": FAIL };

test("a dry run at a test revision lists every step the ship would run, in order", async (t) => {
  const f = await fixture(t, { ship: FULL({ run: ["bin/deploy.sh"], retries: 1 }), extra: STEPS_FILES });
  const r = await f.run(["ship", "--dry-run", "--push"]);
  assert.equal(r.status, 0, r.stderr);
  const steps = r.stdout.split("\n").filter((l) => /^ {2}\d\. /.test(l)).map((l) => l.slice(5, 22).trim());
  assert.deepEqual(steps, ["commit", "typecheck", "deploy", "verify-delivery", "wrap", "scan", "push", "baseline", "studio"]);
  assert.match(r.stdout, /3\. deploy +bin\/deploy\.sh  \[runs: 4 files under bin\/\*\* changed since [0-9a-f]{8}, the commit live\] \[deploy: no approval at this revision\] \[retried up to 1 time if it fails\]/, r.stdout);
  assert.match(r.stdout, /6\. scan +sh bin\/ok\.sh scan\n/);
  assert.equal(r.stdout.match(/approve /g).length, 1, "only the deploy asks for an approval");
  assert.ok(!existsSync(f.marker) && f.writes().length === 0, "a dry run runs and records nothing");
  const quiet = await f.run(["ship", "--dry-run"]);
  assert.match(quiet.stdout, /6\. scan +not run without --push: sh bin\/ok\.sh scan/);
  assert.match(quiet.stdout, /8\. baseline +not run without --push: /);
});

test("a full ship records every step, deploys with its approval, and updates the baseline and the Studio last", async (t) => {
  const f = await fixture(t, { approve: ["deploy"], ship: FULL({ run: ["bin/deploy.sh"], retries: 1 }), extra: STEPS_FILES });
  const r = await f.run(["ship", "--push"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(f.state.runs.map((x) => [x.step, x.kind, x.passed]), [
    ["commit", null, true], ["typecheck", null, true], ["deploy", "deploy", true], ["verify-delivery", null, true], ["wrap", null, true],
    ["scan", null, true], ["push", null, true], ["baseline", null, true], ["studio", null, true],
  ]);
  assert.equal(f.state.runs[2].approval, "a1");
  assert.match(f.state.runs[2].note, /4 files under bin\/\*\* changed/);
  assert.equal(git(f.github, "rev-parse", "main"), f.head);
});

test("without --push the scan, push, baseline and Studio steps do not run", async (t) => {
  const f = await fixture(t, { approve: ["deploy"], ship: FULL({ run: ["bin/deploy.sh"] }), extra: STEPS_FILES });
  const r = await f.run(["ship"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(f.state.runs.map((x) => x.step), ["commit", "typecheck", "deploy", "verify-delivery", "wrap"]);
});

test("the deploy is skipped, needing no approval, when no Worker code changed since the live commit; its verify is skipped too", async (t) => {
  const f = await fixture(t, { ship: FULL({ run: ["bin/deploy.sh"], paths: ["src/**"] }), extra: STEPS_FILES });
  const r = await f.run(["ship", "--push"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!existsSync(f.marker), "the deploy did not run");
  assert.equal(f.state.requests.filter((q) => q.path === "/api/projects/demo/actions/consume").length, 0, "no approval was taken");
  const deploy = f.state.runs.find((x) => x.step === "deploy");
  assert.equal(deploy.passed, true);
  assert.match(deploy.note, /^skipped: nothing under src\/\*\* changed since [0-9a-f]{8}, the commit live$/);
  assert.match(f.state.runs.find((x) => x.step === "verify-delivery").note, /^skipped: the deploy was skipped/);
  assert.match(r.stdout, /Shipped demo at [0-9a-f]{8}: commit, typecheck, deploy \(skipped\), verify-delivery \(skipped\), wrap, scan, push, baseline, studio ran/);
  assert.deepEqual(f.state.runs.map((x) => x.passed), f.state.runs.map(() => true));
});

test("the deploy runs when the live commit cannot be read", async (t) => {
  const f = await fixture(t, { approve: ["deploy"], ship: FULL({ run: ["bin/deploy.sh"], paths: ["src/**"] }), extra: STEPS_FILES });
  f.state.liveCommit = "0".repeat(40);
  const r = await f.run(["ship"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(f.marker, "utf8"), "deployed\n");
  assert.match(f.state.runs.find((x) => x.step === "deploy").note, /runs: the commit .* reports is not one this checkout holds/);
});

test("a deploy that fails once is retried once with the same approval, and both tries are recorded", async (t) => {
  const f = await fixture(t, { approve: ["deploy"], ship: FULL({ run: ["sh", "bin/flaky.sh"], retries: 1 }), extra: STEPS_FILES });
  const r = await f.run(["ship"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const deploys = f.state.runs.filter((x) => x.step === "deploy");
  assert.deepEqual(deploys.map((x) => [x.passed, x.approval]), [[false, "a1"], [true, "a1"]]);
  assert.match(deploys[1].note, /retry 1/);
  assert.equal(f.state.requests.filter((q) => q.path.endsWith("/actions/consume")).length, 1, "one approval for both tries");
});

test("a deploy that fails again after its one retry stops the ship at deploy", async (t) => {
  const f = await fixture(t, { approve: ["deploy"], ship: FULL({ run: ["bin/deploy.sh"], retries: 1 }), extra: STEPS_FILES });
  const r = await f.run(["ship"], { DEPLOY_EXIT: "2" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ship stopped at deploy: bin\/deploy\.sh exited 2\./);
  assert.deepEqual(f.state.runs.map((x) => [x.step, x.passed]), [["commit", true], ["typecheck", true], ["deploy", false], ["deploy", false]]);
});

test("a failing type-check stops the ship before the deploy, and a failing scan before the push; each names itself", async (t) => {
  const a = await fixture(t, { approve: ["deploy"], ship: (url) => ({ ...FULL({ run: ["bin/deploy.sh"] })(url), typecheck: sh("bin/fail.sh") }), extra: { ...STEPS_FILES, "bin/fail.sh": FAIL } });
  const r1 = await a.run(["ship", "--push"]);
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /ship stopped at typecheck: sh bin\/fail\.sh exited 4\./);
  assert.match(r1.stderr, /Not run: deploy, verify-delivery, wrap, scan, push, baseline, studio\./);
  assert.ok(!existsSync(a.marker), "nothing deployed");
  assert.ok(a.state.approvals.every((x) => !x.consumed), "the deploy approval was not spent");

  const b = await fixture(t, { approve: ["deploy"], ship: (url) => ({ ...FULL({ run: ["bin/deploy.sh"] })(url), scan: sh("bin/fail.sh") }), extra: STEPS_FILES });
  const r2 = await b.run(["ship", "--push"]);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /ship stopped at scan: sh bin\/fail\.sh exited 4\./);
  assert.match(r2.stderr, /Not run: push, baseline, studio\./);
  assert.notEqual(git(b.github, "rev-parse", "main"), b.head, "nothing was pushed");
  assert.deepEqual(b.state.runs.at(-1) && [b.state.runs.at(-1).step, b.state.runs.at(-1).passed], ["scan", false]);
});

test("the ship file's added steps are read strictly", (t) => {
  const base = { schema_version: 1, kind: "atelier.ship", class: "web", deploy: { run: ["./d"] }, "verify-deploy": { run: ["./v"] } };
  const problems = (extra) => plan(t, { "docs/atelier/ship.json": { ...base, ...extra } }).problems.join("\n");
  assert.match(problems({ typecheck: [] }), /the ship order has typecheck and nothing to run for it/);
  assert.match(problems({ deploy: { run: ["./d"], retries: 9 } }), /"retries" must be a whole number from 0 to 3/);
  assert.match(problems({ deploy: { run: ["./d"], if_changed: { paths: [], since: "https://x.test" } } }), /"if_changed" must be/);
  assert.match(problems({ deploy: { run: ["./d"], if_changed: { paths: ["src/**"], since: "ftp://x" } } }), /"if_changed" must be/);
  assert.match(problems({ scan: { run: ["./s"], bogus: 1 } }), /has a field atelier ship does not read: bogus/);
  assert.equal(problems({ scan: { run: ["./s"] }, baseline: { run: ["./b"] } }), "");
});
