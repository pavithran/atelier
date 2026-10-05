#!/usr/bin/env node
// atelier — the command agents and the project owner run. No dependencies: Node and git.
//
// Agents work in a workspace clone under ~/Library/Caches, never in the iCloud
// checkout. Checks run in a second, clean clone of exactly the head Atelier
// sees in Artifacts. Only `atelier merge`, run by the project owner, touches
// the checkout.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { redactGitArgs } from "./runner.mjs";

import { landingJournal, landingLock } from "./landing.mjs";
import { applyIdentity } from "./identity.mjs";
import { collectCache, markerPath } from "./gc.mjs";
import { formatStatus } from "./status.mjs";

const HOME = homedir();
const CONFIG_DIR = process.env.ATELIER_CONFIG_DIR ?? join(HOME, ".config", "atelier");
const CONFIG = join(CONFIG_DIR, "config.json");
const CACHE = process.env.ATELIER_CACHE ?? join(HOME, "Library", "Caches", "ai-projects", "cloudflare-git");
const CHECK_TIMEOUT_MS = Number(process.env.ATELIER_CHECK_TIMEOUT ?? 20 * 60_000);

// ── plumbing ───────────────────────────────────────────────────────────────

function die(msg, code = 1) {
  process.stderr.write(`atelier: ${msg}\n`);
  process.exit(code);
}

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG, "utf8")); } catch { return { server: null, projects: {} }; }
}
function saveConfig(c) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

function apiToken() {
  if (process.env.ATELIER_TOKEN) return process.env.ATELIER_TOKEN.trim();
  const r = spawnSync("security", ["find-generic-password", "-s", "atelier.API_TOKEN", "-w"], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  die("no API token: add Keychain item atelier.API_TOKEN, or set ATELIER_TOKEN");
}

function git(args, opts = {}) {
  const r = spawnSync("git", args, { encoding: "utf8", cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const shown = redactGitArgs(args);
  let detail = (r.stderr || r.stdout || "").trim();
  for (const [i, arg] of args.entries()) {
    if (shown[i] === "[redacted]") detail = detail.split(arg).join("[redacted]");
  }
  if (r.status !== 0 && !opts.allowFail) die(`git ${shown.join(" ")} failed:\n${detail}`);
  return opts.allowFail ? r : r.stdout.trim();
}

// Tokens go in a per-command header, never in a remote URL or the iCloud tree.
const auth = (token) => ["-c", `http.extraHeader=Authorization: Bearer ${token}`];

function parseArgs(argv) {
  const out = { _: [], multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out.rest = argv.slice(i + 1); break; }
    if (a.startsWith("--")) {
      // --key=value carries its value; --key VALUE takes the next word unless it is a flag.
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const next = argv[i + 1];
      const val = eq !== -1 ? a.slice(eq + 1) : next === undefined || next.startsWith("--") ? true : (i++, next);
      (out.multi[key] ??= []).push(val);
      out[key] = val;
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig();

// The server says which actor stands for the project owner; `login` records it.
const OWNER = process.env.ATELIER_OWNER ?? cfg.owner ?? "owner";
const OWNER_NAME = cfg.ownerName ?? "the project owner";

function server() {
  const s = process.env.ATELIER_SERVER ?? cfg.server;
  if (!s) die("no server: run `atelier login --server https://…`");
  return s.replace(/\/$/, "");
}

function wsConfig(key, cwd = process.cwd()) {
  const r = spawnSync("git", ["config", "--local", `atelier.${key}`], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function actor(fallback) {
  const a = args.as ?? process.env.ATELIER_ACTOR ?? wsConfig("actor") ?? fallback;
  if (!a) die("say who you are: --as harness/model (e.g. claude-code/opus-5.5), or set ATELIER_ACTOR");
  return a;
}

function project() {
  if (args.project) return args.project;
  const fromWs = wsConfig("project");
  if (fromWs) return fromWs;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status === 0) {
    const here = top.stdout.trim();
    for (const [name, p] of Object.entries(cfg.projects ?? {})) if (resolve(p.path) === here) return name;
  }
  die("which project? pass --project NAME, or run inside a registered checkout or workspace");
}

// --summary takes text; a bare flag or an empty or blank value is refused, not dropped.
function summaryArg(cmd) {
  if (args.summary === undefined) return;
  if (typeof args.summary !== "string" || !args.summary.trim()) die(`--summary needs text: atelier ${cmd} ID --summary "TEXT"`);
}

function itemArg(i = 1) {
  const id = args._[i] ?? wsConfig("item");
  if (!id) die("which item? pass its id (t3) or run inside its workspace");
  return id;
}

async function call(method, path, body, as, extra = {}) {
  let res, text;
  try {
    res = await fetch(server() + "/api" + path, {
      method,
      headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": as, "content-type": "application/json", ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    text = await res.text();
  } catch (error) { die(`server request failed: ${error.message}`, 4); }
  let data;
  try { data = JSON.parse(text); } catch { data = { error: "bad_response", detail: text.slice(0, 300) }; }
  if (!res.ok) die(`${data.error ?? res.status}: ${data.detail ?? text.slice(0, 300)}`,
    res.status >= 500 || res.status === 408 || res.status === 429 ? 4 :
      method === "POST" && path.endsWith("/claim") && res.status >= 400 && res.status < 500 ? 3 : 1);
  return data;
}

const P = (name) => `/projects/${encodeURIComponent(name)}`;
const I = (name, id) => `${P(name)}/items/${encodeURIComponent(id)}`;
const short = (s) => (s ? s.slice(0, 8) : "—");

function workspacePath(name, id) {
  return join(CACHE, "work", name, id);
}

// ── clean-room checks ──────────────────────────────────────────────────────

function cleanClone(remote, token, head, baseline, name) {
  mkdirSync(join(CACHE, "checks"), { recursive: true });
  const dir = mkdtempSync(join(CACHE, "checks", "run-"));
  writeFileSync(markerPath(dir), JSON.stringify({ version: 1, project: name, pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
  git([...auth(token), "clone", "--quiet", remote, dir]);
  git(["checkout", "--quiet", "--detach", head], { cwd: dir });
  let changed = [];
  if (baseline) {
    git([...auth(baseline.token), "fetch", "--quiet", baseline.remote, baseline.defaultBranch], { cwd: dir });
    const mb = git(["merge-base", "FETCH_HEAD", "HEAD"], { cwd: dir, allowFail: true });
    if (mb.status === 0) {
      changed = git(["diff", "--name-only", mb.stdout.trim(), "HEAD"], { cwd: dir }).split("\n").filter(Boolean);
    }
  }
  return { dir, changed };
}

async function runCheck(cmd, dir) {
  process.stderr.write(`atelier: running \`${cmd}\` in a clean clone…\n`);
  const record = JSON.parse(readFileSync(markerPath(dir), "utf8"));
  const r = await new Promise((done) => {
    const child = spawn("/bin/sh", ["-c", cmd], { cwd: dir, timeout: CHECK_TIMEOUT_MS });
    writeFileSync(markerPath(dir), JSON.stringify({ ...record, childPid: child.pid }));
    let stdout = "", stderr = "", error, bytes = 0;
    const append = (key, chunk) => {
      if (error) return;
      bytes += Buffer.byteLength(chunk);
      if (key === "stdout") stdout += chunk; else stderr += chunk;
      if (bytes > 64 * 1024 * 1024) {
        error = new Error("check output exceeds 64 MiB");
        child.kill();
        stdout = stdout.slice(-32 * 1024 * 1024);
        stderr = stderr.slice(-32 * 1024 * 1024);
      }
    };
    child.stdout.setEncoding("utf8").on("data", (s) => append("stdout", s));
    child.stderr.setEncoding("utf8").on("data", (s) => append("stderr", s));
    child.on("error", (e) => { error = e; });
    child.on("close", (status, signal) => done({ status, stdout, stderr, error: error ?? (signal ? new Error(`check terminated by ${signal}`) : undefined) }));
  });
  writeFileSync(markerPath(dir), JSON.stringify(record));
  const output = `${r.stdout}${r.stderr}${r.error ? `\n[atelier] ${r.error.message}` : ""}`;
  return { passed: r.status === 0 && !r.error, output, sha: createHash("sha256").update(output).digest("hex") };
}

// ── ControlPlane ───────────────────────────────────────────────────────────
// Where a project is governed by ControlPlane, its policy files say who may act
// and what is protected. Atelier reads them and never writes them.

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function readControlPlane(top) {
  const dir = join(top, "docs", "control-plane");
  const agent = readJson(join(dir, "agent-policy.v1.json"));
  const exec = readJson(join(dir, "execution-policy.v1.json"));
  const adapter = readJson(join(dir, "project-adapter.v1.json"));
  if (!agent && !exec) return null;
  const sources = [];
  const protectedPaths = new Set(["AGENTS.md", "CLAUDE.md", "GLM.md", "docs/control-plane/**", "tools/control-plane/**"]);
  let eligible = null;
  let refuseOverlap = null;
  if (agent) {
    sources.push("agent-policy.v1.json");
    eligible = Object.entries(agent.agents ?? {}).filter(([, a]) => a.available).map(([k]) => k);
    refuseOverlap = agent.authority?.overlapping_claims === "refuse";
  }
  if (exec) {
    sources.push("execution-policy.v1.json");
    for (const p of exec.protected_path_patterns ?? []) protectedPaths.add(p);
    for (const rule of exec.maintenance_path_rules ?? []) for (const p of rule.paths ?? []) protectedPaths.add(p);
  }
  if (adapter) {
    sources.push("project-adapter.v1.json");
    for (const s of adapter.protected_surfaces ?? []) if (s.pattern) protectedPaths.add(s.pattern);
  }
  return { sources, protected: [...protectedPaths], eligible, refuseOverlap };
}

function writeReceipt(cwd, { name, id, item, owners, view, reviews, policy, branch, notesRemote }) {
  const dir = join(cwd, "docs", "control-plane", "landing-receipts");
  if (!existsSync(dir)) return null;
  const template = readJson(join(cwd, "docs", "control-plane", "landing-receipt.v1.json")) ?? {};
  const date = new Date().toISOString().slice(0, 10);
  const file = join(dir, `${date}-atelier-${id}-${short(item.acceptedHead)}.json`);
  const receipt = {
    schema_version: 1,
    kind: "control-plane.landing-receipt",
    receipt_id: `atelier-${name}-${id}-${date}`,
    project_id: template.project_id ?? name,
    execution_class: "coordinated",
    closure: "compact",
    implementation_commit: item.acceptedHead,
    delivery: {
      kind: "atelier-merge",
      target: `${name}/${id}`,
      evidence: [
        `Atelier item ${id}, "${item.title}", worked by ${owners.join(" then ") || "nobody recorded"}, accepted by ${OWNER_NAME} at ${item.acceptedHead} and merged with --no-ff.`,
        policy.approval ? `The Atelier baseline copy in Artifacts was approved as: ${policy.approval.replace(/[.\s]*$/, "")}.` : null,
        reviews.length ? `Reviews at the accepted head: ${reviews.map((r) => `${r.by} ${r.approve ? "approved" : "rejected"}`).join("; ")}.` : "No review was required at the accepted head.",
        `Provenance is on refs/notes/atelier for the merge commit${notesRemote ? `, and that ref alone is pushed to ${notesRemote}` : ""}.`,
      ].filter(Boolean).join(" "),
    },
    tests: view.map((e) =>
      e.grade === "observed"
        ? `Observed by Atelier in a clean clone at ${short(e.head)}: \`${e.claim}\` ${e.passed ? "passed" : "failed"} (${e.by}, ${e.at})`
        : `Reported, not verified: ${e.claim} (${e.by}, ${e.at})`),
    next_gate: `${OWNER_NAME} chooses the next work. The merge is not deployed and not pushed to the project's own remotes.`,
    protected_actions_not_taken: [
      "deploy",
      notesRemote ? `push of ${branch} to the project's own remotes (only refs/notes/atelier went to ${notesRemote})` : "push to the project's own remotes",
      "migration",
      "credential change",
      "Observatory publication",
    ],
    unrelated_dirty: [],
    session_continuing: true,
  };
  writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n");
  return file.slice(cwd.length + 1);
}

// Run the project's required checks in a Cloudflare container instead of
// here. The Worker records the results itself; this only starts and waits.
async function checkInSandbox() {
  const name = project(), id = itemArg(), as = actor();
  const { runId } = await call("POST", `${I(name, id)}/sandbox`, {}, as);
  process.stderr.write(`atelier: running the checks for ${id} in a Cloudflare container (run ${runId})…\n`);
  let state;
  for (let waited = 0; ; waited += 5) {
    state = await call("GET", `${I(name, id)}/sandbox/${encodeURIComponent(runId)}`, undefined, as);
    if (state.status === "done" || state.status === "failed") break;
    if (waited > 20 * 60) die(`still ${state.status} after 20 minutes; check later with atelier show ${id}`);
    await new Promise((ok) => setTimeout(ok, 5000));
  }
  for (const r of state.results ?? []) {
    console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.claim}  @ ${short(state.request.head)}  (${r.seconds}s, in Cloudflare)`);
    if (!r.passed) process.stdout.write(r.outputTail.slice(-2000) + "\n");
  }
  if (state.changedPaths) console.log(`changed: ${state.changedPaths.join(", ") || "nothing"}`);
  if (state.status === "failed") die(`the run failed: ${state.error}`);
  if (!state.recorded) die("the checks ran but the ledger did not record them");
  if (state.results.some((r) => !r.passed)) process.exit(2);
}

// ── commands ───────────────────────────────────────────────────────────────

const commands = {
  async runner() {
    const { runRunner } = await import("./runner.mjs");
    try {
      await runRunner(args, {
        workspacePath,
        async queue(offer, signal) {
          const res = await fetch(server() + "/api/queue", {
            method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": OWNER, "content-type": "application/json" },
            body: JSON.stringify(offer),
          });
          if (!res.ok) throw new Error(`queue: ${res.status}`);
          const incomplete = res.headers.get("x-atelier-incomplete");
          if (incomplete) console.log(`Could not read: ${incomplete}. Tasks waiting there are not listed.`);
          return res.json();
        },
      });
    } catch (error) { die(error.message); }
  },

  async login() {
    if (!args.server) die("usage: atelier login --server https://atelier.example.com");
    cfg.server = String(args.server).replace(/\/$/, "");
    saveConfig(cfg);
    const conf = await call("GET", "/config", undefined, "owner");
    cfg.owner = conf.ownerActor;
    cfg.ownerName = conf.ownerName ?? undefined;
    saveConfig(cfg);
    console.log(`Signed in to ${cfg.server} as the project owner, actor "${cfg.owner}". The token is read from Keychain atelier.API_TOKEN.`);
  },

  // The project owner, in the project's checkout.
  async init() {
    // A bare --title has no value, like a bare --approval: refuse rather than
    // silently clear the stored title.
    if (args.title === true) die('give the title as --title TEXT, or --title "" to clear it');
    const top = git(["rev-parse", "--show-toplevel"]);
    const name = args.name ?? top.split("/").pop();
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: top });
    const cp = readControlPlane(top);
    if (cp && (!args.approval || args.approval === true)) {
      die(`${name} is governed by ControlPlane, and copying it into Artifacts is an off-machine copy.\nRecord the project owner's approval: atelier init --approval "${OWNER_NAME}, ${new Date().toISOString().slice(0, 10)}: …"`);
    }
    // Only what this command names is sent; the server keeps everything else
    // as it is. --reset starts the policy over from these options and the
    // defaults. A ControlPlane project always sends the policy ControlPlane holds.
    const reset = args.reset === true;
    const policy = {};
    if (args.multi.check || reset) policy.checks = args.multi.check ?? [];
    if (cp || args.multi.protect || reset) policy.protected = [...new Set([...(cp?.protected ?? ["AGENTS.md", "CLAUDE.md", "wrangler.*"]), ...(args.multi.protect ?? [])])];
    if (cp) policy.eligible = cp.eligible ?? [];
    if (cp || args["refuse-overlap"] !== undefined || reset) policy.refuseOverlap = cp?.refuseOverlap ?? Boolean(args["refuse-overlap"]);
    if (args["sandbox-only"] !== undefined || reset) policy.sandboxOnly = Boolean(args["sandbox-only"]);
    const r = await call("PUT", P(name), {
      ...policy,
      ...(reset ? { reset: true } : {}),
      approval: args.approval === true ? undefined : args.approval,
      // Omitted keeps the current title; --title "" clears it.
      ...(args.title === undefined ? {} : { title: args.title }),
      defaultBranch: branch,
    }, OWNER);
    git([...auth(r.baseline.token), "push", "--quiet", r.baseline.remote, `${branch}:${branch}`], { cwd: top });
    cfg.projects ??= {};
    cfg.projects[name] = { ...cfg.projects[name], path: top, branch };
    saveConfig(cfg);
    const pol = r.project.policy;
    console.log(`${r.project.title ? `${r.project.title} (${name})` : name}: baseline ${r.project.repo} now holds ${branch} @ ${short(git(["rev-parse", "HEAD"], { cwd: top }))}.`);
    if (cp) console.log(`Policy read from ControlPlane (${cp.sources.join(", ")}).`);
    console.log(`Checks:     ${pol.checks.join(" | ") || "none"}`);
    console.log(`Protected:  ${pol.protected.join(", ")}`);
    console.log(`Eligible:   ${pol.eligible?.join(", ") || "any agent"}`);
    console.log(`Overlap:    ${pol.refuseOverlap ? "refused" : "flagged"}`);
    if (pol.approval) console.log(`Approval:   ${pol.approval}`);
  },

  // The project owner: push commits made directly in the checkout so new forks start from them.
  async publish() {
    const name = project();
    const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac; run atelier init in it`);
    const t = await call("POST", `${P(name)}/baseline-token`, { scope: "write" }, OWNER);
    git([...auth(t.token), "push", "--quiet", t.remote, `${p.branch}:${p.branch}`], { cwd: p.path });
    console.log(`Baseline ${name} now at ${short(git(["rev-parse", p.branch], { cwd: p.path }))}.`);
  },

  async new() {
    const title = args._.slice(1).join(" ");
    if (!title) die('usage: atelier new "title" [--scope GLOB]...');
    const item = await call("POST", `${P(project())}/items`, { title, scope: args.multi.scope ?? [] }, actor(OWNER));
    console.log(`${item.id}  ${item.title}${item.scope.length ? `  [${item.scope.join(" ")}]` : ""}`);
  },

  async ls() {
    const name = project();
    const { items } = await call("GET", P(name), undefined, actor(OWNER));
    for (const i of items) {
      if (!args.all && (i.state === "merged" || i.state === "abandoned")) continue;
      console.log(`${i.id.padEnd(5)} ${i.state.padEnd(10)} ${(i.owner ?? "—").padEnd(26)} ${short(i.head)}  ${i.title}`);
    }
  },

  async show() {
    const d = await call("GET", I(project(), itemArg()), undefined, actor(OWNER));
    const { item, gate } = d;
    console.log(`${item.id}  ${item.title}\n  state ${item.state}   owner ${item.owner ?? "—"}   head ${short(item.head)}   workspace ${item.fork ?? "—"}`);
    console.log(gate.ready ? "  gate: READY" : `  gate:\n${gate.blockers.map((b) => `    - ${b}`).join("\n")}`);
    if (gate.outOfScope.length) console.log(`  out of scope: ${gate.outOfScope.join(", ")}`);
    console.log("  provenance:");
    for (const e of d.events.slice(0, 15)) console.log(`    ${e.at.slice(0, 16)}  ${e.actor.padEnd(24)} ${e.kind}`);
  },

  // Agents: take an item and get a private workspace for it.
  async claim() {
    const name = project();
    const id = itemArg();
    const as = actor();
    const r = await call("POST", `${I(name, id)}/claim`, {}, as, args.runner && args.runner !== true ? { "x-atelier-runner": String(args.runner) } : {});
    const dir = workspacePath(name, id);
    const fresh = !existsSync(join(dir, ".git"));
    if (fresh) {
      mkdirSync(dir, { recursive: true });
      git([...auth(r.workspace.token), "clone", "--quiet", r.workspace.remote, dir]);
    }
    // The workspace keeps its token in its own .git/config, under Caches, not
    // iCloud. Replace it before any fetch: git sends every configured header,
    // and a revoked one alongside the fresh one is refused.
    git(["config", "--local", "--replace-all", `http.${r.workspace.remote}.extraHeader`, `Authorization: Bearer ${r.workspace.token}`], { cwd: dir });
    if (!fresh) git(["fetch", "--quiet", "origin"], { cwd: dir });
    for (const [k, v] of Object.entries({ project: name, item: id, actor: as, branch: r.workspace.defaultBranch })) {
      git(["config", "--local", `atelier.${k}`, v], { cwd: dir });
    }
    // Commit as the project's checkout does, not as this machine's global identity.
    const identity = applyIdentity(cfg.projects?.[name]?.path, dir);
    console.log(`${id} is yours, ${as}. Work here:\n  cd ${JSON.stringify(dir)}`);
    if (identity.email) console.log(`Commits here are authored as ${identity.name ?? "(global name)"} <${identity.email}>, as in the project checkout.`);
    console.log(`Write token expires ${r.workspace.expiresAt}; run \`atelier claim ${id}\` again to refresh it.`);
    console.log(`Then: commit → atelier push → atelier check → atelier submit`);
  },

  async push() {
    const name = project(), id = itemArg(), as = actor();
    const branch = wsConfig("branch") ?? "main";
    const head = git(["rev-parse", "HEAD"]);
    // --force after `atelier update` rebased the workspace; the lease refuses
    // to overwrite anything pushed since this workspace last fetched.
    git(["push", "--quiet", ...(args.force === true ? ["--force-with-lease"] : []), "origin", `HEAD:${branch}`]);
    const item = await call("POST", `${I(name, id)}/push`, { head }, as);
    if (item.head !== head) die(`pushed ${short(head)} but Artifacts reports ${short(item.head)}; recorded what Artifacts reports`);
    console.log(`${id} head ${short(item.head)} (observed in Artifacts).`);
  },

  // Agents: bring the workspace up to date with what has merged since the fork.
  async update() {
    const name = project(), id = itemArg(), as = actor();
    const t = await call("POST", `${P(name)}/baseline-token`, { scope: "read" }, as);
    git([...auth(t.token), "fetch", "--quiet", t.remote, t.defaultBranch]);
    const r = git(["rebase", "FETCH_HEAD"], { allowFail: true });
    if (r.status !== 0) die(`rebase stopped on a conflict. Resolve it, \`git rebase --continue\`, then \`atelier push --force\`.\n${r.stdout}${r.stderr}`);
    console.log(`${id} rebased onto baseline ${short(git(["rev-parse", "FETCH_HEAD"]))}. Push with: git push --force-with-lease origin HEAD:${wsConfig("branch") ?? "main"} && atelier push`);
  },

  // Observed evidence: run each required check (or the given command) in a
  // clean clone of exactly the head Artifacts holds, and record the result.
  async check() {
    if (args.sandbox) return checkInSandbox();
    const name = project(), id = itemArg(), as = actor();
    const d = await call("GET", I(name, id), undefined, as);
    if (d.policy.sandboxOnly) return checkInSandbox();
    const cmds = args.rest?.length ? [args.rest.join(" ")] : d.policy.checks;
    if (!cmds.length) die("this project has no required checks; pass one: atelier check -- npm test");
    const ws = await call("POST", `${I(name, id)}/read-token`, {}, as);
    if (!ws.head) die("nothing pushed yet");
    const base = await call("POST", `${P(name)}/baseline-token`, { scope: "read" }, as);
    const { dir, changed } = cleanClone(ws.remote, ws.token, ws.head, base, name);
    let failed = 0;
    try {
      for (const cmd of cmds) {
        const r = await runCheck(cmd, dir);
        await call("POST", `${I(name, id)}/evidence`, {
          kind: "check", claim: cmd, head: ws.head, passed: r.passed, changedPaths: changed,
          outputTail: `${r.output.slice(-3500)}\n[sha256 of full output: ${r.sha}]`,
        }, as);
        console.log(`${r.passed ? "PASS" : "FAIL"}  ${cmd}  @ ${short(ws.head)}`);
        if (!r.passed) { failed++; process.stdout.write(r.output.slice(-2000) + "\n"); }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(markerPath(dir), { force: true });
    }
    console.log(`changed: ${changed.join(", ") || "nothing"}`);
    if (failed) process.exit(2);
  },

  async gc() {
    if (args._.length !== 1 || args.rest || (args["dry-run"] !== undefined && args["dry-run"] !== true) || Object.keys(args.multi).some((k) => !["apply", "dry-run", "project", "as"].includes(k)) ||
        (args.apply && args["dry-run"]) || (args.apply !== undefined && args.apply !== true)) {
      die("usage: atelier gc [--project NAME] [--dry-run | --apply]");
    }
    const name = project(), as = actor(OWNER);
    const { items } = await call("GET", P(name), undefined, as);
    if (!existsSync(CACHE)) { console.log("No local cache to collect."); return; }
    await collectCache({ cache: CACHE, name, items, apply: args.apply === true,
      getItem: async (id) => (await call("GET", I(name, id), undefined, as)).item });
  },

  async report() {
    const claim = args._.slice(1).join(" ");
    if (!claim) die('usage: atelier report "what you verified and how"');
    const name = project(), id = itemArg(-1), as = actor();
    const d = await call("GET", I(name, id), undefined, as);
    await call("POST", `${I(name, id)}/evidence`, { kind: "report", claim, head: d.item.head }, as);
    console.log(`Recorded as REPORTED at ${short(d.item.head)}. Reports are shown, never counted as checks.`);
  },

  async submit() {
    const name = project(), id = itemArg(), as = actor();
    summaryArg("submit");
    await call("POST", `${I(name, id)}/submit`, args.summary === undefined ? {} : { summary: args.summary }, as);
    const d = await call("GET", I(name, id), undefined, as);
    console.log(d.gate.ready ? `${id} submitted and ready for ${OWNER_NAME}.` : `${id} submitted. Still blocking:\n${d.gate.blockers.map((b) => `  - ${b}`).join("\n")}`);
  },

  // Reviewers: read another agent's work without being able to change it.
  async diff() {
    const name = project(), id = itemArg(), as = actor(OWNER);
    const ws = await call("POST", `${I(name, id)}/read-token`, {}, as);
    const base = await call("POST", `${P(name)}/baseline-token`, { scope: "read" }, as);
    const { dir } = cleanClone(ws.remote, ws.token, ws.head, null, name);
    try {
      git([...auth(base.token), "fetch", "--quiet", base.remote, base.defaultBranch], { cwd: dir });
      const mb = git(["merge-base", "FETCH_HEAD", "HEAD"], { cwd: dir });
      process.stdout.write(git(["log", "--format=%h %s", `${mb}..HEAD`], { cwd: dir }) + "\n\n");
      process.stdout.write(git(["diff", "--stat", mb, "HEAD"], { cwd: dir }) + "\n\n");
      process.stdout.write(git(["diff", mb, "HEAD"], { cwd: dir }) + "\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(markerPath(dir), { force: true });
    }
  },

  async review() {
    const name = project(), id = itemArg(), as = actor();
    if (!args.approve && !args.reject) die("usage: atelier review t3 --approve|--reject --note '…' --as harness/model");
    const d = await call("GET", I(name, id), undefined, as);
    await call("POST", `${I(name, id)}/review`, { approve: Boolean(args.approve), note: args.note === true ? "" : args.note ?? "", head: args.head ?? d.item.head }, as);
    console.log(`${args.approve ? "Approved" : "Rejected"} ${id} @ ${short(d.item.head)} as ${as}.`);
  },

  async handoff() {
    const name = project(), id = itemArg(), as = actor();
    if (!args.to) die("usage: atelier handoff t3 --to codex/gpt-5.5 --note 'why'");
    const r = await call("POST", `${I(name, id)}/handoff`, { to: args.to, note: args.note ?? "" }, as);
    console.log(`${id} now belongs to ${r.item.owner}. Your write token is revoked.\nNext: ${r.next}`);
  },

  async release() {
    const name = project(), id = itemArg(), as = actor();
    await call("POST", `${I(name, id)}/release`, { note: args.note ?? "" }, as);
    console.log(`${id} released; your write token is revoked.`);
  },

  async accept() {
    const name = project(), id = itemArg();
    const d = await call("GET", I(name,id), undefined, OWNER);
    const item = await call("POST", `${I(name, id)}/accept`, {head: args.head ?? d.item.head}, OWNER);
    console.log(`${id} accepted at ${short(item.acceptedHead)}. Merge it with: atelier merge ${id}`);
  },

  async abandon() {
    const name = project(), id = itemArg();
    await call("POST", `${I(name, id)}/abandon`, { note: args.note ?? "" }, OWNER);
    console.log(`${id} abandoned.`);
  },

  async finish() {
    const name = project(), id = itemArg(), as = actor();
    summaryArg("finish");
    if (wsConfig("project") !== name || wsConfig("item") !== id) die("finish must run in this task's claimed workspace");
    const d = await call("GET", I(name,id), undefined, as);
    if (d.item.owner !== as || !["claimed","submitted"].includes(d.item.state)) die("this task must be live and owned by you");
    if (git(["status","--porcelain"])) die("commit your changes before finishing");
    const head = git(["rev-parse","HEAD"]);
    await commands.push();
    if (d.policy.sandboxOnly || args.sandbox) await checkInSandbox(); else await commands.check();
    if (git(["rev-parse","HEAD"]) !== head || git(["status","--porcelain"])) die("the workspace changed while finishing; inspect it and finish again");
    const current = await call("GET", I(name,id), undefined, as);
    if (current.item.head !== head) die("the remote revision changed while checks ran; finish again");
    await commands.submit();
  },

  // The project owner merges an exact revision. With --head, a submitted item
  // is first approved (with --approve) and accepted at that revision only.
  async merge() {
    // Ends an interrupted merge's landing lease, so the task's owner can push
    // again; refused once the merge is on the baseline.
    if (args.cancel === true) {
      const name = project(), id = itemArg();
      const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac`), cwd = p.path;
      const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd });
      const item = (await call("GET", I(name, id), undefined, OWNER)).item;
      let journal;
      try { journal = landingJournal(gitDir, { project: name, item: id, head: item.acceptedHead }); } catch (error) { die(error.message); }
      const local = journal.state?.mergeCommit;
      // An unpublished merge commit in the checkout is kept unless the owner
      // asks for it to go; then the checkout returns to where the merge began.
      if (local && args["discard-local"] !== true) {
        die(`the checkout holds this merge's unpublished commit ${short(local)} on top of ${short(journal.state.start)}.\nFinish it with: atelier merge ${id}\nor cancel and remove it with: atelier merge ${id} --cancel --discard-local`);
      }
      await call("POST", `${I(name, id)}/landing`, { cancel: true }, OWNER);
      if (local) {
        if (git(["rev-parse", "HEAD"], { cwd }) !== local || git(["status", "--porcelain"], { cwd })) die("the checkout moved since the merge; reset it yourself, then remove .git/atelier-landing.json");
        git(["reset", "--quiet", "--hard", journal.state.start], { cwd });
        console.log(`Removed the unpublished merge commit; ${p.branch} is back at ${short(journal.state.start)}.`);
      }
      journal.clear();
      return console.log(`${id}: the merge is cancelled; its owner can push a new revision.`);
    }
    const name=project(), id=itemArg();
    if (args.head !== undefined) {
      if (typeof args.head !== "string" || !/^[a-f0-9]{40,64}$/.test(args.head)) die("usage: atelier merge ID [--head FULL_REVISION [--approve --note TEXT]] | atelier merge ID --cancel [--discard-local]");
      const d=await call("GET",I(name,id),undefined,OWNER);
      if (d.item.state==="submitted") {
        if (d.item.head!==args.head) die("the task changed; review the new revision before merging");
        if (args.approve) await call("POST",`${I(name,id)}/review`,{head:args.head,approve:true,note:typeof args.note==="string"?args.note:""},OWNER);
        await call("POST",`${I(name,id)}/accept`,{head:args.head},OWNER);
      }
    }
    const p=cfg.projects?.[name] ?? die(`${name} is not registered on this Mac`), cwd=p.path;
    const gitDir=git(["rev-parse","--absolute-git-dir"],{cwd});
    let unlock;
    try { unlock=landingLock(gitDir); } catch (error) { die(error.message); }
    try {
      const d=await call("GET",I(name,id),undefined,OWNER), item=d.item;
      if (!['accepted','merged'].includes(item.state)) die(`${id} is ${item.state}; accept the reviewed revision first`);
      if (args.head && args.head!==item.acceptedHead) die("the accepted revision differs from --head; review it before merging");
      const journal=landingJournal(gitDir,{project:name,item:id,head:item.acceptedHead});
      if (item.state==='merged') { journal.clear(); console.log(`${id} is already merged.`); return; }
      if (git(["status","--porcelain"],{cwd})) die("the registered checkout has uncommitted changes; preserve them before retrying");
      if (git(["rev-parse","--abbrev-ref","HEAD"],{cwd})!==p.branch) die(`check out ${p.branch} in ${cwd} first`);
      const base=await call("POST",`${P(name)}/baseline-token`,{scope:'write'},OWNER);
      git([...auth(base.token),'fetch','--quiet',base.remote,p.branch],{cwd});
      const baselineHead=git(['rev-parse','FETCH_HEAD'],{cwd});
      const ws=await call('POST',`${I(name,id)}/read-token`,{},OWNER);
      git([...auth(ws.token),'fetch','--quiet',ws.remote,item.acceptedHead],{cwd});
      if (git(['rev-parse','FETCH_HEAD'],{cwd})!==item.acceptedHead) die('fetched revision differs from the approval');
      const local=git(['rev-parse','HEAD'],{cwd});
      const owners=[...new Set(d.events.filter(e=>['item.claimed','item.handoff'].includes(e.kind)).map(e=>e.data.to??e.actor))];
      const view=d.evidence.filter(e=>e.head===item.acceptedHead), reviews=d.reviews.filter(r=>r.head===item.acceptedHead);
      const marker=`Atelier: ${name}/${id} accepted at ${item.acceptedHead}`;
      if (!journal.state) {
        if (git(['merge-base','--is-ancestor',baselineHead,'HEAD'],{cwd,allowFail:true}).status!==0) die('the baseline has commits missing locally; reconcile the checkout before merging');
        journal.save({start:local,phase:'prepared'});
      }
      if (!journal.state.mergeCommit) {
        // Recover a commit made just before a crash prevented the journal update.
        const parents=git(['rev-list','--parents','-n','1','HEAD'],{cwd}).split(' ');
        const ownCommit=parents.length===3 && parents[1]===journal.state.start && parents[2]===item.acceptedHead && git(['log','-1','--format=%B'],{cwd}).split('\n').includes(marker);
        if (ownCommit) journal.save({mergeCommit:local,phase:'committed'});
        else {
          if(local!==journal.state.start) die('checkout moved during an interrupted merge; inspect the journal before retrying');
          const result=git(['merge','--no-ff','--no-commit',item.acceptedHead],{cwd,allowFail:true});
          if(result.status!==0){git(['merge','--abort'],{cwd,allowFail:true});journal.clear();die('merge conflicts; the task owner must update, recheck, and submit a new revision');}
          if (!existsSync(join(gitDir,'MERGE_HEAD'))) { journal.clear(); die('this revision is already in the checkout without this merge record; reconcile its history first'); }
          const receipt=writeReceipt(cwd,{name,id,item,owners,view,reviews,policy:d.policy,branch:p.branch,notesRemote:p.notesRemote});
          if(receipt)git(['add',receipt],{cwd});
          git(['commit','--quiet','-m',`Merge ${id}: ${item.title}\n\n${marker}\nWorked by: ${owners.join(' → ')||item.owner}`],{cwd});
          journal.save({mergeCommit:git(['rev-parse','HEAD'],{cwd}),phase:'committed'});
        }
      }
      const mergeCommit=journal.state.mergeCommit;
      if(git(['rev-parse','HEAD'],{cwd})!==mergeCommit)die('checkout moved after the merge; restore the checkout before retrying');
      // Take the landing lease: it confirms the acceptance has not moved and
      // stops a push over this revision until the merge is recorded.
      // A refusal ends the command here with the server's reason; the local
      // merge commit is kept for reconciliation.
      await call('POST',`${I(name,id)}/landing`,{head:item.acceptedHead},OWNER);
      const note=[`atelier ${name}/${id} "${item.title}"`,`accepted head ${item.acceptedHead}`,...view.map(e=>`${e.grade.toUpperCase()} ${e.passed===true?'pass ':e.passed===false?'FAIL ':''}${e.claim} — ${e.by} ${e.at}`),...reviews.map(r=>`REVIEW ${r.approve?'approve':'reject'} — ${r.by}: ${r.note}`),...d.events.slice().reverse().map(e=>`${e.at} ${e.actor} ${e.kind}`)].join('\n');
      // Reconcile provenance independently: a previous push can publish only one ref.
      const remoteNotes=git([...auth(base.token),'ls-remote',base.remote,'refs/notes/atelier'],{cwd});
      if(remoteNotes){
        git([...auth(base.token),'fetch','--quiet',base.remote,'refs/notes/atelier'],{cwd});
        if(git(['rev-parse','--verify','refs/notes/atelier'],{cwd,allowFail:true}).status===0)
          git(['notes','--ref=atelier','merge','FETCH_HEAD'],{cwd});
        else git(['update-ref','refs/notes/atelier','FETCH_HEAD'],{cwd});
      }
      const priorNote=git(['notes','--ref=atelier','show',mergeCommit],{cwd,allowFail:true});
      if(priorNote.status!==0||priorNote.stdout.trim()!==note.trim())git(['notes','--ref=atelier','add','-f','-m',note,mergeCommit],{cwd});
      const alreadyPublished=git(['merge-base','--is-ancestor',mergeCommit,baselineHead],{cwd,allowFail:true}).status===0;
      git([...auth(base.token),'push','--quiet',base.remote,...(alreadyPublished?[]:[`${mergeCommit}:refs/heads/${p.branch}`]),'refs/notes/atelier:refs/notes/atelier'],{cwd});
      journal.save({phase:'published'});
      await call('POST',`${I(name,id)}/merged`,{mergeCommit},OWNER);
      journal.clear();
      const notesPush=p.notesRemote?git(['push','--quiet',p.notesRemote,'refs/notes/atelier:refs/notes/atelier'],{cwd,allowFail:true}):null;
      console.log(`${id} merged as ${short(mergeCommit)} in ${cwd}; baseline and ledger agree.`);
      console.log(`Provenance: git notes --ref=atelier show ${short(mergeCommit)}`);
      if(notesPush?.status===0)console.log(`Provenance notes pushed to ${p.notesRemote}.`);
      else if(notesPush)console.log(`Provenance notes need retry: git push ${p.notesRemote} refs/notes/atelier:refs/notes/atelier`);
      console.log("The project branch was not pushed to its own remotes. Nothing was deployed.");
    } finally { unlock(); }
  },

  // One line per live item, for a wrap to copy into STATE.md's Owner section.
  // The project owner: choose a remote that receives refs/notes/atelier on every
  // merge, or --off. Kept per Mac, beside the checkout path, never on the server.
  async "notes-remote"() {
    const name = project();
    const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac`);
    if (args.off) {
      delete p.notesRemote;
      saveConfig(cfg);
      return console.log(`${name}: provenance notes stay local and in Artifacts.`);
    }
    const remote = args._[1];
    if (!remote) return console.log(p.notesRemote ? `${name}: notes go to ${p.notesRemote} on each merge.` : `${name}: notes stay local and in Artifacts. Set one with: atelier notes-remote REMOTE`);
    if (!git(["remote"], { cwd: p.path }).split("\n").includes(remote)) die(`${p.path} has no remote called ${remote}`);
    p.notesRemote = remote;
    saveConfig(cfg);
    console.log(`${name}: each merge now pushes refs/notes/atelier to ${remote}. The merged branch is never pushed.`);
  },

  // The project owner queues an open task for a kind of runner.
  async dispatch() {
    const name = project(), id = itemArg();
    const item = await call("POST", `${I(name, id)}/dispatch`, {
      to: args.to === true ? undefined : args.to,
      agent: args.agent === true ? undefined : args.agent,
      model: args.model === true ? undefined : args.model,
      note: args.note === true ? undefined : args.note,
    }, OWNER);
    const d = item.dispatch;
    console.log(`${id} is waiting for ${d.to === "any" ? "any runner" : `a ${d.to} runner`}${d.agent ? `, ${d.agent}` : ""}${d.model ? ` with ${d.model}` : ""}.`);
  },

  async undispatch() {
    const name = project(), id = itemArg();
    await call("POST", `${I(name, id)}/undispatch`, {}, OWNER);
    console.log(`${id} is no longer waiting for a runner.`);
  },

  // Everything waiting for a runner, across projects, oldest first.
  async queue() {
    const res = await fetch(server() + "/api/queue", { headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": OWNER } });
    if (!res.ok) die(`queue: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const incomplete = res.headers.get("x-atelier-incomplete");
    if (incomplete) console.log(`Could not read: ${incomplete}. Tasks waiting there are not listed.`);
    const queued = await res.json();
    if (!queued.length) return console.log("Nothing is waiting for a runner.");
    for (const { project, item } of queued) {
      const d = item.dispatch;
      console.log(`${project}/${item.id}  for ${d.to}${d.agent ? ` ${d.agent}` : ""}${d.model ? `/${d.model}` : ""}  ${item.title}`);
    }
  },

  // The model pool. With no subcommand, lists it. `models add ID --harness H
  // --where home|cloud [--provider P] [--endpoint URL] [--keychain NAME]
  // [--alias A]... [--note TEXT]` adds or replaces an entry; `models remove ID`
  // removes one. Keys stay in the Keychain; only the entry's name is sent.
  async models() {
    const [sub, id] = args._.slice(1);
    if (sub === "add") {
      if (!id) die("atelier models add ID --harness H --where home|cloud");
      for (const k of ["key", "api-key", "token"]) if (args[k] !== undefined) die("Atelier never stores keys; put the key in your Keychain and give its entry's name with --keychain");
      const entry = await call("PUT", `/models/${encodeURIComponent(id)}`, {
        harness: args.harness, where: args.where, provider: args.provider, endpoint: args.endpoint,
        keychain: args.keychain, aliases: args.multi.alias ?? [], note: args.note,
      }, OWNER);
      return console.log(`${entry.id} is in the pool: ${entry.harness}, ${entry.where}, ${entry.provider}${entry.keychain ? `, key in Keychain ${entry.keychain}` : ""}; family ${entry.family}.`);
    }
    if (sub === "remove") {
      if (!id) die("atelier models remove ID");
      const { removed } = await call("DELETE", `/models/${encodeURIComponent(id)}`, undefined, OWNER);
      return console.log(removed ? `${id} is no longer in the pool.` : `${id} was not in the pool.`);
    }
    if (sub) die(`unknown models command "${sub}"; use add, remove, or nothing to list`);
    const pool = await call("GET", "/models", undefined, OWNER);
    if (!pool.length) return console.log("The pool is empty. Add a model: atelier models add ID --harness H --where home|cloud");
    for (const m of pool) {
      const s = m.status ? `${m.status.state} ${m.status.at.slice(0, 16)}Z${m.status.served && m.status.served !== m.id ? ` as ${m.status.served}` : ""}` : "not checked";
      console.log(`${m.where.padEnd(5)} ${m.harness}/${m.id}  ${m.family}  ${s}${m.keychain ? `  key: ${m.keychain}` : ""}`);
    }
  },

  async owners() {
    const name = project();
    const live = await call("GET", `${P(name)}/owners`, undefined, actor(OWNER));
    if (args.json) return console.log(JSON.stringify({ project: name, source: server(), owners: live }, null, 2));
    if (!live.length) return console.log(`Atelier: no ${name} item is owned.`);
    for (const o of live) console.log(`Atelier: ${o.item} ${o.state}, owned by ${o.owner ?? "nobody"} since ${o.since.slice(0, 16)}Z (${server()}/p/${name}/${o.item}).`);
  },

  async inbox() {
    const entries = await call("GET", "/inbox", undefined, OWNER);
    if (!entries.length) return console.log("Nothing needs you.");
    for (const x of entries) console.log(`${x.kind.toUpperCase().padEnd(8)} ${x.project}/${x.itemId}  ${x.title}\n         ${x.reason}`);
  },

  // The owner's queue: decisions waiting, tasks in progress, tasks waiting for a runner.
  async status() {
    const known = await call("GET", "/projects", undefined, OWNER);
    const chosen = args.project ? known.filter((p) => p.name === args.project) : known;
    if (args.project && !chosen.length) die(`no project named ${args.project}`);
    const inbox = await call("GET", "/inbox", undefined, OWNER);
    const views = await Promise.all(chosen.map(async (p) => {
      const { items } = await call("GET", P(p.name), undefined, OWNER);
      return { name: p.name, title: p.title, items, inbox };
    }));
    console.log(formatStatus(views));
  },

  async open() {
    spawnSync("open", [server()]);
  },

  guide() {
    process.stdout.write(`## Working through Atelier

Several agents may work on this project at once. Each piece of work is an
item with exactly one owner. Never edit the project checkout directly.

1. \`atelier ls --project NAME\` — find an open item, or ask the project owner to create one.
2. \`atelier claim ID --project NAME --as HARNESS/MODEL\` — you get a private
   workspace (a fork of the project). Work only there.
3. Commit, then \`atelier push\`. Atelier records the head it sees in Artifacts.
4. \`atelier check\` — runs the project's required checks in a clean clone of
   exactly that head. Only these count as Observed. \`atelier report "…"\`
   records anything else you verified; it shows as Reported, never as passing.
5. \`atelier submit\` when the gate is clear. The project owner accepts and merges.
6. If you can't finish, \`atelier handoff ID --to HARNESS/MODEL --note "…"\`
   or \`atelier release ID\`. Your write token is revoked either way.
7. Reviewing someone else's item: \`atelier diff ID\`, then
   \`atelier review ID --approve|--reject --note "…"\`. Changes to protected
   paths need approval from a different model than the owner's.
8. \`atelier update\` rebases your workspace onto whatever has merged since.
`);
  },

  help() {
    console.log(`atelier — one owner per item, observed evidence, the project owner decides.

Setup      login --server URL · init [--title TEXT] [--check CMD]... [--protect GLOB]... [--sandbox-only] [--approval TEXT] [--reset] · publish\n           notes-remote [REMOTE | --off]
Items      new "title" [--scope GLOB]... · ls [--all] · show ID · owners [--json] · inbox · status [--project P] · open
Agents     claim ID --as H/M [--runner home:NAME] · finish [--sandbox] [--summary T] · push · update · check [--sandbox | -- CMD] · report "…" · submit [--summary T]
           handoff ID --to H/M · release ID · diff ID · review ID --approve|--reject
Owner      accept ID · merge ID [--head SHA [--approve]] · abandon ID
Models     models · models add ID --harness H --where home|cloud [--provider P] [--endpoint URL] [--keychain NAME] [--alias A]... · models remove ID
           dispatch ID [--to home|cloud|any] [--agent A] [--model M] [--note T] · undispatch ID · queue
Local      gc [--project NAME] [--dry-run | --apply] · runner --name home:NAME [--once] [--config PATH]
Docs       guide   (paste into a project's AGENTS.md)

Common flags: --project NAME, --as harness/model (or ATELIER_ACTOR).`);
  },
};

const cmd = args._[0] ?? "help";
const fn = commands[cmd];
if (!fn) die(`unknown command "${cmd}"; try atelier help`);
await fn();
