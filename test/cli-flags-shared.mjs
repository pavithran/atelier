// What the parts of cli-flags.test.mjs share (t771); the tests were split across files so none runs for more than about a minute.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";
export function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-flags-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  const identity = (cwd) => { git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "test@example.invalid"); };
  // The owner's checkout, the baseline it was copied to, and the task fork.
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  identity(checkout);
  writeFileSync(join(checkout, "STATE.md"), "Current state\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "Initial");
  const head = git(checkout, "rev-parse", "HEAD");
  const baseline = join(dir, "baseline.git");
  git(dir, "init", "-q", "--bare", "-b", "main", baseline);
  git(checkout, "push", "-q", baseline, "main");
  const fork = join(dir, "fork.git");
  git(dir, "clone", "-q", "--bare", baseline, fork);
  // t1's workspace, as a claim leaves it: the clone records its project, item and actor.
  const workspace = join(dir, "cache", "work", "demo", "t1");
  mkdirSync(join(dir, "cache", "work", "demo"), { recursive: true });
  git(dir, "clone", "-q", fork, workspace);
  identity(workspace);
  for (const [k, v] of Object.entries({ project: "demo", item: "t1", actor: "codex/test", branch: "main" })) git(workspace, "config", "--local", `atelier.${k}`, v);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", owner: "owner", ownerName: "Pavi", projects: { demo: { path: checkout, branch: "main" } } }));
  const log = join(dir, "requests.jsonl");
  const preload = join(dir, "server.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
const HEAD = ${JSON.stringify(head)}, BASELINE = ${JSON.stringify(baseline)};
const TIMES = { createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-10-05T09:30:00.000Z", lastPushAt: "2026-10-05T09:00:00.000Z" };
// t3 is open and held by nobody; every other item is submitted by codex/test.
const item = (id) => ({ id, title: "Task " + id, scope: [], state: id === "t3" ? "open" : "submitted", owner: id === "t3" ? null : "codex/test", head: HEAD, acceptedHead: null, base: HEAD, fork: "demo-" + id, dispatch: null, ...TIMES });
const CHANGES = {
  t4: { reviews: 2, requests: 1, acceptance: false, override: false, asked: ["codex/gpt-6-astra"] },
  t5: { reviews: 0, requests: 1, acceptance: false, override: false, asked: [] },
  t6: { reviews: 0, requests: 0, acceptance: false, override: false, asked: [] },
  t7: { reviews: 1, requests: 0, acceptance: true, override: true, asked: [] },
};
const detail = (id) => ({ item: item(id), policy: { checks: ["exit 0"], protected: [], sandboxOnly: false }, gate: { ready: true, blockers: [] }, evidence: [], reviews: [], events: [], acceptanceProtected: [] });
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname, method = options.method ?? "GET";
  // The capability check before new, edit, init, review and merge (t458) reads the version.
  if (path === "/api/version") return Response.json({ capabilities: ${JSON.stringify(SERVER_CAPABILITIES)} });
  const body = options.body ? JSON.parse(options.body) : undefined;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, path, body, actor: options.headers?.["x-atelier-actor"] ?? null }) + "\\n");
  let data = {};
  const m = /^\\/api\\/projects\\/demo(?:\\/(.*))?$/.exec(path);
  if (path === "/api/config") data = { ownerActor: "owner", ownerName: "Pavi" };
  else if (path === "/api/projects") data = [{ name: "demo", title: "Demo" }];
  else if (path === "/api/inbox") data = [];
  // t389: the pool holds one reserved, review-only frontier model; a set
  // answers with the entry as changed.
  else if (path === "/api/models") data = [{ id: "gpt-6-astra", harness: "codex", where: "cloud", provider: "openai", aliases: [], family: "openai", note: "credits held for t370", addedBy: "owner", addedAt: "2026-10-01T09:00:00.000Z", state: "reserved", stateAt: "2026-10-08T09:00:00.000Z", roles: ["review"], tier: "frontier" }];
  else if (path === "/api/models/gpt-6-astra/set") data = { id: "gpt-6-astra", state: body.state, stateAt: "2026-10-10T08:00:00.000Z", note: body.note, roles: body.roles.split(","), tier: body.tier };
  else if (m) {
    const rest = m[1] ?? "";
    // t394: the stub records a model-policy switch as the server does, stamped with who and when.
    const familyMode = body?.singleFamily !== undefined ? { familyMode: { single: body.singleFamily || null, by: "owner", at: "2026-10-09T10:00:00.000Z" } } : {};
    const project = { name: "demo", title: "Demo", repo: "demo", policy: { checks: body?.checks ?? ["exit 0"], protected: body?.protected ?? [], eligible: [], refuseOverlap: body?.refuseOverlap ?? false, sandboxOnly: body?.sandboxOnly ?? false, ...familyMode } };
    if (rest === "standing") data = { project: { name: "demo", title: "Demo" }, generatedAt: "2026-10-09T12:34:56Z", live: [], waiting: [], merged: [] };
    else if (rest === "" && method === "GET") data = { project, items: [item("t1"), item("t2")], events: [] };
    else if (rest === "" && method === "PUT") data = { project, baseline: { remote: BASELINE, token: "fake-baseline-token", defaultBranch: "main" } };
    // As the server answers an older CLI's long title: kept as the brief, the title derived.
    else if (rest === "items" && method === "POST") data = { id: "t9", title: body.title, scope: body.scope, ...(body.accept ? { accept: body.accept } : {}), ...(body.title.length > 80 && !body.brief ? { title: "Derived title", brief: body.title, derived: true } : {}) };
    else {
      const [, id, verb] = /^items\\/([^/]+)(?:\\/(.*))?$/.exec(rest) ?? [];
      if (verb === "handoff") data = { item: { ...item(id), owner: body.to }, next: "next" };
      // Asked to suggest (t370), it answers as the server does: the builder it chose and why.
      else if (verb === "dispatch" && body.suggest === true) data = { ...item(id), dispatch: { to: "home", agent: "claude-code", model: "opus-5.5" }, suggestion: { actor: "claude-code/opus-5.5", reasons: ["Eligible pool models ranked by recorded successful and failed outcomes.", "Passed over codex/gpt-6.1-sol: two consecutive stalled builds; no successful build since."] } };
      else if (verb === "dispatch") data = { ...item(id), dispatch: { to: body.to ?? "any", agent: body.agent ?? null, model: body.model ?? null, ...(body.job !== undefined ? { job: body.job, head: body.head ?? "5".repeat(40) } : {}) } };
      else if (verb === "block") data = { ...item(id), state: "blocked", blocked: { reason: body.reason, by: "codex/test" } };
      else if (verb === "unblock") data = { ...item(id), state: "claimed" };
      // t326: a change of criteria answers with what it withdrew; t4 had
      // standing reviews and a request, t5 a request alone, t6 neither, t7
      // was accepted with the owner's override; t1 and t2 report no change.
      else if (verb === "edit") data = { ...item(id), ...body, ...(CHANGES[id] && body.accept ? { criteriaChange: { from: "a".repeat(64), to: "b".repeat(64), ...CHANGES[id] } } : {}) };
      else if (verb === "brief") data = { decided: "Wait on " + id, summary: null, nonGoals: [], stopWhen: [], nextGate: null, accept: ["Nested lists parse"], partAccept: ["It works"], criteria: "c".repeat(64), evidence: [], recommendation: { verdict: "wait", reason: "In progress." } };
      // t575: a review claim answers its request, head and criteria binding; a renewal its word.
      else if (verb === "review-claim") data = { item: item(id), head: HEAD, request: 7, criteria: "c".repeat(64) };
      else if (verb === "review-renew") data = { renewed: true };
      else data = detail(id);
    }
  }
  // Any other project is one the server does not know, as the Worker answers it.
  const status = !m && path.startsWith("/api/projects/") ? 404 : 200;
  if (status === 404) data = { error: "no_project", detail: "project not initialised; run atelier init" };
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
};
`);
  const run = (cwd, args, env = {}) => spawnSync(process.execPath, ["--import", preload, cli, ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "fake-owner-token", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "owner", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  const requests = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
  const clear = () => rmSync(log, { force: true });
  return { dir, checkout, workspace, run, requests, clear, head };
}
export const cli = resolve("cli/atelier.mjs");
