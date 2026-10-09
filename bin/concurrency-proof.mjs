#!/usr/bin/env node
// t339: a concurrency proof.
//
// Drives N simulated agents against a throwaway project on the live server,
// using the same request protocol the CLI uses: the owner token as a bearer
// header, x-atelier-actor naming the agent, the /api prefix, and a JSON body.
// It proves three things by measuring them:
//
//   1. claim spread  — N agents claim N tasks at once; all succeed, each
//      gets its own fork;
//   2. claim race    — N agents race for one task; exactly one wins and the
//      other N-1 are refused with the holder named;
//   3. pushes        — with --push, each of the N agents pushes a tiny commit
//      to its own fork and the push is observed (without --push, no pushes);
//
// then reports throughput, median and p90 latency, errors, and the cost of
// the run, and abandons every task it created. Every figure is measured on
// the run; nothing is claimed that was not observed.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_AGENTS = 1000;

const HELP = `Usage: bin/concurrency-proof.mjs --project NAME [options]

Drives N simulated agents against a throwaway project and reports what it
measured: the claim spread, the claim race and the pushes, with throughput,
median and p90 latency, errors, and the cost of the run. It then abandons
every task it created.

  --project NAME    the throwaway project to run against (required)
  --agents N        number of simulated agents, 1..${MAX_AGENTS} (default 10)
  --server URL      the server (default $ATELIER_SERVER)
  --token TOKEN     the owner token (default $ATELIER_TOKEN)
  --push            make a tiny git commit and push in the push phase;
                    without it no push is made and the phase is skipped
  --scratch DIR     where the --push workspaces go (default .scratch/concurrency-proof)
  --no-cleanup      leave the created tasks claimed instead of abandoning them
  --json            print the report as one JSON object instead of prose
  -h, --help        print this

Owner calls (creating and abandoning tasks) name ATELIER_OWNER, the
project owner's actor (as the atelier CLI is configured with it); without it the
clean-up is refused and the tasks must be abandoned by hand.

The owner token is sent only to the server named, over https (plain http is
accepted for a server on this machine alone, as the CLI accepts it).
`;

function fail(message, code = 2) {
  process.stderr.write(`concurrency-proof: ${message}\n`);
  process.exit(code);
}

function usageError(message) {
  process.stderr.write(`concurrency-proof: ${message}\n\n${HELP}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { project: null, agents: 10, server: process.env.ATELIER_SERVER, token: process.env.ATELIER_TOKEN, push: false, scratch: join(".scratch", "concurrency-proof"), cleanup: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : usageError(`--${a.slice(2)} needs a value`));
    if (a === "--project") out.project = next();
    else if (a === "--agents") out.agents = Number(next());
    else if (a === "--server") out.server = next();
    else if (a === "--token") out.token = next();
    else if (a === "--scratch") out.scratch = next();
    else if (a === "--push") out.push = true;
    else if (a === "--no-cleanup") out.cleanup = false;
    else if (a === "--json") out.json = true;
    else if (a === "-h" || a === "--help") { process.stdout.write(HELP); process.exit(0); }
    else usageError(`unknown argument: ${a}`);
  }
  if (!out.project) usageError("--project NAME is required (the throwaway project)");
  if (!Number.isInteger(out.agents) || out.agents < 1 || out.agents > MAX_AGENTS) usageError(`--agents must be an integer from 1 to ${MAX_AGENTS}`);
  if (!out.server) usageError("no server: pass --server URL or set ATELIER_SERVER");
  if (!out.token) usageError("no owner token: pass --token or set ATELIER_TOKEN");
  return out;
}

const cfg = parseArgs(process.argv.slice(2));

// The server address, refused when the owner token could be read on the way,
// as the CLI refuses it (cli/atelier.mjs insecureServer).
function server() {
  let parsed;
  try { parsed = new URL(cfg.server); } catch { return fail(`${cfg.server} is not a URL; name the server as https://HOST`); }
  if (parsed.protocol === "https:") return cfg.server;
  if (parsed.protocol === "http:" && new Set(["localhost", "127.0.0.1", "[::1]"]).has(parsed.hostname)) return cfg.server;
  return fail(`${cfg.server} is not https: the owner token goes with every request, and over plain http it would be readable on every network on the way. Name the server as https://HOST; plain http is accepted for a server on this machine alone (localhost, 127.0.0.1 or [::1])`);
}

const base = server().replace(/\/$/, "");

// The CLI's request helper, mirrored: the owner token as a bearer header, the
// actor in x-atelier-actor, a JSON body, and an error carrying the server's
// code and detail when it refuses.
// Owner calls (creating and abandoning tasks) name the owner's actor, as the
// CLI does; the server refuses an owner-token request that names no actor.
const OWNER_ACTOR = process.env.ATELIER_OWNER || "owner";

async function request(method, path, body, actor = OWNER_ACTOR) {
  const headers = { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" };
  headers["x-atelier-actor"] = actor;
  let res, text;
  try {
    res = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    text = await res.text();
  } catch (error) {
    const err = new Error(`server request failed: ${error.message}`);
    err.status = 0;
    err.error = "unreachable";
    err.detail = error.message;
    throw err;
  }
  let data;
  try { data = JSON.parse(text); } catch { data = { error: "bad_response", detail: text.slice(0, 300) }; }
  if (!res.ok) {
    const err = new Error(`${data.error ?? res.status}: ${data.detail ?? text.slice(0, 300)}`);
    err.status = res.status;
    err.error = data.error ?? String(res.status);
    err.detail = data.detail ?? text.slice(0, 300);
    throw err;
  }
  return data;
}

const P = (name) => `/projects/${encodeURIComponent(name)}`;
const ITEMS = (name) => `${P(name)}/items`;
const I = (name, id) => `${ITEMS(name)}/${encodeURIComponent(id)}`;
const actorOf = (i) => `sim/agent-${i}`;

// One timed request: whether it succeeded, what it answered, and how long it took.
async function timed(fn) {
  const start = performance.now();
  try { return { ok: true, value: await fn(), ms: performance.now() - start }; }
  catch (error) { return { ok: false, error, ms: performance.now() - start }; }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

function stats(msList) {
  const sorted = [...msList].sort((a, b) => a - b);
  return { n: sorted.length, median: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), min: sorted[0] ?? null, max: sorted[sorted.length - 1] ?? null };
}

// One git invocation as a promise over child_process.spawn, so a batch of tiny
// pushes runs the git subprocesses concurrently instead of blocking the event
// loop the way spawnSync would. The token goes through git's environment
// (http.extraHeader), never on the command line. gitActive and gitPeak count
// the live subprocesses so the proof can report how many pushes really ran
// together: serial pushes would never exceed 1, N concurrent pushes peak at N.
let gitActive = 0;
let gitPeak = 0;

function runGit(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    gitActive += 1;
    if (gitActive > gitPeak) gitPeak = gitActive;
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const settle = (fn) => (...rest) => { gitActive -= 1; fn(...rest); };
    child.on("error", settle(reject));
    child.on("close", settle((status) => {
      if (status !== 0) reject(new Error(`git ${args.join(" ")}: ${(stderr || stdout || "").trim()}`));
      else resolve(stdout.trim());
    }));
  });
}

// A tiny git push: one commit of one file pushed to the fork, awaited so its
// caller can run several of them concurrently under Promise.all.
async function tinyPush(remote, token, dir, i) {
  mkdirSync(dir, { recursive: true });
  const identity = { GIT_AUTHOR_NAME: `sim agent ${i}`, GIT_AUTHOR_EMAIL: "sim@concurrency.proof", GIT_COMMITTER_NAME: `sim agent ${i}`, GIT_COMMITTER_EMAIL: "sim@concurrency.proof" };
  const env = { ...process.env, ...identity };
  await runGit(["init", "-q", "-b", "main"], { cwd: dir, env });
  writeFileSync(join(dir, "proof.txt"), `concurrency proof: agent ${i}\n`);
  await runGit(["add", "proof.txt"], { cwd: dir, env });
  await runGit(["commit", "-q", "-m", `concurrency proof push ${i}`], { cwd: dir, env });
  const head = await runGit(["rev-parse", "HEAD"], { cwd: dir, env });
  const extra = token ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` } : {};
  await runGit(["push", "-q", remote, "HEAD:main"], { cwd: dir, env: { ...env, ...extra } });
  return head;
}

const overallStart = performance.now();

// ── phase 1: claim spread ───────────────────────────────────────────────────
// N tasks, each claimed by a different agent at once. All must succeed, each
// with its own fork.
async function claimSpread() {
  const created = [];
  for (let i = 0; i < cfg.agents; i++) {
    created.push(await request("POST", ITEMS(cfg.project), { title: `concurrency proof task ${i}` }));
  }
  const claims = await Promise.all(created.map((item, i) => timed(() => request("POST", `${I(cfg.project, item.id)}/claim`, {}, actorOf(i)))));
  const ok = claims.filter((c) => c.ok);
  const failed = claims.filter((c) => !c.ok);
  const forks = new Set(ok.map((c) => c.value.workspace?.remote ?? c.value.item?.fork).filter(Boolean));
  return { items: created, claims, ok: ok.length, failed: failed.length, distinctForks: forks.size, ms: claims.map((c) => c.ms), errors: failed.map((c) => c.error.message) };
}

// ── phase 2: claim race ─────────────────────────────────────────────────────
// One task, all N agents claiming it at once. Exactly one wins; the rest are
// refused with the holder named.
async function claimRace() {
  const [item] = [await request("POST", ITEMS(cfg.project), { title: "concurrency proof race" })];
  const claims = await Promise.all(Array.from({ length: cfg.agents }, (_, i) => timed(() => request("POST", `${I(cfg.project, item.id)}/claim`, {}, actorOf(i)))));
  const winners = claims.filter((c) => c.ok);
  const refusals = claims.filter((c) => !c.ok && c.error.error === "owned");
  const errors = claims.filter((c) => !c.ok && c.error.error !== "owned");
  const winnerActor = winners.length === 1 ? (winners[0].value.item?.owner ?? actorOf(claims.indexOf(winners[0]))) : null;
  const naming = winnerActor ? refusals.filter((r) => r.error.detail.includes(winnerActor)).length : 0;
  return { item, claims, winners: winners.length, refusals: refusals.length, namingHolder: naming, errors: errors.length, ms: claims.map((c) => c.ms), winner: winnerActor, errorList: errors.map((c) => c.error.message) };
}

// ── phase 3: pushes ─────────────────────────────────────────────────────────
// Each agent pushes a tiny commit to its own fork and the push is observed.
// Without --push, no push is made: the phase is skipped and reported as none.
async function pushes(spread) {
  if (!cfg.push) return { ran: false, ok: 0, failed: 0, ms: [], errors: [], maxConcurrent: 0 };
  const holder = spread.claims.map((c, i) => (c.ok ? { i, workspace: c.value.workspace } : null)).filter(Boolean);
  gitActive = 0;
  gitPeak = 0;
  const results = await Promise.all(holder.map(({ i, workspace }) => timed(async () => {
    const dir = join(cfg.scratch, `agent-${i}`);
    const head = await tinyPush(workspace.remote, workspace.token, dir, i);
    return request("POST", `${I(cfg.project, spread.items[i].id)}/push`, { head }, actorOf(i));
  })));
  const ok = results.filter((r) => r.ok);
  return { ran: true, ok: ok.length, failed: results.length - ok.length, ms: results.map((r) => r.ms), errors: results.filter((r) => !r.ok).map((r) => r.error.message), maxConcurrent: gitPeak };
}

// ── cleanup ─────────────────────────────────────────────────────────────────
// Abandon every task the proof created, as the owner.
async function cleanup(items) {
  const results = await Promise.all(items.map((item) => timed(() => request("POST", `${I(cfg.project, item.id)}/abandon`, { note: "concurrency proof cleanup" }))));
  const ok = results.filter((r) => r.ok);
  return { ok: ok.length, failed: results.length - ok.length, ms: results.map((r) => r.ms), errors: results.filter((r) => !r.ok).map((r) => r.error.message) };
}

const spread = await claimSpread();
const race = await claimRace();
const pushesResult = await pushes(spread);
const abandoned = cfg.cleanup ? await cleanup([...spread.items, race.item]) : { ok: 0, failed: 0, ms: [], errors: [], skipped: true };

const wallMs = performance.now() - overallStart;
// Every request the proof sent, including the N+1 that created the tasks and
// the one that created the race item, so the reported cost counts the whole run.
const createdTasks = spread.items.length + 1;
const totalRequests = createdTasks + spread.claims.length + race.claims.length + (pushesResult.ran ? spread.ok : 0) + (cfg.cleanup ? spread.items.length + 1 : 0);

function phaseLine(name, requests, ok, refused, failed, s, errors) {
  const thru = s.n ? (requests / (s.max / 1000)).toFixed(0) : 0;
  const parts = [`${name}: ${requests} requests, ${ok} ok`];
  if (refused) parts.push(`${refused} refused`);
  if (failed) parts.push(`${failed} errors`);
  parts.push(`median ${s.median === null ? "—" : s.median.toFixed(1)}ms, p90 ${s.p90 === null ? "—" : s.p90.toFixed(1)}ms, ~${thru} req/s`);
  if (errors.length) parts.push(`[${errors.join("; ")}]`);
  return parts.join(", ");
}

if (cfg.json) {
  const report = {
    server: base, project: cfg.project, agents: cfg.agents, push: cfg.push,
    wallMs: Math.round(wallMs * 1000) / 1000, requests: totalRequests, created: createdTasks,
    phases: {
      claimSpread: { created: spread.items.length, requests: spread.claims.length, ok: spread.ok, distinctForks: spread.distinctForks, failed: spread.failed, ...stats(spread.ms), errors: spread.errors },
      claimRace: { created: 1, requests: race.claims.length, winner: race.winner, winners: race.winners, refused: race.refusals, namingHolder: race.namingHolder, errors: race.errors, ...stats(race.ms), errorList: race.errorList },
      pushes: pushesResult.ran ? { requests: spread.ok, ok: pushesResult.ok, failed: pushesResult.failed, maxConcurrent: pushesResult.maxConcurrent, ...stats(pushesResult.ms), errors: pushesResult.errors } : { requests: 0, ok: 0, failed: 0, skipped: true },
      cleanup: cfg.cleanup ? { requests: spread.items.length + 1, ok: abandoned.ok, failed: abandoned.failed, ...stats(abandoned.ms), errors: abandoned.errors } : { skipped: true },
    },
    cost: { wallSeconds: Math.round(wallMs / 1000 * 1000) / 1000, requests: totalRequests, pushes: pushesResult.ran ? pushesResult.ok : 0, modelCalls: 0, modelCostUsd: 0 },
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  const lines = [
    `concurrency proof: ${cfg.agents} agents against ${cfg.project} on ${base}`,
    ``,
    phaseLine("claim spread", spread.claims.length, spread.ok, 0, spread.failed, stats(spread.ms), spread.errors) + `, ${spread.distinctForks} distinct forks`,
    phaseLine("claim race", race.claims.length, race.winners, race.refusals, race.errors, stats(race.ms), race.errorList) + `, winner ${race.winner ?? "none"}, ${race.namingHolder}/${race.refusals} refusals name the holder`,
    pushesResult.ran
      ? phaseLine("pushes", spread.ok, pushesResult.ok, 0, pushesResult.failed, stats(pushesResult.ms), pushesResult.errors) + `, ${pushesResult.maxConcurrent} concurrent`
      : `pushes: none (run with --push for tiny pushes)`,
    cfg.cleanup ? phaseLine("cleanup", spread.items.length + 1, abandoned.ok, 0, abandoned.failed, stats(abandoned.ms), abandoned.errors) : `cleanup: skipped (--no-cleanup)`,
    ``,
    `throughput ${(totalRequests / (wallMs / 1000)).toFixed(0)} req/s over ${(wallMs / 1000).toFixed(3)}s, ${totalRequests} requests`,
    `cost ${(wallMs / 1000).toFixed(3)}s wall, ${totalRequests} requests, ${pushesResult.ran ? pushesResult.ok : 0} pushes, $0.00 model calls (agents simulated)`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

const failures = spread.failed + race.errors + pushesResult.failed + (cfg.cleanup ? abandoned.failed : 0);
if (failures > 0 || spread.distinctForks !== cfg.agents || race.winners !== 1 || (pushesResult.ran && pushesResult.ok !== spread.ok)) {
  process.exit(1);
}
