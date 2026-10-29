// Moving a project's repository to the Studio (Atelier 2.0, task 11; design
// section 5, steps 4 to 7). The server itself fetches from the old host, an
// Artifacts baseline or any Git remote the developer names, and writes the
// refs into the project's bare repository with `git update-ref`, naming the
// old value: since task 6 no owner push moves the project's branch once it
// exists, so the move is the server's own write, never a push. During the
// bake the server pushes the project's branch back to the old baseline after
// each landing, so the way back finds it current.
//
// A credential for the old host reaches git through its environment
// (GIT_CONFIG_COUNT and an http.extraHeader), never its arguments, a log or
// a file; the way back's, which outlives a request, is kept in a file of its
// own under the data directory, mode 600, as the grant store is.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openScan } from "./policy.mjs";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { branchTip, holds } from "./branches.mjs";

const ZERO = "0".repeat(40);
const STAGE = "refs/atelier-move";
const NOTES = "refs/notes/atelier";
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function gitEnv(token) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", GIT_PROTOCOL_FROM_USER: "0" };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_CONFIG_") || k === "GIT_DIR") delete env[k];
  // A local path is the file transport, which GIT_PROTOCOL_FROM_USER=0 would
  // refuse; https and http are always allowed and nothing else is.
  const settings = [["protocol.allow", "never"], ["protocol.https.allow", "always"], ["protocol.http.allow", "always"], ["protocol.file.allow", "always"]];
  if (token) settings.push(["http.extraHeader", `Authorization: Bearer ${token}`]);
  env.GIT_CONFIG_COUNT = String(settings.length);
  settings.forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${i}`] = key; env[`GIT_CONFIG_VALUE_${i}`] = value; });
  return env;
}

// Runs git in the bare repository `dir`. A failure's message is git's own
// last lines, with any token taken out.
function git(dir, args, token = null, timeout = 15 * 60_000) {
  return new Promise((ok, fail) => execFile("git", args, { cwd: dir, encoding: "utf8", env: gitEnv(token), maxBuffer: 1 << 26, timeout }, (err, stdout, stderr) => {
    if (!err) return ok(stdout.trim());
    let said = String(stderr || err.message).trim().split("\n").filter((l) => !/^hint:/.test(l)).slice(-3).join(" ").slice(0, 400);
    if (token) said = said.split(token).join("[token]");
    fail(Object.assign(new Error(said), { status: err.code }));
  }));
}

// The refs the remote has, as { ref: sha }.
async function remoteRefs(dir, remote, token) {
  const out = await git(dir, ["ls-remote", "--refs", remote], token, 120_000);
  const refs = {};
  for (const line of out.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (sha && ref && SHA.test(sha)) refs[ref] = sha;
  }
  return refs;
}

// Moves `ref` from `from` (null: it must not exist) to `to`.
const setRef = (dir, ref, to, from, why) => git(dir, ["update-ref", "-m", `atelier: ${why}`, ref, to, from ?? ZERO]);

// How a local ref stands against the fetched commit: created, unchanged,
// forwarded (the local one is in the fetched one's history, and is moved
// on), ahead (the fetched one is in the local one's history: this server has
// moved on since, by a landing, and nothing changes) or diverged (neither).
async function follow(dir, ref, local, fetched, why) {
  if (!local) { await setRef(dir, ref, fetched, null, why); return "created"; }
  if (local === fetched) return "unchanged";
  if (await holds(dir, local, fetched)) { await setRef(dir, ref, fetched, local, why); return "forwarded"; }
  if (await holds(dir, fetched, local)) return "ahead";
  return "diverged";
}

async function revParse(dir, ref) {
  try { return await git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) || null; } catch { return null; }
}

// Mirrors the project's branch, Atelier's provenance notes and the tags of
// `remote` into the bare repository `dir`. The branch is fetched to a staging
// ref first and then set, created when the repository lacks it and moved
// on when it is behind, so a second run at the cut-over carries what changed
// since the rehearsal. A branch this server has moved past is left; one that
// has diverged from the remote's refuses, naming both. Answers what was
// done, with the branch verified equal to the remote's.
// A project whose record names no branch (registered before records kept
// one) takes the remote's HEAD branch.
// `scan` is { root, policy }: the directory the scan's files go in and the
// policy the hook would read ({ clearances, private }); without it nothing
// is scanned.
export async function mirrorBranch({ dir, branch: named, remote, token, scan = null }) {
  const refs = await remoteRefs(dir, remote, token);
  let branch = named;
  if (!branch) {
    const head = await git(dir, ["ls-remote", "--symref", remote, "HEAD"], token, 120_000).catch(() => "");
    branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head)?.[1] ?? null;
    if (!branch) return { error: "no_branch", detail: `${remote.replace(/\?.*$/, "")} names no HEAD branch, and the project's record names none` };
  }
  const want = refs[`refs/heads/${branch}`];
  if (!want) return { error: "no_branch", detail: `${remote.replace(/\?.*$/, "")} has no branch ${branch}` };
  const specs = [`+refs/heads/${branch}:${STAGE}/head`];
  if (refs[NOTES]) specs.push(`+${NOTES}:${STAGE}/notes`);
  const tags = Object.keys(refs).filter((r) => r.startsWith("refs/tags/"));
  try {
    await git(dir, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, ...specs, ...tags.map((t) => `${t}:${t}`)], token);
    const fetched = await revParse(dir, `${STAGE}/head`);
    if (fetched !== want) return { error: "moved", detail: `${branch} on the remote moved while it was fetched (${want.slice(0, 8)}, then ${String(fetched).slice(0, 8)})` };
    const before = await branchTip(dir, branch);
    // What the move adds meets the checks a push would (the hook's rules 5
    // and 6): the secret scan, less the lines the developer cleared, and the
    // private-file guard, before any ref here moves.
    if (scan && fetched !== before && !(before && await holds(dir, fetched, before))) {
      const refused = await scanMove({ dir, scan, old: before ?? ZERO, sha: fetched, ref: `refs/heads/${branch}`, branch });
      if (refused) return { error: "scan_refused", ...refused, before, remoteHead: fetched };
    }
    const moved = await follow(dir, `refs/heads/${branch}`, before, fetched, `move-host from ${remote.replace(/\?.*$/, "")}`);
    if (moved === "diverged") return { error: "diverged", detail: `${branch} here (${before.slice(0, 8)}) and on the remote (${fetched.slice(0, 8)}) have each moved apart from the other`, before, remoteHead: fetched };
    const head = await branchTip(dir, branch);
    if (moved !== "ahead" && head !== fetched) return { error: "moved", detail: `${branch} here is ${String(head).slice(0, 8)}, not the remote's ${fetched.slice(0, 8)}, after the move` };
    let notes = "none";
    if (refs[NOTES]) {
      const got = await revParse(dir, `${STAGE}/notes`);
      const had = await revParse(dir, NOTES);
      const refused = got && scan && got !== had ? await scanMove({ dir, scan, old: had ?? ZERO, sha: got, ref: NOTES, branch }) : null;
      notes = refused ? `not moved: ${refused.detail}` : got ? await follow(dir, NOTES, had, got, "move-host notes") : "none";
    }
    return { branch, before, head, remoteHead: fetched, moved, notes, tags: tags.length };
  } finally {
    for (const r of ["head", "notes"]) await git(dir, ["update-ref", "-d", `${STAGE}/${r}`]).catch(() => {});
  }
}

// Runs the hook's scans over `old..sha` for `ref` in the bare repository
// `dir`, in a process whose directory is the repository (src/git/scan-run.mjs).
// Answers null, or { detail, hits } for a refusal.
const SCAN_RUN = fileURLToPath(new URL("./scan-run.mjs", import.meta.url));
// A push adds at most TASK_COMMITS (1,000) commits, as `atelier init` and
// the old pushHistory send a long history in steps. A move reads a long
// history the same way: in steps along the first-parent line, each at most
// STEP commits past the last, so each step stays under the hook's cap.
const STEP = 400;
async function scanMove({ dir, scan, old, sha, ref, branch }) {
  const line = (await git(dir, ["rev-list", "--first-parent", "--reverse", sha, ...(/^0+$/.test(old) ? [] : ["--not", old])])).split("\n").filter(Boolean);
  const stops = line.filter((_, i) => (i + 1) % STEP === 0 && i + 1 < line.length);
  let from = old;
  for (const to of [...stops, sha]) {
    const refused = await scanStep({ dir, scan, old: from, sha: to, ref, branch });
    if (refused) return refused;
    from = to;
  }
  return null;
}
async function scanStep({ dir, scan, old, sha, ref, branch }) {
  const files = openScan(scan.root, scan.policy);
  try {
    const args = JSON.stringify({ old, sha, ref, branch, policyPath: files.env.ATELIER_POLICY, reportPath: files.env.ATELIER_REPORT });
    const out = await new Promise((ok, fail) => execFile(process.execPath, [SCAN_RUN, args], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 24, timeout: 15 * 60_000, env: { ...process.env, GIT_DIR: dir } },
      (err, stdout, stderr) => (err ? fail(new Error(String(stderr || err.message).trim().split("\n").slice(-2).join(" "))) : ok(stdout))));
    const { refusal } = JSON.parse(out.trim().split("\n").at(-1));
    if (!refusal) return null;
    const report = files.report();
    return { detail: refusal, hits: (report?.hits ?? []).filter((h) => !scan.policy.clearances.some((c) => c.file === h.file && c.fingerprint === h.fingerprint)) };
  } catch (error) {
    return { detail: `the moved history could not be scanned (${error.message}); nothing was moved`, hits: [] };
  } finally { files.close(); }
}

// Carries one task's work (design section 5, step 4: `atelier migrate tN`):
// fetches `ref` of `remote` (its Artifacts fork, or any remote) and makes
// refs/heads/BRANCH at `head`, the head the Ledger records, which the fetched
// history must hold. A branch already at `head` is taken as done. Answers
// { head, tip } (tip: the remote ref's commit), or { error, detail }.
export async function carryBranch({ dir, branch, remote, ref, token, head }) {
  if (!SHA.test(head)) return { error: "no_head", detail: "the task records no head to carry" };
  const at = await branchTip(dir, branch);
  if (at === head) return { head, tip: null, carried: false };
  if (at) return { error: "branch_exists", detail: `${branch} already exists here at ${at.slice(0, 8)}, not the recorded head ${head.slice(0, 8)}` };
  const stage = `${STAGE}/task`;
  try {
    try { await git(dir, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, `+${ref}:${stage}`], token); }
    catch (error) { return { error: "fetch_failed", detail: `the fetch of ${ref} failed: ${error.message}` }; }
    const tip = await revParse(dir, stage);
    if (!tip) return { error: "fetch_failed", detail: `${ref} was not fetched` };
    if (!await revParse(dir, head) || !await holds(dir, head, tip)) {
      return { error: "head_missing", detail: `${ref} on the remote is at ${tip.slice(0, 8)}, whose history does not hold the recorded head ${head.slice(0, 8)}` };
    }
    await setRef(dir, `refs/heads/${branch}`, head, null, "migrate");
    return { head, tip, carried: true };
  } finally {
    await git(dir, ["update-ref", "-d", stage]).catch(() => {});
  }
}

// Deletes refs/heads/BRANCH while it still names `at`. True when it went.
export async function dropBranch(dir, branch, at) {
  try { await git(dir, ["update-ref", "-d", `refs/heads/${branch}`, at]); return true; } catch { return false; }
}

// The way back's record for a project (`atelier projects move-host --way-back`):
// the old baseline's remote and the token that writes it, kept until the
// bake ends, in DATA/way-back/KEY.json, mode 600, readable by the server's
// user alone.
export class WayBack {
  constructor(dataDir) { this.dir = join(dataDir, "way-back"); }
  #file(key) { return join(this.dir, `${key}.json`); }
  get(key) {
    try { return JSON.parse(readFileSync(this.#file(key), "utf8")); } catch { return null; }
  }
  set(key, { remote, token }) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.#file(key);
    writeFileSync(file, JSON.stringify({ remote, token: token ?? null }), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  clear(key) { rmSync(this.#file(key), { force: true }); }
}

// Pushes the project's branch, and the notes when there are any, back to the
// old baseline: a fast-forward, never forced, so a baseline someone moved
// on is refused by git and reported, not overwritten. Answers { head } or
// { error, detail }.
export async function pushBack({ dir, branch, remote, token }) {
  const head = await branchTip(dir, branch);
  if (!head) return { error: "empty", detail: `${branch} has no commits here` };
  try { await git(dir, ["push", "--quiet", "--no-verify", remote, `refs/heads/${branch}:refs/heads/${branch}`], token); }
  catch (error) { return { error: "push_failed", detail: error.message, head }; }
  let notes = null;
  if (await revParse(dir, NOTES)) {
    try { await git(dir, ["push", "--quiet", "--no-verify", remote, `${NOTES}:${NOTES}`], token); notes = "pushed"; }
    catch (error) { notes = `not pushed: ${error.message}`; }
  }
  return { head, notes };
}
