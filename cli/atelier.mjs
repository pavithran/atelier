#!/usr/bin/env node
// atelier — the command agents and the project owner run. No dependencies: Node and git.
//
// Agents work in a workspace clone under ~/Library/Caches, never in the iCloud
// checkout. Checks run in a second, clean clone of exactly the head Atelier
// sees in Artifacts. Only `atelier merge`, run by the project owner, touches
// the checkout.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { redactGitArgs } from "./runner.mjs";

import { landingJournal, landingLock } from "./landing.mjs";
import { buildHistory, carryTask, loadPairs, rebuild, savePairs, syncHistory } from "./fresh.mjs";
import { applyIdentity } from "./identity.mjs";
import { collectCache, markerPath } from "./gc.mjs";
import { formatStatus } from "./status.mjs";
import { describeStore, promptSecret, readSecret, writeSecret } from "./credentials.mjs";

const HOME = homedir();
const CONFIG_DIR = process.env.ATELIER_CONFIG_DIR ?? join(HOME, ".config", "atelier");
const CONFIG = join(CONFIG_DIR, "config.json");
const CACHE = process.env.ATELIER_CACHE ?? join(HOME, "Library", "Caches", "ai-projects", "cloudflare-git");
const CHECK_TIMEOUT_MS = Number(process.env.ATELIER_CHECK_TIMEOUT ?? 20 * 60_000);

// ── plumbing ───────────────────────────────────────────────────────────────

let doneStep;

function die(msg, code = 1) {
  if (doneStep) msg = `${doneStep} failed: ${msg}`;
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

// The token `login` has just been given and has not yet stored.
let loginToken = null;

// ATELIER_TOKEN wins, then the store for this system (see credentials.mjs).
function apiToken() {
  if (loginToken) return loginToken;
  let token;
  try { token = readSecret("API_TOKEN"); } catch (error) { die(error.message); }
  if (token) return token;
  die("no API token: run `atelier login --server URL` to store one, or set ATELIER_TOKEN");
}

// The environment a git command runs with. Artifacts has no Git LFS: a push
// would try to upload a project's LFS objects and fail, so every push skips
// the upload and Artifacts holds pointer files. A clone, always a disposable
// copy (a task workspace, a check run), keeps the pointers rather than trying
// to download what they point to. Nothing else skips the download: a merge or
// reset in the owner's own checkout writes real LFS files as git-lfs would.
export function gitEnv(base = process.env, extra = {}, args = []) {
  return { ...base, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_PUSH: "1", ...(args.includes("clone") ? { GIT_LFS_SKIP_SMUDGE: "1" } : {}), ...extra };
}

function git(args, opts = {}) {
  const r = spawnSync("git", args, { encoding: "utf8", cwd: opts.cwd, env: gitEnv(process.env, opts.env, args), input: opts.input, maxBuffer: 256 * 1024 * 1024 });
  const shown = redactGitArgs(args);
  let detail = (r.stderr || r.stdout || "").trim();
  for (const [i, arg] of args.entries()) {
    if (shown[i] === "[redacted]") detail = detail.split(arg).join("[redacted]");
  }
  if (r.status !== 0 && !opts.allowFail) die(`git ${shown.join(" ")} failed:\n${detail}`);
  return opts.allowFail ? r : opts.raw ? r.stdout : r.stdout.trim();
}

// Tokens go in a per-command header, never in a remote URL or the iCloud tree.
const auth = (token) => ["-c", `http.extraHeader=Authorization: Bearer ${token}`];

function parseArgs(argv) {
  const out = { _: [], multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out.rest = argv.slice(i + 1); break; }
    // Help is intercepted before flag parsing, so a word after --help is not eaten as its value.
    if (a === "-h" || a === "--help") { out.help = true; continue; }
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
const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
const cfg = isMain ? loadConfig() : {};

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

export function initName(projects, top, explicit, renameLocal) {
  const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const existing = Object.entries(projects ?? {}).find(([, p]) => real(p.path) === real(top))?.[0];
  if (explicit !== undefined && (typeof explicit !== "string" || !explicit.trim())) throw new Error("--name needs a project name");
  if (existing && explicit && explicit !== existing && !renameLocal) throw new Error(`this checkout is registered as ${existing}; use --rename-local to change only the local entry`);
  const name = explicit ?? existing ?? top.split("/").pop();
  if (renameLocal && (!existing || !explicit)) throw new Error("--rename-local needs a registered checkout and --name NAME");
  if (renameLocal && name !== existing && projects?.[name]) throw new Error(`${name} is already registered locally`);
  return { name, existing };
}

function project() {
  if (args.project) return args.project;
  const fromWs = wsConfig("project");
  if (fromWs) return fromWs;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status === 0) {
    const here = top.stdout.trim();
    // Compared as real paths: git reports /private/var/… for a checkout
    // registered as /var/… on macOS, and any symlinked folder the same way.
    const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
    for (const [name, p] of Object.entries(cfg.projects ?? {})) if (real(p.path) === real(here)) return name;
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
  if (state.results.some((r) => !r.passed)) {
    if (doneStep) die("required checks failed", 2);
    process.exit(2);
  }
}

// What an agent relays is one line per field: text a person or an agent
// wrote (a review note, a title, a dispatch note) is flattened, so a newline
// inside it can never pose as a line of the verdict, and terminal control
// codes are dropped. Atelier's own wording is what the lines start with.
const flat = (value) => stripVTControlCharacters(String(value)).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();

// Where a project stands, as plain text an agent can paste into a chat: one
// line per item, and any text a person or agent wrote flattened.
const at = (iso) => `${String(iso).slice(0, 16).replace("T", " ")} UTC`;
export function formatStanding(s, ownerName = "the project owner") {
  const runner = (q) => `${q.to}${q.agent ? ` ${q.agent}` : ""}${q.model ? `/${q.model}` : ""}`;
  const lines = [`${flat(s.project.title)} (${flat(s.project.name)}) as of ${at(s.generatedAt)}, from Atelier's record`];
  const group = (title, rows) => { if (rows.length) lines.push("", `${title}:`, ...rows.map((r) => `  ${r}`)); };
  group("Held now", s.live.map((i) => `${i.id}  ${i.state}  held by ${flat(i.owner ?? "nobody")}${i.since ? ` since ${at(i.since)}` : ", since when is not shown"}  ${flat(i.title)}`));
  group(`Waiting on ${flat(ownerName)}`, s.waiting.map((w) => `${w.id}  ${w.kind}  ${flat(w.title)}  ${flat(w.reason)}${w.brief ? `  brief, ${flat(w.brief.verdict)}: ${flat(w.brief.line)}` : ""}`));
  group("Queued for a runner", s.queued.map((q) => `${q.id}  for ${flat(runner(q))}  ${flat(q.title)}${q.note ? `  note: ${flat(q.note)}` : ""}`));
  group("Last merges", s.merged.map((m) => `${m.id}  ${at(m.at)}${m.commit ? `  ${m.commit.slice(0, 8)}` : ""}  ${flat(m.title)}${m.line ? `  summary: ${flat(m.line)}` : ""}`));
  group("Handoff notes", s.handoffs.map((h) => `${h.id}  ${flat(h.from || "?")} to ${flat(h.to || "?")}, ${at(h.at)}  ${flat(h.note)}`));
  if (lines.length === 1) lines.push("", "Nothing is held, waiting, queued or recently merged.");
  if (s.partial?.length) lines.push("", "Part of this record is not shown:", ...s.partial.map((x) => `  ${flat(x)}`));
  if (s.controlPlane) {
    lines.push("", `ControlPlane policy, approved: ${flat(s.controlPlane.approval)}. Protected areas: ${s.controlPlane.protected.map(flat).join(", ") || "none"}. Eligible agents: ${s.controlPlane.eligible.map(flat).join(", ") || "any"}. Overlapping claims: ${s.controlPlane.refuseOverlap ? "refused" : "flagged"}.`);
  }
  return lines.join("\n");
}

// Whether this machine's checkout is in step with the baseline, from what git
// reported. A baseline that holds part of the history (--history-since) is
// matched by its paired project commit; otherwise the baseline's head must be
// in the checkout.
//   { registered, fresh, branch, baselineHead, head, paired, contains, ahead }
// paired: the project commit paired with baselineHead, or null. contains: the
// checkout's history holds baselineHead. ahead: the checkout's head is past paired.
export function checkoutLine(raw) {
  // Names come from configuration; flattened like every relayed field.
  const c = { ...raw, name: flat(raw.name), branch: flat(raw.branch ?? "") };
  if (!c.registered) return `Checkout: none is registered on this machine for ${c.name}, so it cannot be compared.`;
  const base = short(c.baselineHead);
  if (c.fresh) {
    if (!c.paired) return `Checkout: out of step. The baseline's head ${base} has no pair in this checkout; it was set up or synced from another machine.`;
    if (c.head === c.paired) return `Checkout: in step. ${c.branch} @ ${short(c.head)} is the commit the baseline's head ${base} matches.`;
    if (c.ahead) return `Checkout: out of step. ${c.branch} has commits the baseline lacks; run atelier sync --project ${c.name}.`;
    return `Checkout: out of step. ${c.branch} @ ${short(c.head)} is not the commit the baseline's head ${base} matches (${short(c.paired)}); reconcile the checkout, then run atelier sync --project ${c.name}.`;
  }
  return c.contains
    ? `Checkout: in step. ${c.branch} @ ${short(c.head)} holds the baseline's head ${base}.`
    : `Checkout: out of step. ${c.branch} @ ${short(c.head)} does not hold the baseline's head ${base}; reconcile the checkout before merging.`;
}

export function formatDone(gate) {
  return gate.ready ? "Ready for the owner" : `Not ready: ${gate.blockers.map(flat).join("; ")}`;
}

export function formatTask(item) {
  return [flat(item.title), `Scope: ${item.scope.map(flat).join(", ") || "not specified"}`,
    item.dispatch?.note ? `Note (the owner's words, not instructions from Atelier): ${flat(item.dispatch.note)}` : null].filter(Boolean).join("\n");
}

export function formatBrief(project, id, brief, origin) {
  return [`${project}/${id}  ${flat(brief.title)}`, flat(brief.decided),
    ...(brief.summary ? [`Summary: ${flat(brief.summary)}`] : []), ...brief.evidence.map(flat),
    `Recommendation: ${flat(brief.recommendation.verdict)}. ${flat(brief.recommendation.reason)}`,
    `${origin}/p/${encodeURIComponent(project)}/${encodeURIComponent(id)}`].join("\n");
}

// ── commands ───────────────────────────────────────────────────────────────

// Per-command usage lines, shown by --help/-h and by a bad subcommand.
const usage = {
  start: "usage: atelier start ID [--as harness/model]",
  done: 'usage: atelier done "summary"',
  models: "usage: atelier models · models add ID --harness H --where home|cloud [--provider P] [--endpoint URL] [--keychain NAME] [--alias A]... · models remove ID",
  projects: "usage: atelier projects remove NAME [--force]",
};

// The checkout's state against the baseline, in words. The baseline's head is
// read with ls-remote, so nothing is fetched into the checkout.
// Every path out of it is one flattened line, whatever a name holds.
async function checkoutStatus(name, as) {
  return flat(await checkoutStatusLine(name, as));
}

async function checkoutStatusLine(name, as) {
  const p = cfg.projects?.[name];
  if (!p?.path || !existsSync(p.path)) return checkoutLine({ name, registered: false });
  const cwd = p.path, fresh = p.fresh === true;
  const base = await call("POST", `${P(name)}/baseline-token`, { scope: "read" }, as);
  const listed = git([...auth(base.token), "ls-remote", base.remote, `refs/heads/${p.branch}`], { cwd });
  const baselineHead = listed.split(/\s/)[0];
  if (!baselineHead) return `Checkout: cannot be compared: the baseline has no ${p.branch} branch yet.`;
  // The registered branch is compared, whatever is checked out: the line
  // names that branch, so its head is what it must describe.
  const head = git(["rev-parse", "--verify", "--quiet", `refs/heads/${p.branch}`], { cwd, allowFail: true }).stdout?.trim();
  if (!head) return `Checkout: cannot be compared: this checkout has no ${p.branch} branch.`;
  const has = (sha) => git(["cat-file", "-e", `${sha}^{commit}`], { cwd, allowFail: true }).status === 0;
  const is = (a, b) => git(["merge-base", "--is-ancestor", a, b], { cwd, allowFail: true }).status === 0;
  const paired = fresh ? loadPairs(git(["rev-parse", "--absolute-git-dir"], { cwd }), name)[baselineHead] ?? null : null;
  return checkoutLine({
    name, registered: true, fresh, branch: p.branch, baselineHead, head, paired,
    contains: !fresh && has(baselineHead) && is(baselineHead, head),
    ahead: !!paired && head !== paired && is(paired, head),
  });
}

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
    if (args.store) {
      let held = null;
      try { held = readSecret("API_TOKEN"); } catch (error) { die(error.message); }
      const env = process.env.ATELIER_TOKEN?.trim() ? " ATELIER_TOKEN is set in the environment and is used instead." : "";
      return console.log(`The token store is ${describeStore("API_TOKEN")}. ${held ? "A token is stored." : "No token is stored."}${env}`);
    }
    if (!args.server || args.server === true) die("usage: atelier login --server https://atelier.example.com   or   atelier login --store");
    // A token already stored, or in ATELIER_TOKEN, is used; otherwise ask for one.
    let token = null, fresh = false;
    try { token = readSecret("API_TOKEN"); } catch (error) { die(error.message); }
    if (!token) {
      try { token = await promptSecret("Server token (not shown): "); } catch (error) { die(`no token entered: ${error.message}`); }
      if (!token) die("no token entered");
      fresh = true;
    }
    loginToken = token;
    cfg.server = String(args.server).replace(/\/$/, "");
    saveConfig(cfg);
    const conf = await call("GET", "/config", undefined, "owner");
    cfg.owner = conf.ownerActor;
    cfg.ownerName = conf.ownerName ?? undefined;
    saveConfig(cfg);
    // A token the server refused is never stored: `call` has already ended the command.
    let where;
    if (fresh) { try { where = writeSecret("API_TOKEN", token); } catch (error) { die(error.message); } }
    else where = process.env.ATELIER_TOKEN?.trim() ? "the ATELIER_TOKEN environment variable" : describeStore("API_TOKEN");
    console.log(`Signed in to ${cfg.server} as the project owner, actor "${cfg.owner}". The token ${fresh ? "is now stored in" : "is read from"} ${where}.`);
  },

  // The project owner, in the project's checkout.
  async init() {
    // A bare --title has no value, like a bare --approval: refuse rather than
    // silently clear the stored title.
    if (args.title === true) die('give the title as --title TEXT, or --title "" to clear it');
    const top = git(["rev-parse", "--show-toplevel"]);
    let name, existing;
    try { ({ name, existing } = initName(cfg.projects, top, args.name, args["rename-local"] === true)); }
    catch (err) { die(err.message); }
    if (args["rename-local"] === true) {
      cfg.projects[name] = cfg.projects[existing];
      if (name !== existing) delete cfg.projects[existing];
      saveConfig(cfg);
      console.log(`Local registration changed from ${existing} to ${name}. No server project or repository was changed.`);
      return;
    }
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
    // A project too large for Artifacts joins with its recent history only
    // (cli/fresh.mjs). Once set up that way it stays that way: a later init
    // changes the policy and pushes nothing; atelier sync carries new commits.
    const fresh = cfg.projects?.[name]?.fresh === true;
    const since = typeof args["history-since"] === "string" ? args["history-since"] : null;
    if (args["history-since"] === true || args["history-since"] === "") die("give the day the baseline's history starts: --history-since YYYY-MM-DD");
    let pushed = "HEAD";
    if (fresh) {
      if (since) die(`${name} already has a baseline from part of its history; use atelier sync to carry new commits`);
    } else if (since) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) die("--history-since takes a day, YYYY-MM-DD");
      if (git(["status", "--porcelain"], { cwd: top })) die("commit or set aside the checkout's changes first; the baseline is built from its commits");
      const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd: top });
      const start = git(["rev-list", "-1", "--first-parent", `--before=${since}T00:00:00`, "HEAD"], { cwd: top });
      if (!start) die(`${branch} has no commit before ${since}`);
      const built = buildHistory(git, top, start, git(["rev-parse", "HEAD"], { cwd: top }));
      git([...auth(r.baseline.token), "push", "--quiet", r.baseline.remote, `${built.head}:refs/heads/${branch}`], { cwd: top });
      savePairs(gitDir, name, { ...loadPairs(gitDir, name), ...built.pairs });
      pushed = built.head;
      console.log(`Baseline history starts at ${short(start)} (${since}): ${Object.keys(built.pairs).length - 1} commits on ${branch}'s first-parent line rebuilt with the same trees, authors, dates and messages.`);
    } else {
      git([...auth(r.baseline.token), "push", "--quiet", r.baseline.remote, `${branch}:${branch}`], { cwd: top });
    }
    cfg.projects ??= {};
    cfg.projects[name] = { ...cfg.projects[name], path: top, branch, ...(since || fresh ? { fresh: true } : {}) };
    saveConfig(cfg);
    const pol = r.project.policy;
    console.log(fresh
      ? `${r.project.title ? `${r.project.title} (${name})` : name}: policy updated; the baseline was not pushed (it holds part of the history; atelier sync carries new commits).`
      : `${r.project.title ? `${r.project.title} (${name})` : name}: baseline ${r.project.repo} now holds ${branch} @ ${short(git(["rev-parse", pushed], { cwd: top }))}.`);
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
    if (p.fresh === true) die(`${name}'s baseline holds part of its history; atelier sync carries new commits to it`);
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
    const name = project(), id = itemArg();
    const brief = await call("GET", `${I(name, id)}/brief`, undefined, actor(OWNER));
    console.log(args.json ? JSON.stringify(brief, null, 2) : formatBrief(name, id, brief, server()));
  },

  async start() {
    await commands.claim();
    const d = await call("GET", I(project(), itemArg()), undefined, actor());
    console.log(formatTask(d.item));
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
    console.log(args._[0] === "start" ? 'Then: commit, then atelier done "summary"' : `Then: commit → atelier push → atelier check → atelier submit`);
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
    if (failed) {
      if (doneStep) die("required checks failed", 2);
      process.exit(2);
    }
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
    if (doneStep) return d.gate;
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

  async done() {
    if (args._.length !== 2 || !args._[1].trim() || args.summary !== undefined || args.rest) die('usage: atelier done "summary"');
    args.summary = args._[1];
    args._ = ["done"];
    doneStep = "prepare";
    try {
      const gate = await commands.finish();
      doneStep = undefined;
      console.log(formatDone(gate));
    } catch (error) { die(error.message); }
  },

  async finish() {
    const name = project(), id = itemArg(), as = actor();
    summaryArg("finish");
    if (wsConfig("project") !== name || wsConfig("item") !== id) die("finish must run in this task's claimed workspace");
    const d = await call("GET", I(name,id), undefined, as);
    if (d.item.owner !== as || !["claimed","submitted"].includes(d.item.state)) die("this task must be live and owned by you");
    if (git(["status","--porcelain"])) die("commit your changes before finishing");
    const head = git(["rev-parse","HEAD"]);
    if (doneStep) doneStep = "push";
    await commands.push();
    if (doneStep) doneStep = "check";
    if (d.policy.sandboxOnly || args.sandbox) await checkInSandbox(); else await commands.check();
    if (git(["rev-parse","HEAD"]) !== head || git(["status","--porcelain"])) die("the workspace changed while finishing; inspect it and finish again");
    const current = await call("GET", I(name,id), undefined, as);
    if (current.item.head !== head) die("the remote revision changed while checks ran; finish again");
    if (doneStep) doneStep = "submit";
    return commands.submit();
  },

  // The project owner merges an exact revision. With --head, a submitted item
  // is first approved (with --approve) and accepted at that revision only.
  // A baseline holding part of the history (init --history-since) does not
  // follow the checkout by itself: commits made in the checkout outside
  // Atelier are carried to it here, rebuilt with the same trees.
  async sync() {
    const name = project();
    const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac`), cwd = p.path;
    if (p.fresh !== true) die(`${name}'s baseline holds its whole history; atelier init pushes new commits to it`);
    if (git(["status", "--porcelain"], { cwd })) die("the registered checkout has uncommitted changes; commit or set them aside first");
    if (git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd }) !== p.branch) die(`check out ${p.branch} in ${cwd} first`);
    const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd });
    let unlock;
    try { unlock = landingLock(gitDir); } catch (error) { die(error.message); }
    try {
      if (existsSync(join(gitDir, "atelier-landing.json"))) die("a merge is in progress; finish it or cancel it first");
      const base = await call("POST", `${P(name)}/baseline-token`, { scope: "write" }, OWNER);
      git([...auth(base.token), "fetch", "--quiet", base.remote, p.branch], { cwd });
      const baselineHead = git(["rev-parse", "FETCH_HEAD"], { cwd });
      const pairs = loadPairs(gitDir, name);
      const paired = pairs[baselineHead] ?? die(`the baseline's head ${short(baselineHead)} has no pair in this checkout; it was set up or synced from another machine`);
      // The registered branch is compared, whatever is checked out: the line
  // names that branch, so its head is what it must describe.
  const head = git(["rev-parse", "--verify", "--quiet", `refs/heads/${p.branch}`], { cwd, allowFail: true }).stdout?.trim();
  if (!head) return `Checkout: cannot be compared: this checkout has no ${p.branch} branch.`;
      if (head === paired) return console.log(`${name}: the baseline already matches ${p.branch} @ ${short(head)}.`);
      if (git(["merge-base", "--is-ancestor", paired, head], { cwd, allowFail: true }).status !== 0) die(`${p.branch} no longer contains ${short(paired)}, the commit the baseline matches; its history was rewritten, and it cannot be carried`);
      let built;
      try { built = syncHistory(git, cwd, baselineHead, paired, head); } catch (error) { die(error.message); }
      // The pairs are saved before the push: a push that lands just before a
      // crash is still paired, and the rebuild gives the same commits again.
      savePairs(gitDir, name, { ...pairs, ...built.pairs });
      git([...auth(base.token), "push", "--quiet", base.remote, `${built.head}:refs/heads/${p.branch}`], { cwd });
      const n = Object.keys(built.pairs).length;
      console.log(`${name}: carried ${n} commit${n === 1 ? "" : "s"} to the baseline; it now matches ${p.branch} @ ${short(head)}. Tasks forked earlier can run atelier update.`);
    } finally { unlock(); }
  },

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
      // A project whose baseline holds part of its history (cli/fresh.mjs)
      // merges the task's commits rebuilt onto the paired project commit.
      const fresh=p.fresh===true, pairs=fresh?loadPairs(gitDir,name):null;
      if (!journal.state) {
        if (fresh) {
          const paired=pairs[baselineHead];
          if (!paired) die(`the baseline's head ${short(baselineHead)} has no pair in this checkout; it was set up or synced from another machine`);
          if (local!==paired) die(`${p.branch} has moved since the baseline last matched it (${short(paired)}); run atelier sync --project ${name}, then merge`);
        }
        else if (git(['merge-base','--is-ancestor',baselineHead,'HEAD'],{cwd,allowFail:true}).status!==0) die('the baseline has commits missing locally; reconcile the checkout before merging');
        journal.save({start:local,phase:'prepared',baselineStart:baselineHead});
      }
      if (!journal.state.mergeCommit) {
        // What is merged: the accepted head, or its rebuilt twin on the project's commits.
        let target=item.acceptedHead;
        if (fresh) {
          try { target=carryTask(git,cwd,journal.state.baselineStart??baselineHead,item.acceptedHead,pairs); } catch (error) { journal.clear(); die(error.message); }
          if (!target) { journal.clear(); die('the accepted revision adds nothing to the baseline'); }
        }
        // Recover a commit made just before a crash prevented the journal update.
        const parents=git(['rev-list','--parents','-n','1','HEAD'],{cwd}).split(' ');
        const ownCommit=parents.length===3 && parents[1]===journal.state.start && parents[2]===target && git(['log','-1','--format=%B'],{cwd}).split('\n').includes(marker);
        if (ownCommit) journal.save({mergeCommit:local,phase:'committed'});
        else {
          if(local!==journal.state.start) die('checkout moved during an interrupted merge; inspect the journal before retrying');
          const result=git(['merge','--no-ff','--no-commit',target],{cwd,allowFail:true});
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
      // The baseline gets the merge commit itself, or, for a baseline holding
      // part of the history, its twin: the same tree, authors, dates and
      // message on the baseline's head and the accepted head. The same inputs
      // give the same twin, so a retry publishes the same commit.
      const published=fresh?rebuild(git,cwd,mergeCommit,[journal.state.baselineStart??baselineHead,item.acceptedHead]):mergeCommit;
      if(fresh)savePairs(gitDir,name,{...loadPairs(gitDir,name),[published]:mergeCommit});
      for(const c of new Set([mergeCommit,published])){
        const priorNote=git(['notes','--ref=atelier','show',c],{cwd,allowFail:true});
        if(priorNote.status!==0||priorNote.stdout.trim()!==note.trim())git(['notes','--ref=atelier','add','-f','-m',note,c],{cwd});
      }
      const alreadyPublished=git(['merge-base','--is-ancestor',published,baselineHead],{cwd,allowFail:true}).status===0;
      git([...auth(base.token),'push','--quiet',base.remote,...(alreadyPublished?[]:[`${published}:refs/heads/${p.branch}`]),'refs/notes/atelier:refs/notes/atelier'],{cwd});
      journal.save({phase:'published'});
      await call('POST',`${I(name,id)}/merged`,{mergeCommit:published},OWNER);
      journal.clear();
      const notesPush=p.notesRemote?git(['push','--quiet',p.notesRemote,'refs/notes/atelier:refs/notes/atelier'],{cwd,allowFail:true}):null;
      console.log(`${id} merged as ${short(mergeCommit)} in ${cwd}${published!==mergeCommit?` (on the baseline as ${short(published)})`:""}; baseline and ledger agree.`);
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
    if (sub) die(`${usage.models}\nunknown models command "${sub}"; use add, remove, or nothing to list`);
    const pool = await call("GET", "/models", undefined, OWNER);
    if (!pool.length) return console.log("The pool is empty. Add a model: atelier models add ID --harness H --where home|cloud");
    for (const m of pool) {
      const s = m.status ? `${m.status.state} ${m.status.at.slice(0, 16)}Z${m.status.served && m.status.served !== m.id ? ` as ${m.status.served}` : ""}` : "not checked";
      console.log(`${m.where.padEnd(5)} ${m.harness}/${m.id}  ${m.family}  ${s}${m.keychain ? `  key: ${m.keychain}` : ""}`);
    }
  },

  async projects() {
    const name = args._[2];
    if (args._[1] !== "remove" || !name) die("usage: atelier projects remove NAME [--force]");
    await call("DELETE", P(name), { force: args.force === true }, actor(OWNER));
    // The whole local entry goes; say what it held, since some of it (notesRemote) is set by hand.
    let dropped = "";
    if (cfg.projects?.[name]) {
      const held = Object.entries(cfg.projects[name]).map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`);
      dropped = held.length ? ` Local settings dropped: ${held.join(", ")}.` : "";
      delete cfg.projects[name];
      saveConfig(cfg);
    }
    console.log(`${name} removed from the project index and local config.${dropped} The Artifacts repository and project Ledger data are retained. Deleting a repository requires a separate, deliberate action by the owner.`);
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
    if (args.json) return console.log(JSON.stringify(entries, null, 2));
    if (!entries.length) return console.log("Nothing needs you.");
    const seen = new Set();
    for (const x of entries) {
      const key = `${x.project}/${x.itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const brief = await call("GET", `${I(x.project, x.itemId)}/brief`, undefined, actor(OWNER));
      console.log(formatBrief(x.project, x.itemId, brief, server()) + "\n");
    }
  },

  // The owner's queue: decisions waiting, tasks in progress, tasks waiting for a runner.
  async status() {
    if (args.project !== undefined) {
      const name = args.project === true ? die("usage: atelier status [--project NAME]") : args.project;
      const as = actor(OWNER);
      const standing = await call("GET", `${P(name)}/standing`, undefined, as);
      console.log(formatStanding(standing, OWNER_NAME) + "\n\n" + await checkoutStatus(name, as));
      return;
    }
    const known = await call("GET", "/projects", undefined, OWNER);
    const chosen = known;
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

1. \`atelier start ID --project NAME --as HARNESS/MODEL\` claims the task
   and prints its workspace, title, scope and note. Work only there.
2. Commit your changes, then run \`atelier done "summary"\` in that workspace.
   It pushes, runs required checks and submits only after they pass. Relay
   its final line to the owner. The project owner accepts and merges.
3. \`atelier inbox\` and \`atelier show ID\` print briefs you can relay to the owner.
4. \`atelier ls --project NAME\` lists tasks. Ask the owner to create one if needed.
5. Individual steps remain available: \`atelier claim\`, \`atelier push\`,
   \`atelier check\` and \`atelier submit --summary "summary"\`.
   \`atelier report "…"\` records a Reported claim, never an Observed pass.
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

Setup      login --server URL · login --store · init [--title TEXT] [--check CMD]... [--protect GLOB]... [--sandbox-only] [--approval TEXT] [--reset] [--history-since YYYY-MM-DD] · sync · publish\n           notes-remote [REMOTE | --off]
Items      new "title" [--scope GLOB]... · ls [--all] · show ID · owners [--json] · inbox · status [--project P] (with a project: where it stands, as text) · open
Agents     start ID [--as H/M] · done "summary"\n           claim ID --as H/M [--runner home:NAME] · finish [--sandbox] [--summary T] · push · update · check [--sandbox | -- CMD] · report "…" · submit [--summary T]
           handoff ID --to H/M · release ID · diff ID · review ID --approve|--reject
Owner      accept ID · merge ID [--head SHA [--approve]] · abandon ID
Models     models · models add ID --harness H --where home|cloud [--provider P] [--endpoint URL] [--keychain NAME] [--alias A]... · models remove ID
           dispatch ID [--to home|cloud|any] [--agent A] [--model M] [--note T] · undispatch ID · queue
Projects   projects remove NAME [--force] · init --name NAME --rename-local
Local      gc [--project NAME] [--dry-run | --apply] · runner --name home:NAME [--once] [--config PATH]
Docs       guide   (paste into a project's AGENTS.md)

Common flags: --project NAME, --as harness/model (or ATELIER_ACTOR).`);
  },
};

if (isMain) {
  const cmd = args._[0] ?? "help";
  const fn = commands[cmd];
  if (!fn) die(`unknown command "${cmd}"; try atelier help`);
  // --help/-h anywhere prints the command's usage, or the general help, and
  // exits before any server contact.
  if (args.help) {
    if (cmd !== "help" && usage[cmd]) console.log(usage[cmd]);
    else commands.help();
    process.exit(0);
  }
  await fn();
}
