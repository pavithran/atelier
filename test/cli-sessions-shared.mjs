// What the parts of cli-sessions.test.mjs share (t771); the tests were split across files so none runs for more than about a minute.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";
export function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "atelier-session-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Keep the real scheduler, but give this fixture its own fixed pool. The
  // copied module's SLOT_WRAPPER also isolates children with scrubbed envs.
  const slotPool = join(dir, "slots.sqlite"), slotWrapper = join(dir, "load.mjs");
  const slotModule = new URL("../cli/load.mjs", import.meta.url);
  const slotSource = readFileSync(slotModule, "utf8");
  const declaration = 'export const HOST_POOL = "/tmp/atelier-test-slots-v1.sqlite";';
  if (slotSource.split(declaration).length !== 2) throw Error("cannot isolate the session test pool");
  const isolation = join(dir, "isolate.mjs"), slotLog = join(dir, "slot-opens.jsonl");
  const opening = "  const db = new DatabaseSync(options.path ?? HOST_POOL);";
  if (slotSource.split(opening).length !== 2) throw Error("cannot guard the session test pool");
  // Guard the scheduler's database opening in this test copy, including in
  // descendants whose environment drops the module hook. SQLite stays real.
  const guardedOpening = `  const requestedPath = options.path ?? HOST_POOL;
  const allowed = resolve(requestedPath) === HOST_POOL;
  appendFileSync(${JSON.stringify(slotLog)}, JSON.stringify({ path: requestedPath, allowed }) + "\\n");
  if (!allowed) throw Error("session fixture refused a database outside its temporary pool");
${opening}`;
  writeFileSync(slotWrapper, 'import { appendFileSync } from "node:fs";\n' + slotSource
    .replace(declaration, `export const HOST_POOL = ${JSON.stringify(slotPool)};`)
    .replace(opening, guardedOpening));
  writeFileSync(isolation, `
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  return result.url === ${JSON.stringify(slotModule.href)}
    ? { ...result, url: ${JSON.stringify(pathToFileURL(slotWrapper).href)} } : result;
} });
`);
  const validateIsolation = join(dir, "validate-isolation.mjs");
  writeFileSync(validateIsolation, `import { HOST_POOL, SLOT_WRAPPER } from ${JSON.stringify(slotModule.href)};
if (HOST_POOL !== ${JSON.stringify(slotPool)} || SLOT_WRAPPER !== ${JSON.stringify(slotWrapper)}) {
  throw Error("session fixture scheduler isolation was not installed");
}`);
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
  const environment = (extra) => {
    const env = { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "owner", GIT_CONFIG_NOSYSTEM: "1", ...extra };
    // Reusing an outer lease in a different pool could signal that outer tree
    // during cleanup. Only descendants inside this fixture share its lease.
    delete env.ATELIER_TEST_LEASE;
    env.ATELIER_TEST_SLOTS = "1";
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ""} --import=${pathToFileURL(isolation).href}`.trim();
    return env;
  };
  const runWith = (env, ...args) => spawnSync(process.execPath, ["--import", validateIsolation, "--import", preload, cli, ...args], { cwd: checkout, encoding: "utf8", env: environment(env) });
  const run = (...args) => runWith({}, ...args);
  // The same command started rather than awaited, so a test can signal it.
  const spawnWith = (env, ...args) => spawn(process.execPath, ["--import", validateIsolation, "--import", preload, cli, ...args], { cwd: checkout, stdio: "ignore", env: environment(env) });
  const slotOpens = () => existsSync(slotLog) ? readFileSync(slotLog, "utf8").trim().split("\n").map(JSON.parse) : [];
  // A command that refuses before any request leaves no log.
  const requests = () => existsSync(join(dir, "requests.jsonl")) ? readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
  const clean = () => rmSync(join(checkout, "loose.txt"));
  // Every git command the CLI ran, as its argument list; the preload logs them.
  const gitCalls = () => existsSync(join(dir, "git.jsonl")) ? readFileSync(join(dir, "git.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
  return { dir, checkout, git, head, baseline, run, runWith, spawnWith, requests, clean, gitCalls, slotPool, slotWrapper, slotOpens };
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
