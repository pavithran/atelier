// The privacy scan atelier ship runs before the push to GitHub. It reads the
// commits the remote lacks and refuses on a hit: an author or committer that
// is not a GitHub no-reply address, an added line that looks like a key, or a
// path the project keeps private. It prints each hit without the value found.
//
//   node scripts/privacy-scan.mjs --remote github --branch main --project atelier
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IDENTITY_LOG_FORMAT, isPublicEmail, parseIdentityLog } from "../src/commit-identity.ts";
import { scanLine } from "../src/secret-scan.ts";
import { privateCommits, privateCommitsText, privateGuardFor } from "../cli/private-guard.mjs";

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
// from the project's private-file guard.
export function privacyScan({ cwd, base, project, privates }) {
  const problems = [];
  const range = ["HEAD", ...(base.length ? ["--not", ...base] : [])];
  for (const c of parseIdentityLog(ok(git(cwd, ["log", `--format=${IDENTITY_LOG_FORMAT}`, ...range]), "the commits could not be listed"))) {
    for (const [field, name, email] of [["author", c.authorName, c.authorEmail], ["committer", c.committerName, c.committerEmail]]) {
      if (!name.trim()) problems.push(`author: commit ${c.commit.slice(0, 12)} has an empty ${field} name`);
      if (!isPublicEmail(email)) problems.push(`author: commit ${c.commit.slice(0, 12)} has the ${field} address ${email || "(empty)"}, not a GitHub no-reply address`);
    }
  }
  const patch = ok(git(cwd, ["log", "--format=C%H", "-p", "--root", "--diff-merges=separate", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", ...range]), "the changes could not be read");
  let commit = "", file = "";
  const seen = new Set();
  for (const line of patch.split("\n")) {
    if (/^C[0-9a-f]{40,64}$/.test(line)) { commit = line.slice(1, 13); file = ""; }
    else if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
    else if (line.startsWith("+") && scanLine(line.slice(1))) {
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
