// What the parts of cli-sessions.test.mjs share (t771); the tests were split across files so none runs for more than about a minute.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";
export function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-session-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(checkout, "STATE.md"), "Current state\n");
  git("add", ".");
  git("commit", "-qm", "Initial");
  const head = git("rev-parse", "HEAD");
  const baseline = join(dir, "baseline.git");
  git("clone", "--bare", checkout, baseline);
  writeFileSync(join(checkout, "loose.txt"), "uncommitted\n");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", projects: { demo: { path: checkout, branch: git("branch", "--show-current") } } }));
  const preload = join(dir, "server.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const originalSpawn = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  appendFileSync(${JSON.stringify(join(dir, "git.jsonl"))}, JSON.stringify(args) + "\\n");
  if (command === "git" && args.some((arg) => arg === "--force" || arg === "--force-with-lease" || arg.startsWith("+"))) throw Error("force push forbidden");
  return originalSpawn(command, args, options);
};
syncBuiltinESMExports();
const previous = { actor: "owner", at: "2026-10-04T12:00:00Z", data: { summary: "Previous", next: "Continue", head: ${JSON.stringify(head)}, dirty: false, checks: [], checksSkipped: false } };
let taskCount = 0;
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname;
  if (path === "/api/version") return Response.json({ capabilities: ${JSON.stringify(SERVER_CAPABILITIES)} });
  appendFileSync(${JSON.stringify(join(dir, "requests.jsonl"))}, JSON.stringify({ method: options.method, path, body: options.body }) + "\\n");
  let result;
  if (options.method === "POST") {
    if (path.endsWith("/baseline-token")) result = { token: "fake", remote: ${JSON.stringify(baseline)} };
    else if (path.endsWith("/items")) result = { id: "t" + (++taskCount) };
    else if (path !== "/api/projects/demo/sessions") throw Error("unexpected write");
    else result = { actor: "owner", at: "2026-10-05T12:00:00Z", data: JSON.parse(options.body) };
  } else if (path.endsWith("/standing")) result = { project: { name: "demo", title: "Demo" }, generatedAt: "2026-10-05T12:00:00Z", live: [], waiting: [], queued: [], merged: [], handoffs: [], partial: [], controlPlane: null };
  else if (path.endsWith("/baseline-head")) result = { head: ${JSON.stringify(head)} };
  else if (path.endsWith("/sessions")) result = [previous];
  else if (path === "/api/projects/demo") result = { project: { policy: { checks: JSON.parse(process.env.FAKE_CHECKS ?? '["exit 7"]'), ...(process.env.FAKE_IDENTITY ? { commitIdentity: JSON.parse(process.env.FAKE_IDENTITY) } : {}) } } };
  else throw Error("unexpected route " + path);
  return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
};
`);
  const runWith = (env, ...args) => spawnSync(process.execPath, ["--import", preload, cli, ...args], { cwd: checkout, encoding: "utf8", env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "owner", GIT_CONFIG_NOSYSTEM: "1", ...env } });
  const run = (...args) => runWith({}, ...args);
  // The same command started rather than awaited, so a test can signal it.
  const spawnWith = (env, ...args) => spawn(process.execPath, ["--import", preload, cli, ...args], { cwd: checkout, stdio: "ignore", env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "owner", GIT_CONFIG_NOSYSTEM: "1", ...env } });
  // A command that refuses before any request leaves no log.
  const requests = () => existsSync(join(dir, "requests.jsonl")) ? readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
  const clean = () => rmSync(join(checkout, "loose.txt"));
  // Every git command the CLI ran, as its argument list; the preload logs them.
  const gitCalls = () => existsSync(join(dir, "git.jsonl")) ? readFileSync(join(dir, "git.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
  return { dir, checkout, git, head, baseline, run, runWith, spawnWith, requests, clean, gitCalls };
}
export function snapshot(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? snapshot(join(dir, e.name)) : [[join(dir, e.name), createHash("sha256").update(readFileSync(join(dir, e.name))).digest("hex")]]);
}
export function remote(f, name) {
  const path = join(f.dir, name + ".git");
  f.git("init", "--bare", path);
  f.git("remote", "add", name, path);
  return path;
}
export const cli = resolve("cli/atelier.mjs");
