#!/usr/bin/env node
// atelier — the command agents and PAVI run. No dependencies: Node and git.
//
// Agents work in a workspace clone under ~/Library/Caches, never in the iCloud
// checkout. Checks run in a second, clean clone of exactly the head Atelier
// sees in Artifacts. Only `atelier land`, run by PAVI, touches the checkout.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HOME = homedir();
const CONFIG_DIR = join(HOME, ".config", "atelier");
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
  const shown = args.filter((a, i) => !a.startsWith("http.extraHeader") && !(a === "-c" && args[i + 1]?.startsWith("http.extraHeader")));
  if (r.status !== 0 && !opts.allowFail) die(`git ${shown.join(" ")} failed:\n${(r.stderr || r.stdout).trim()}`);
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
      const key = a.slice(2);
      const next = argv[i + 1];
      const val = next === undefined || next.startsWith("--") ? true : (i++, next);
      (out.multi[key] ??= []).push(val);
      out[key] = val;
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig();

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

function itemArg(i = 1) {
  const id = args._[i] ?? wsConfig("item");
  if (!id) die("which item? pass its id (t3) or run inside its workspace");
  return id;
}

async function call(method, path, body, as) {
  const res = await fetch(server() + "/api" + path, {
    method,
    headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": as, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: "bad_response", detail: text.slice(0, 300) }; }
  if (!res.ok) die(`${data.error ?? res.status}: ${data.detail ?? text.slice(0, 300)}`);
  return data;
}

const P = (name) => `/projects/${encodeURIComponent(name)}`;
const I = (name, id) => `${P(name)}/items/${encodeURIComponent(id)}`;
const short = (s) => (s ? s.slice(0, 8) : "—");

function workspacePath(name, id) {
  return join(CACHE, "work", name, id);
}

// ── clean-room checks ──────────────────────────────────────────────────────

function cleanClone(remote, token, head, baseline) {
  mkdirSync(join(CACHE, "checks"), { recursive: true });
  const dir = mkdtempSync(join(CACHE, "checks", "run-"));
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

function runCheck(cmd, dir) {
  process.stderr.write(`atelier: running \`${cmd}\` in a clean clone…\n`);
  const r = spawnSync("/bin/sh", ["-c", cmd], { cwd: dir, encoding: "utf8", timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n[atelier] ${r.error.message}` : ""}`;
  return { passed: r.status === 0, output, sha: createHash("sha256").update(output).digest("hex") };
}

// ── commands ───────────────────────────────────────────────────────────────

const commands = {
  async login() {
    if (!args.server) die("usage: atelier login --server https://atelier.example.com");
    cfg.server = String(args.server).replace(/\/$/, "");
    saveConfig(cfg);
    await call("GET", "/projects", undefined, "pavi");
    console.log(`Signed in to ${cfg.server}. The token is read from Keychain atelier.API_TOKEN.`);
  },

  // PAVI, in the project's iCloud checkout.
  async init() {
    const top = git(["rev-parse", "--show-toplevel"]);
    const name = args.name ?? top.split("/").pop();
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: top });
    const r = await call("PUT", P(name), {
      checks: args.multi.check ?? [],
      protected: args.multi.protect ?? ["AGENTS.md", "CLAUDE.md", "wrangler.*", "docs/control-plane/**"],
      defaultBranch: branch,
    }, "pavi");
    git([...auth(r.baseline.token), "push", "--quiet", r.baseline.remote, `${branch}:${branch}`], { cwd: top });
    cfg.projects ??= {};
    cfg.projects[name] = { path: top, branch };
    saveConfig(cfg);
    console.log(`${name}: baseline ${r.project.repo} now holds ${branch} @ ${short(git(["rev-parse", "HEAD"], { cwd: top }))}.`);
    console.log(`Checks: ${r.project.policy.checks.join(", ") || "none"}   Protected: ${r.project.policy.protected.join(", ")}`);
  },

  // PAVI: push commits made directly in the checkout so new forks start from them.
  async publish() {
    const name = project();
    const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac; run atelier init in it`);
    const t = await call("POST", `${P(name)}/baseline-token`, { scope: "write" }, "pavi");
    git([...auth(t.token), "push", "--quiet", t.remote, `${p.branch}:${p.branch}`], { cwd: p.path });
    console.log(`Baseline ${name} now at ${short(git(["rev-parse", p.branch], { cwd: p.path }))}.`);
  },

  async new() {
    const title = args._.slice(1).join(" ");
    if (!title) die('usage: atelier new "title" [--scope GLOB]...');
    const item = await call("POST", `${P(project())}/items`, { title, scope: args.multi.scope ?? [] }, actor("pavi"));
    console.log(`${item.id}  ${item.title}${item.scope.length ? `  [${item.scope.join(" ")}]` : ""}`);
  },

  async ls() {
    const name = project();
    const { items } = await call("GET", P(name), undefined, actor("pavi"));
    for (const i of items) {
      if (!args.all && (i.state === "landed" || i.state === "abandoned")) continue;
      console.log(`${i.id.padEnd(5)} ${i.state.padEnd(10)} ${(i.owner ?? "—").padEnd(26)} ${short(i.head)}  ${i.title}`);
    }
  },

  async show() {
    const d = await call("GET", I(project(), itemArg()), undefined, actor("pavi"));
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
    const r = await call("POST", `${I(name, id)}/claim`, {}, as);
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
    console.log(`${id} is yours, ${as}. Work here:\n  cd ${JSON.stringify(dir)}`);
    console.log(`Write token expires ${r.workspace.expiresAt}; run \`atelier claim ${id}\` again to refresh it.`);
    console.log(`Then: commit → atelier push → atelier check → atelier submit`);
  },

  async push() {
    const name = project(), id = itemArg(), as = actor();
    const branch = wsConfig("branch") ?? "main";
    const head = git(["rev-parse", "HEAD"]);
    git(["push", "--quiet", "origin", `HEAD:${branch}`]);
    const item = await call("POST", `${I(name, id)}/push`, { head }, as);
    if (item.head !== head) die(`pushed ${short(head)} but Artifacts reports ${short(item.head)}; recorded what Artifacts reports`);
    console.log(`${id} head ${short(item.head)} (observed in Artifacts).`);
  },

  // Agents: bring the workspace up to date with what has landed since the fork.
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
    const name = project(), id = itemArg(), as = actor();
    const d = await call("GET", I(name, id), undefined, as);
    const cmds = args.rest?.length ? [args.rest.join(" ")] : d.policy.checks;
    if (!cmds.length) die("this project has no required checks; pass one: atelier check -- npm test");
    const ws = await call("POST", `${I(name, id)}/read-token`, {}, as);
    if (!ws.head) die("nothing pushed yet");
    const base = await call("POST", `${P(name)}/baseline-token`, { scope: "read" }, as);
    const { dir, changed } = cleanClone(ws.remote, ws.token, ws.head, base);
    let failed = 0;
    try {
      for (const cmd of cmds) {
        const r = runCheck(cmd, dir);
        await call("POST", `${I(name, id)}/evidence`, {
          kind: "check", claim: cmd, head: ws.head, passed: r.passed, changedPaths: changed,
          outputTail: `${r.output.slice(-3500)}\n[sha256 of full output: ${r.sha}]`,
        }, as);
        console.log(`${r.passed ? "PASS" : "FAIL"}  ${cmd}  @ ${short(ws.head)}`);
        if (!r.passed) { failed++; process.stdout.write(r.output.slice(-2000) + "\n"); }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    console.log(`changed: ${changed.join(", ") || "nothing"}`);
    if (failed) process.exit(2);
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
    await call("POST", `${I(name, id)}/submit`, {}, as);
    const d = await call("GET", I(name, id), undefined, as);
    console.log(d.gate.ready ? `${id} submitted and ready for PAVI.` : `${id} submitted. Still blocking:\n${d.gate.blockers.map((b) => `  - ${b}`).join("\n")}`);
  },

  // Reviewers: read another agent's work without being able to change it.
  async diff() {
    const name = project(), id = itemArg(), as = actor("pavi");
    const ws = await call("POST", `${I(name, id)}/read-token`, {}, as);
    const base = await call("POST", `${P(name)}/baseline-token`, { scope: "read" }, as);
    const { dir } = cleanClone(ws.remote, ws.token, ws.head, null);
    try {
      git([...auth(base.token), "fetch", "--quiet", base.remote, base.defaultBranch], { cwd: dir });
      const mb = git(["merge-base", "FETCH_HEAD", "HEAD"], { cwd: dir });
      process.stdout.write(git(["log", "--format=%h %s", `${mb}..HEAD`], { cwd: dir }) + "\n\n");
      process.stdout.write(git(["diff", "--stat", mb, "HEAD"], { cwd: dir }) + "\n\n");
      process.stdout.write(git(["diff", mb, "HEAD"], { cwd: dir }) + "\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  async review() {
    const name = project(), id = itemArg(), as = actor();
    if (!args.approve && !args.reject) die("usage: atelier review t3 --approve|--reject --note '…' --as harness/model");
    const d = await call("GET", I(name, id), undefined, as);
    await call("POST", `${I(name, id)}/review`, { approve: Boolean(args.approve), note: args.note === true ? "" : args.note ?? "", head: d.item.head }, as);
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
    const item = await call("POST", `${I(name, id)}/accept`, {}, "pavi");
    console.log(`${id} accepted at ${short(item.acceptedHead)}. Land it with: atelier land ${id}`);
  },

  async abandon() {
    const name = project(), id = itemArg();
    await call("POST", `${I(name, id)}/abandon`, { note: args.note ?? "" }, "pavi");
    console.log(`${id} abandoned.`);
  },

  // PAVI, in the iCloud checkout: merge exactly the accepted head, record the
  // provenance as a git note, and publish the new baseline.
  async land() {
    const name = project(), id = itemArg();
    const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac`);
    const cwd = p.path;
    const d = await call("GET", I(name, id), undefined, "pavi");
    const { item } = d;
    if (item.state !== "accepted") die(`${id} is ${item.state}; accept it first`);
    if (git(["status", "--porcelain"], { cwd })) die(`${cwd} has uncommitted changes; land into a clean checkout`);
    if (git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd }) !== p.branch) die(`check out ${p.branch} in ${cwd} first`);

    const base = await call("POST", `${P(name)}/baseline-token`, { scope: "write" }, "pavi");
    git([...auth(base.token), "fetch", "--quiet", base.remote, p.branch], { cwd });
    const baselineHead = git(["rev-parse", "FETCH_HEAD"], { cwd });
    const ahead = git(["merge-base", "--is-ancestor", baselineHead, "HEAD"], { cwd, allowFail: true });
    if (ahead.status !== 0) die(`the baseline has commits this checkout lacks (${short(baselineHead)}); pull them in first`);

    const ws = await call("POST", `${I(name, id)}/read-token`, {}, "pavi");
    git([...auth(ws.token), "fetch", "--quiet", ws.remote, item.acceptedHead], { cwd });
    if (git(["rev-parse", "FETCH_HEAD"], { cwd }) !== item.acceptedHead) die("fetched head does not match the accepted head");

    const owners = [...new Set(d.events.filter((e) => e.kind === "item.claimed" || e.kind === "item.handoff").map((e) => e.data.to ?? e.actor))];
    const msg = `Land ${id}: ${item.title}\n\nAtelier: ${name}/${id} accepted at ${item.acceptedHead}\nWorked by: ${owners.join(" → ") || item.owner}`;
    const m = git(["merge", "--no-ff", "-m", msg, item.acceptedHead], { cwd, allowFail: true });
    if (m.status !== 0) {
      git(["merge", "--abort"], { cwd, allowFail: true });
      die(`merge conflicts. Hand it back: the owner runs \`atelier update\`, pushes, re-checks; you re-accept.\n${m.stdout}`);
    }
    const mergeCommit = git(["rev-parse", "HEAD"], { cwd });
    const view = d.evidence.filter((e) => e.head === item.acceptedHead);
    const note = [
      `atelier ${name}/${id} "${item.title}"`,
      `accepted head ${item.acceptedHead}`,
      ...view.map((e) => `${e.grade.toUpperCase()} ${e.passed === null ? "" : e.passed ? "pass " : "FAIL "}${e.claim} — ${e.by} ${e.at}`),
      ...d.reviews.filter((r) => r.head === item.acceptedHead).map((r) => `REVIEW ${r.approve ? "approve" : "reject"} — ${r.by}: ${r.note}`),
      ...d.events.slice().reverse().map((e) => `${e.at} ${e.actor} ${e.kind}`),
    ].join("\n");
    git(["notes", "--ref=atelier", "add", "-f", "-m", note, mergeCommit], { cwd });
    git([...auth(base.token), "push", "--quiet", base.remote, `${p.branch}:${p.branch}`, "refs/notes/atelier:refs/notes/atelier"], { cwd });
    const r = await call("POST", `${I(name, id)}/landed`, { mergeCommit }, "pavi");
    console.log(`${id} landed as ${short(mergeCommit)} in ${cwd}; baseline updated${r ? "" : ""}.`);
    console.log(`Provenance: git notes --ref=atelier show ${short(mergeCommit)}`);
    if (git(["remote"], { cwd }).split("\n").includes("origin")) console.log(`Push to GitHub when you're ready: git push origin ${p.branch}`);
  },

  async inbox() {
    const entries = await call("GET", "/inbox", undefined, "pavi");
    if (!entries.length) return console.log("Nothing needs you.");
    for (const x of entries) console.log(`${x.kind.toUpperCase().padEnd(8)} ${x.project}/${x.itemId}  ${x.title}\n         ${x.reason}`);
  },

  async open() {
    spawnSync("open", [server()]);
  },

  guide() {
    process.stdout.write(`## Working through Atelier

Several agents may work on this project at once. Each piece of work is an
item with exactly one owner. Never edit the project checkout directly.

1. \`atelier ls --project NAME\` — find an open item, or ask PAVI to create one.
2. \`atelier claim ID --project NAME --as HARNESS/MODEL\` — you get a private
   workspace (a fork of the project). Work only there.
3. Commit, then \`atelier push\`. Atelier records the head it sees in Artifacts.
4. \`atelier check\` — runs the project's required checks in a clean clone of
   exactly that head. Only these count as Observed. \`atelier report "…"\`
   records anything else you verified; it shows as Reported, never as passing.
5. \`atelier submit\` when the gate is clear. PAVI accepts and lands.
6. If you can't finish, \`atelier handoff ID --to HARNESS/MODEL --note "…"\`
   or \`atelier release ID\`. Your write token is revoked either way.
7. Reviewing someone else's item: \`atelier diff ID\`, then
   \`atelier review ID --approve|--reject --note "…"\`. Changes to protected
   paths need approval from a different model than the owner's.
8. \`atelier update\` rebases your workspace onto whatever has landed since.
`);
  },

  help() {
    console.log(`atelier — one owner per item, observed evidence, PAVI decides.

Setup      login --server URL · init [--check CMD]... [--protect GLOB]... · publish
Items      new "title" [--scope GLOB]... · ls [--all] · show ID · inbox · open
Agents     claim ID --as H/M · push · update · check [-- CMD] · report "…" · submit
           handoff ID --to H/M · release ID · diff ID · review ID --approve|--reject
PAVI       accept ID · land ID · abandon ID
Docs       guide   (paste into a project's AGENTS.md)

Common flags: --project NAME, --as harness/model (or ATELIER_ACTOR).`);
  },
};

const cmd = args._[0] ?? "help";
const fn = commands[cmd];
if (!fn) die(`unknown command "${cmd}"; try atelier help`);
await fn();
