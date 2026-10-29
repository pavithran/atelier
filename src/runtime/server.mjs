// The Atelier server under Node (Atelier 2.0, task 1; design section 4.2):
// one process serving `src/index.ts`'s `fetch` over Node's `http`, with the
// Ledger Durable Objects as SQLite files under the environment's data
// directory (src/runtime/namespace.mjs). Artifacts reads the bare
// repositories and `large` is files (src/git/artifacts.mjs, large.mjs); the
// Artifacts writes refuse with `not_supported` until the tasks that replace
// them land. The landing Workflow is gone (task 6). The Worker's crons are
// timers here and its push queue the post-receive hook's POST (task 8).
//
// Settings come from three places, later ones winning: defaults for the
// environment, the process environment (only the names in SETTINGS), and a
// secrets directory holding one file per name (mode 600, as
// /Users/atelierd/secrets is). Nothing read from either is written to disk.
import "./loader.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statfsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { Namespace } from "./namespace.mjs";
import { GitHost, INTERNAL_ROUTES } from "../git/host.mjs";
import { Timers, realClock } from "./timers.mjs";
import { ledgerLocks } from "./ledger-locks.mjs";
import { LocalArtifacts } from "../git/artifacts.mjs";
import { LocalLarge } from "./large.mjs";

export const SETTINGS = [
  "ATELIER_TOKEN", "OWNER_ACTOR", "OWNER_NAME", "TIMEZONE", "PUBLIC_ORIGIN", "DEPLOYED_MAIN", "OVERRIDE_SECRET",
  "NTFY_TOPIC", "CUSTODY_TOKEN", "CF_ACCOUNT_ID", "CF_ACCESS_OWNER_EMAIL", "CF_ACCESS_ISS", "CF_ACCESS_AUD",
  "ANALYTICS_TOKEN", "AI_GATEWAY_ID", "SOURCE_PROJECT", "ATELIER_REVIEW_DIFF_MAX",
  "USAGE_WINDOW_PERCENT", "USAGE_WEEKLY_PERCENT", "USAGE_DAILY_SPEND", "USAGE_BALANCE_FLOOR",
];
const NAME = /^[A-Z][A-Z0-9_]*$/;

export function readSecrets(dir) {
  const out = {};
  if (!dir) return out;
  for (const name of readdirSync(dir)) {
    if (!NAME.test(name)) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    out[name] = readFileSync(path, "utf8").trim();
  }
  return out;
}

function deployedMain() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: new URL("../..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return undefined; }
}

export function settings({ env, port, secretsDir, vars = {}, processEnv = process.env }) {
  const out = { AI_GATEWAY_ID: "atelier", PUBLIC_ORIGIN: `http://localhost:${port}`, DEPLOYED_MAIN: deployedMain(), ATELIER_ENV: env };
  for (const name of SETTINGS) if (processEnv[name]?.trim()) out[name] = processEnv[name].trim();
  Object.assign(out, readSecrets(secretsDir), vars);
  for (const [k, v] of Object.entries(out)) if (v === undefined) delete out[k];
  return out;
}

// The origin a Git remote is given at for a request that reached this
// process directly on its tailnet or loopback address: http://ADDRESS:PORT,
// the address the connection was accepted on (design section 4.3: builders
// push over the tailnet, which WireGuard encrypts). It is read from the
// socket, never from the Host header the caller chose. A loopback request
// that came through the tunnel (cloudflared, on this machine, names the
// caller in cf-connecting-ip or x-forwarded-for) and any other request are
// given the public origin (null here).
export const GIT_ORIGIN_HEADER = "x-atelier-git-origin";
export function gitOrigin({ localAddress, localPort, headers = {} } = {}) {
  if (typeof localAddress !== "string" || !Number.isInteger(localPort)) return null;
  const address = localAddress.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  const tailnet = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (tailnet && Number(tailnet[1]) >= 64 && Number(tailnet[1]) <= 127) return `http://${address}:${localPort}`;
  const loopback = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address) || address === "::1";
  if (!loopback || headers["cf-connecting-ip"] !== undefined || headers["x-forwarded-for"] !== undefined) return null;
  return `http://${address === "::1" ? "[::1]" : address}:${localPort}`;
}

async function toRequest(req, origin) {
  const url = new URL(req.url ?? "/", origin);
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() !== GIT_ORIGIN_HEADER) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  const git = gitOrigin({ localAddress: req.socket?.localAddress, localPort: req.socket?.localPort, headers: req.headers });
  if (git) headers.set(GIT_ORIGIN_HEADER, git);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req);
  return new Request(url, { method: req.method, headers, body, duplex: body ? "half" : undefined });
}

async function send(res, response, head) {
  const headers = {};
  response.headers.forEach((v, k) => { if (k !== "set-cookie") headers[k] = v; });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, response.statusText || undefined, headers);
  if (head || !response.body) return res.end();
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}

// Starts a server for one environment. dataDir: where its Ledgers live
// (created mode 700). Resolves once it listens, to { url, port, env,
// namespace, close }.
// `bindings` replaces ARTIFACTS or LARGE with a
// test's own until the tasks that replace them land.
// reposDir holds the bare repositories (default DATA/repos), hooksDir the
// hooks they name (default the checkout's hooks/).
// `timers` runs the Worker's three crons on timers (src/runtime/timers.mjs):
// on by default in production and staging, off in a test server unless
// given; `{ clock }` drives them with a test's clock, false turns them off.
export async function startServer({ env = "staging", dataDir, reposDir, hooksDir, port = 0, host = "0.0.0.0", secretsDir, vars, bindings: given = {}, timers: timing = env !== "test" } = {}) {
  if (env !== "production" && env !== "staging" && env !== "test") throw new Error(`--env is production or staging, not ${env}`);
  if (!dataDir) throw new Error("--data DIR names the environment's data directory");
  process.umask(0o077);
  const dir = resolve(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { Ledger, default: worker, observePushed, recordStageTicks, recordStuckEpisodes, takeModelSnapshots } = await import("../index.ts");
  const { LIMITS } = await import("../limits.ts");
  globalThis.caches ??= { default: { match: async () => undefined, put: async () => undefined, delete: async () => false } };
  const repos = resolve(reposDir ?? join(dir, "repos"));
  const artifacts = new LocalArtifacts({ reposDir: repos });
  // DISK: the free space of the volume the data directory is on, which
  // `atelier situation` reports (G4).
  const disk = { read: () => { const s = statfsSync(dir); return { path: dir, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }; } };
  const bindings = { ARTIFACTS: artifacts, LARGE: new LocalLarge(join(dir, "large")), DISK: disk, ...given };
  const workerEnv = {};
  const namespace = new Namespace({ dir, Class: Ledger, env: workerEnv });
  const git = new GitHost({ dataDir: dir, reposDir: repos, hooksDir, namespace, settings: workerEnv });
  bindings.GIT ??= git.binding();
  // Every Ledger change that ends or rotates a task's grant waits for the
  // pushes in flight on the task (src/runtime/ledger-locks.mjs).
  namespace.around = ledgerLocks(git, (name) => namespace.get(namespace.idFromName(name)));
  // A push to a task's branch is recorded as its holder's push once the ref
  // moved, from the post-receive hook's POST (src/git/host.mjs). A failure
  // is logged here and answered 500, which the hook logs too.
  git.onPushed = async (notice) => {
    try { return await observePushed(workerEnv, notice); }
    catch (err) { console.error(`the push of ${notice.ref} to ${notice.project} was not recorded: ${err?.message ?? err}`); throw err; }
  };
  const pending = new Set();
  const server = createServer(async (req, res) => {
    // A request target is a path: one that does not start with a single
    // "/" (an absolute form such as http://evil.example/api/..., or
    // //evil.example/...) would name another origin than this server's.
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) {
      req.resume();
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("the request target must be a path starting with one /\n");
      return;
    }
    if (req.url?.startsWith("/git/") && !req.url.startsWith("/git/runner/")) {
      const done = git.handle(req, res).then((handled) => { if (!handled) { res.writeHead(404, { "content-type": "text/plain" }); res.end("no such Git route\n"); } })
        .catch((err) => { console.error("git request failed:", err); if (!res.headersSent) { res.writeHead(500); res.end(); } else res.destroy(); });
      pending.add(done);
      done.finally(() => pending.delete(done));
      return;
    }
    const kept = [];
    const ctx = { waitUntil: (p) => kept.push(Promise.resolve(p).catch((err) => console.error("work kept after a request failed:", err))), passThroughOnException() {}, props: {} };
    const done = (async () => {
      try {
        const request = await toRequest(req, workerEnv.PUBLIC_ORIGIN);
        await send(res, await worker.fetch(request, workerEnv, ctx), req.method === "HEAD");
      } catch (err) {
        console.error(`${req.method} ${(req.url ?? "").split("?")[0]} failed:`, err);
        if (!res.headersSent) { res.writeHead(500, { "content-type": "text/plain" }); res.end("internal error\n"); } else res.destroy();
      }
      await Promise.all(kept);
    })();
    pending.add(done);
    done.finally(() => pending.delete(done));
  });
  server.keepAliveTimeout = 65_000;
  // The hooks' grant check and push notice (INTERNAL_ROUTES) have a listener
  // of their own on the loopback address, whatever address the server itself
  // listens on (a tailnet one included), and it answers nothing else.
  const internal = createServer((req, res) => {
    if (!INTERNAL_ROUTES.has(req.url)) { req.resume(); res.writeHead(404); res.end(); return; }
    const done = git.handleInternal(req, res).catch((err) => { console.error(`${req.url} failed:`, err.message); if (!res.headersSent) { res.writeHead(500); res.end(); } else res.destroy(); });
    pending.add(done);
    done.finally(() => pending.delete(done));
  });
  await new Promise((ok, fail) => { internal.once("error", fail); internal.listen(0, "127.0.0.1", ok); });
  git.listening(internal.address());
  try { await new Promise((ok, fail) => { server.once("error", fail); server.listen(port, host, ok); }); }
  catch (error) { internal.close(); throw error; }
  const bound = server.address().port;
  Object.assign(workerEnv, settings({ env, port: bound, secretsDir, vars }), bindings, { LEDGER: namespace });
  namespace.start();
  // The Worker's crons (wrangler.jsonc gave scheduled() three), at the
  // periods src/limits.ts names, each given the moment it was due, as
  // scheduledTime was.
  const indexStub = () => namespace.get(namespace.idFromName("__index"));
  const ticking = timing ? new Timers({
    clock: timing.clock ?? realClock,
    store: { last: (job) => indexStub().timerLast(job), ran: (job, at) => indexStub().timerRan(job, at) },
    jobs: [
      { name: "stage tick", every: LIMITS.timers.stageTickMs, run: (at) => recordStageTicks(workerEnv, at) },
      { name: "stuck episodes", every: LIMITS.timers.stuckEpisodesMs, run: (at) => recordStuckEpisodes(workerEnv, at) },
      { name: "model snapshots", every: LIMITS.timers.modelSnapshotsMs, offset: LIMITS.timers.modelSnapshotsOffsetMs, run: (at) => takeModelSnapshots(workerEnv, at.getTime()) },
    ],
  }).start() : null;
  const url = `http://localhost:${bound}`;
  let closing;
  const close = () => closing ??= (async () => {
    // The timers stop first, and a run in flight finishes; then no new
    // connections; requests in flight finish; then every connection closes,
    // kept-alive ones included.
    await ticking?.stop();
    const closed = new Promise((ok) => server.close(() => ok()));
    server.closeIdleConnections();
    await Promise.all([...pending]);
    server.closeAllConnections();
    await closed;
    await new Promise((ok) => { internal.close(() => ok()); internal.closeAllConnections(); });
    await namespace.close();
    git.close();
    artifacts.close();
  })();
  return { url, port: bound, env, namespace, git, close, settings: workerEnv, timers: ticking };
}
