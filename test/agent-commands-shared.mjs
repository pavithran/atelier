// What the parts of agent-commands.test.mjs share (t771); the tests were split across files so none runs for more than about a minute.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";
export const cli = resolve("cli/atelier.mjs");
export const actor = "codex/test";
export const brief = {
  title: "Small edit", decided: "Review t1 at abcdef01: Small edit.", summary: "Edited docs",
  evidence: ["Required checks at this revision: 1 passed on a runner, in a clean clone.", "Reviews at this revision: opus approved."],
  recommendation: { verdict: "review", reason: "A protected path needs approval." },
};
export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
export const head = "a".repeat(40), passed = [{ claim: "npm test", result: "passed", where: "in a clean clone on this machine" }];
export async function fixture(t, { failed = false, dirtyWorkspace = false, blockers = [], failStep, sandbox = false, policy = {}, kind, evidence = [], logs = {}, prepare = null, env = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atelier-agent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "cache", "work", "proj", "t1");
  const source = join(root, "source"), remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  git(source, "config", "user.name", "Test Owner");
  git(source, "config", "user.email", "owner@example.test");
  git(source, "commit", "-q", "--allow-empty", "-m", "Initial");
  execFileSync("git", ["clone", "-q", "--bare", source, remote]);
  // The one repository holds the project's branch and the task's (t/1), as the server's does.
  git(remote, "branch", "t/1", "main");
  const head = git(source, "rev-parse", "HEAD");
  const item = { id: "t1", ...(kind ? { kind } : {}), title: brief.title, scope: ["docs/**"], owner: actor, state: "claimed", head, dispatch: { note: "Keep examples" } };
  const gate = { ready: !blockers.length, blockers };
  const posts = [], requests = [];
  const command = dirtyWorkspace ? `printf drift > ${workspace}/drift.txt; exit 1` : failed ? "exit 1" : "exit 0";
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const path = req.url;
    // The capability check before new, edit and review (t458) reads the version.
    if (path === "/api/version") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ capabilities: SERVER_CAPABILITIES })); }
    requests.push(path);
    if (req.method === "POST") posts.push({ path, body: JSON.parse(raw) });
    if (req.method === "POST" && path.endsWith("/submit")) item.state = "submitted";
    // A stored check log by its sha256 (src/large.ts), as text; 404 for one not held.
    const stored = /\/logs\/([a-f0-9]{64})$/.exec(path);
    if (stored) {
      const text = logs[stored[1]];
      res.writeHead(text === undefined ? 404 : 200, { "content-type": text === undefined ? "application/json" : "text/plain; charset=utf-8" });
      res.end(text === undefined ? JSON.stringify({ error: "no_such_payload", detail: "nothing is stored" }) : text);
      return;
    }
    let data = { item, gate, policy: { checks: [command], ...(sandbox ? { sandboxOnly: true } : {}), ...policy }, evidence };
    if (path === "/api/projects/proj") data = { project: { policy: { prepare } }, items: [item] };
    if (path === "/api/projects") data = [{ name: "proj", title: "Proj" }];
    if (path === "/api/runners") data = [];
    if (path.endsWith("/claim")) data = { item, workspace: { token: "fake", remote, branch: "t/1", defaultBranch: "main", expiresAt: "tomorrow" }, baseline: { defaultBranch: "main" }, commitIdentity: { name: "Test Owner", email: "owner@example.test", agentEmails: [] } };
    if (path.endsWith("/push")) data = { ...item, head: git(remote, "rev-parse", "refs/heads/t/1") };
    if (path.endsWith("/git-token")) data = { kind: "read", remote, token: "fake", expiresAt: "tomorrow", defaultBranch: "main", repository: "server", ...(JSON.parse(raw).item ? { branch: "t/1", into: "main", head, base: head } : {}) };
    if (path.endsWith("/brief")) data = brief;
    if (path.split("?")[0].endsWith("/inbox")) data = [{ project: "proj", itemId: "t1", title: item.title, kind: "accept", reason: "all checks observed passing at this head", weight: 100 }];
    const broken = failStep && path.endsWith(`/${failStep}`) && (failStep !== "git-token" || requests.filter((p) => p.endsWith("/git-token")).length === 1);
    res.writeHead(broken ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(broken ? { error: "unavailable", detail: "try later" } : data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { proj: { path: source } } }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function run(argv, cwd = source) {
    const child = spawn(process.execPath, [cli, ...argv], { cwd, env: { ...process.env, ATELIER_ACTOR: actor, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: origin, ...env } });
    let output = "", stdout = "";
    child.stdout.on("data", (s) => { output += s; stdout += s; });
    child.stderr.on("data", (s) => output += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, output, stdout };
  }
  return { run, workspace, posts, requests, origin, remote, head };
}
