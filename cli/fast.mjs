// Fast mode's batch landing (t585): `atelier fast land tN=SHA [tM=SHA ...]`.
//
// In the owner's own checkout (a clean main), each SHA is merged in order
// through the merge pipeline (t463's mergeThrough, cli/merge-pipeline.mjs),
// so declared generated outputs are regenerated after the sources merge and
// never stop a batch on a text conflict (t587). The generated files are then
// regenerated and committed, and the batch is checked once: the typecheck,
// the secret scan over the batch's added lines, and one run of the test
// command. Anything that fails resets main to where it started, so main is
// never left half-merged. Only on success are the receipts recorded, one per
// task, through `record`. It never pushes or deploys; the caller prints the
// owner's next commands.
//
// The work is here, apart from the command, so a test drives it in a
// temporary repository with stand-in commands and a stand-in recorder.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { scanLine } from "../src/secret-scan.ts";
import { agentOfMessage } from "../src/rules.ts";
import { describeConflicts, mergeThrough } from "./merge-pipeline.mjs";

const SHA = /^[0-9a-f]{7,64}$/;

export function parsePairs(list) {
  const pairs = [];
  for (const arg of list) {
    const m = /^(t\d+)=([0-9a-f]+)$/.exec(String(arg));
    if (!m || !SHA.test(m[2])) throw new Error(`"${arg}" is not tN=SHA`);
    if (pairs.some((p) => p.id === m[1])) throw new Error(`${m[1]} is named twice`);
    pairs.push({ id: m[1], sha: m[2] });
  }
  if (!pairs.length) throw new Error("name at least one tN=SHA");
  return pairs;
}

function git(cwd, ...a) {
  const r = spawnSync("git", a, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw Object.assign(new Error(`git ${a.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`), { step: `git ${a[0]}` });
  return r.stdout.trim();
}

function sh(cwd, command) {
  const r = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: process.env });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, status: r.status };
}

// Added lines of the batch's diff that the server's push scan would flag.
// It names the file and line, never the value.
export function scanBatch(cwd, start) {
  const diff = git(cwd, "diff", "--no-color", "--no-ext-diff", "-U0", `${start}..HEAD`);
  const hits = [];
  let file = null, line = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) { file = l.slice(4).replace(/^b\//, ""); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (l.startsWith("+")) { if (scanLine(l.slice(1))) hits.push(`${file}:${line}`); line++; }
  }
  return hits;
}

// `titles` maps each task to its title; `record(id, receipt)` posts one
// receipt; `log` prints a step; `run` runs a declared generator for the merge
// pipeline (its default where omitted). Returns { ok, start, head, landed,
// failure }.
export async function fastLand({ cwd, pairs, titles, reason, typecheck, test, regen, record, run, log = () => {} }) {
  if (git(cwd, "rev-parse", "--abbrev-ref", "HEAD") !== "main") throw new Error("fast land runs in a checkout of main");
  if (git(cwd, "status", "--porcelain", "--untracked-files=no")) throw new Error("the checkout has uncommitted changes; fast land needs a clean main");
  const start = git(cwd, "rev-parse", "HEAD");
  const merged = [];
  let failure = null, tests = null;
  try {
    for (const { id, sha } of pairs) {
      const commit = git(cwd, "rev-parse", "--verify", `${sha}^{commit}`);
      const builder = agentOfMessage(git(cwd, "log", "-1", "--format=%B", commit));
      if (!builder) { failure = { step: `merge ${id}`, detail: `${commit.slice(0, 12)} has no Agent: line naming its builder` }; break; }
      const message = `Merge ${id}: ${titles[id] ?? id}\n\nLanded fast: ${reason}`;
      // Through the pipeline (t587): a declared generated output both sides
      // changed is regenerated from the merged sources, not merged as text.
      const r = await mergeThrough(cwd, commit, { message, run, log });
      if (r.state === "held") { failure = { step: `merge ${id}`, detail: `main already holds ${commit.slice(0, 12)}, so there is nothing of ${id} to land` }; break; }
      if (r.state === "conflicts") { failure = { step: `merge ${id}`, detail: describeConflicts(r, r.manifest) }; break; }
      if (r.state !== "merged") { failure = { step: `merge ${id}`, detail: String(r.reason ?? r.state).trim().split("\n").slice(-5).join("\n") }; break; }
      merged.push({ id, commit, builder, mergeCommit: git(cwd, "rev-parse", "HEAD") });
      log(`merged ${id} (${commit.slice(0, 12)}) as ${merged.at(-1).mergeCommit.slice(0, 12)}`);
      for (const g of r.regenerated ?? []) log(`regenerated ${g.outputs.map((o) => `${o.path} (matches ${o.matches})`).join(", ")} with ${g.command.join(" ")}`);
    }
    if (!failure && regen) {
      const r = sh(cwd, regen);
      if (!r.ok) failure = { step: "regenerate", detail: r.output.trim().split("\n").slice(-10).join("\n") };
      else if (git(cwd, "status", "--porcelain")) {
        git(cwd, "add", "-A");
        git(cwd, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", `Regenerate after fast landing of ${pairs.map((p) => p.id).join(", ")}\n\nLanded fast: ${reason}`);
        log("regenerated and committed the generated files");
      }
    }
    if (!failure && typecheck) {
      const r = sh(cwd, typecheck);
      if (!r.ok) failure = { step: "typecheck", detail: r.output.trim().split("\n").slice(-20).join("\n") };
      else log(`typecheck passed: ${typecheck}`);
    }
    if (!failure) {
      const hits = scanBatch(cwd, start);
      if (hits.length) failure = { step: "secret scan", detail: `added lines that look like credentials: ${hits.slice(0, 20).join(", ")}` };
      else log("secret scan found nothing in the batch's added lines");
    }
    if (!failure) {
      const r = sh(cwd, test);
      if (!r.ok) failure = { step: "tests", detail: r.output.trim().split("\n").slice(-20).join("\n") };
      else { tests = { command: test, sha256: createHash("sha256").update(r.output).digest("hex") }; log(`tests passed once for the batch: ${test}`); }
    }
    if (failure) {
      spawnSync("git", ["merge", "--abort"], { cwd });
      git(cwd, "reset", "-q", "--hard", start);
      return { ok: false, start, head: git(cwd, "rev-parse", "HEAD"), landed: [], failure };
    }
  } catch (err) {
    spawnSync("git", ["merge", "--abort"], { cwd });
    spawnSync("git", ["reset", "-q", "--hard", start], { cwd });
    return { ok: false, start, head: git(cwd, "rev-parse", "HEAD"), landed: [], failure: { step: err?.step ?? "error", detail: err?.message ?? String(err) } };
  }
  // Main holds the checked batch now. A receipt the server refuses leaves it
  // so (the merges passed); the caller names what was and was not recorded.
  const head = git(cwd, "rev-parse", "HEAD");
  const landed = [];
  for (const m of merged) {
    const receipt = { commit: m.commit, mergeCommit: m.mergeCommit, builder: m.builder, tests };
    try { landed.push({ ...m, receipt, answer: await record(m.id, receipt) }); }
    catch (err) { return { ok: false, start, head, landed, failure: { step: `record ${m.id}`, detail: err?.message ?? String(err), merged: true } }; }
  }
  return { ok: true, start, head, landed, failure: null };
}

export const DEFAULT_REGEN = (cwd) => existsSync(join(cwd, "bin/orchestrate/regen-fixtures.sh")) ? "zsh bin/orchestrate/regen-fixtures.sh" : null;
