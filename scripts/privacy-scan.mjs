// The privacy scan atelier ship runs before the push to GitHub. It reads the
// commits the remote lacks and refuses on a hit: an author or committer that
// is not a GitHub no-reply address, an added line that looks like a key, or a
// path the project keeps private. It prints each hit without the value found.
//
//   node scripts/privacy-scan.mjs --remote github --branch main --project atelier
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IDENTITY_LOG_FORMAT, isPublicEmail, parseIdentityLog } from "../src/commit-identity.ts";
import { scanLine } from "../src/secret-scan.ts";
import { privateCommits, privateCommitsText, privateGuardFor } from "../cli/private-guard.mjs";

const ALLOW_FILE = fileURLToPath(new URL("../docs/atelier/privacy-allow.json", import.meta.url));

// The reviewed allowances in docs/atelier/privacy-allow.json. Each names a
// commit (a hash prefix of at least 7 characters), a file, the SHA-256 of the
// exact added line and a reason, so the file holds no key-shaped text. A file
// that cannot be read or has a malformed entry throws, which fails closed.
export function readAllowances(path = ALLOW_FILE) {
  const list = JSON.parse(readFileSync(path, "utf8")).allowances;
  if (!Array.isArray(list)) throw new Error(`${path} has no allowances list`);
  for (const a of list) {
    if (!/^[0-9a-f]{7,64}$/.test(a?.commit) || typeof a.file !== "string" || !a.file || !/^[0-9a-f]{64}$/.test(a.sha256) || typeof a.reason !== "string" || !a.reason) {
      throw new Error(`${path} has an allowance without a commit, file, sha256 and reason`);
    }
  }
  return list;
}

const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const ok = (r, what) => { if (r.status !== 0) throw new Error(`${what} (${(r.stderr || "").trim().split("\n")[0] || `git exited ${r.status}`})`); return r.stdout; };

// The commits to send: reachable from HEAD and not from what the remote holds
// of the branch. A remote that cannot be read stops the scan, which fails closed.
function newCommits(cwd, remote, branch) {
  const ref = `refs/heads/${branch}`;
  const listed = ok(git(cwd, ["ls-remote", "--refs", remote, ref]), `${remote} cannot be read`);
  const head = listed.trim().split("\n").map((l) => l.split(/\s+/)).find(([, name]) => name === ref)?.[0] ?? null;
  if (head && git(cwd, ["cat-file", "-e", `${head}^{commit}`]).status !== 0) {
    ok(git(cwd, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, ref]), `${remote}'s ${ref} could not be fetched`);
  }
  return head ? [head] : [];
}

// The problems found in the commits from `base` to HEAD, one text each.
// `privates` names the private paths; when it is left out they are read
// from the project's private-file guard. `allowances` defaults to the file
// above; a leak hit is skipped only when its commit, file and line hash all
// match an allowance, and `report` is told of each skip (default: printed).
export function privacyScan({ cwd, base, project, privates, allowances = readAllowances(), report = (text) => console.log(text) }) {
  const problems = [];
  const range = ["HEAD", ...(base.length ? ["--not", ...base] : [])];
  for (const c of parseIdentityLog(ok(git(cwd, ["log", `--format=${IDENTITY_LOG_FORMAT}`, ...range]), "the commits could not be listed"))) {
    for (const [field, name, email] of [["author", c.authorName, c.authorEmail], ["committer", c.committerName, c.committerEmail]]) {
      if (!name.trim()) problems.push(`author: commit ${c.commit.slice(0, 12)} has an empty ${field} name`);
      if (!isPublicEmail(email)) problems.push(`author: commit ${c.commit.slice(0, 12)} has the ${field} address ${email || "(empty)"}, not a GitHub no-reply address`);
    }
  }
  const patch = ok(git(cwd, ["log", "--format=C%H", "-p", "--root", "--diff-merges=separate", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", ...range]), "the changes could not be read");
  let commit = "", full = "", file = "";
  const seen = new Set();
  for (const line of patch.split("\n")) {
    if (/^C[0-9a-f]{40,64}$/.test(line)) { full = line.slice(1); commit = full.slice(0, 12); file = ""; }
    else if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
    else if (line.startsWith("+") && scanLine(line.slice(1))) {
      const sha256 = createHash("sha256").update(line.slice(1)).digest("hex");
      const allowance = allowances.find((a) => full.startsWith(a.commit) && a.file === file && a.sha256 === sha256);
      if (allowance) { report(`allowed: commit ${commit} adds a line to ${file} that the privacy allowance list permits (${allowance.reason})`); continue; }
      const key = `${commit} ${file}`;
      if (!seen.has(key)) { seen.add(key); problems.push(`leak: commit ${commit} adds a line to ${file || "a file"} that looks like a key or secret`); }
    }
  }
  let paths = privates;
  if (!paths) {
    const guard = privateGuardFor(project);
    if (guard.refusal) problems.push(`private files: ${guard.refusal}`);
    paths = guard.paths ?? [];
  }
  const found = privateCommits(cwd, paths, "HEAD", base);
  if (found.length) problems.push(`private files: ${privateCommitsText(found)}`);
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , ...argv] = process.argv;
    const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
    const remote = opt("remote"), branch = opt("branch"), project = opt("project");
    if (!remote || !branch || !project || argv.length !== 6) throw new Error("Usage: node scripts/privacy-scan.mjs --remote NAME --branch NAME --project NAME");
    const cwd = process.cwd();
    const base = newCommits(cwd, remote, branch);
    const problems = privacyScan({ cwd, base, project });
    if (problems.length) {
      console.error(`Refused: ${problems.length} privacy ${problems.length === 1 ? "hit" : "hits"} in what ${remote}/${branch} lacks. Nothing was pushed.`);
      for (const p of problems.slice(0, 50)) console.error(`  ${p}`);
      process.exitCode = 1;
    } else console.log(`Privacy scan clean: authors, leaks and private files in the commits ${remote}/${branch} lacks.`);
  } catch (error) {
    console.error(`Privacy scan could not finish, so it refuses: ${error.message}`);
    process.exitCode = 1;
  }
}
