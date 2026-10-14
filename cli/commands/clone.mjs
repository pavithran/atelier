// atelier clone. Its forms, flags and help are declared in src/usage/commands/clone.ts.
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FRESH_TRAILER, savePairs } from "../fresh.mjs";
import { installMergeConfig } from "../merge-pipeline.mjs";
import { COMMAND_USAGE } from "../help.mjs";
import { linkPrivate, privateGuardFor } from "../private.mjs";
import { OWNER, P, apiToken, args, call, cfg, die, landingGit, saveConfig, server, short } from "../atelier.mjs";

// The developer, on a Mac that has no checkout of the project yet (t643):
// Git, not iCloud, carries code between Macs, and the project's baseline is
// the remote every Mac shares. The checkout is made from the baseline the
// way a task workspace is (claimWorkspace in cli/atelier.mjs), with the
// baseline as origin. The checkout keeps no token: the developer's write
// token, minted as sync mints it, is passed to the commands that reach the
// baseline here and then dropped, and every later Atelier command that
// reaches the baseline (sync, merge, publish) mints its own. A header
// stored in the checkout would outlive its token, and Git sends a stored
// header for the baseline's URL in place of the one those commands pass
// (Astra's review of t643, finding 1).
//
// Every Git command here runs with every hook off (landingGit), and the
// token goes only to the clone and the notes fetch, which check nothing
// out: the files are checked out afterwards, without it. A Mac whose
// global core.hooksPath is relative, such as .githooks, would otherwise run
// a hook the baseline carries, with the token in its environment (finding 2).
export default async function cloneCommand() {
  const git = landingGit;
  const name = args._[1] ?? die(COMMAND_USAGE.clone);
  if (args._.length > 3) die(COMMAND_USAGE.clone);
  const dir = args._[2] !== undefined ? resolve(String(args._[2])) : join(homedir(), "src", name);

  // Everything that can be refused here is refused before the server is
  // asked for anything and before a folder is made.
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) die(`${dir} is a file; clone writes only into a missing or empty folder`);
    if (readdirSync(dir).length) die(`${dir} is not empty; clone writes only into a missing or empty folder. Name another with atelier clone ${name} DIR`);
  }
  // This Mac registers one checkout per project. Another one is not
  // replaced without --replace, and its folder is never touched.
  const old = cfg.projects?.[name];
  const elsewhere = old?.path && resolve(old.path) !== dir ? old.path : null;
  if (elsewhere && args.replace !== true) {
    die(`${name} is already registered on this Mac at ${elsewhere}; nothing was cloned. To register ${dir} in its place, run atelier clone ${name} ${JSON.stringify(dir)} --replace (${elsewhere} is left as it is)`);
  }
  // The folder that keeps the project's private files (t645), when named.
  let privateHome;
  if (args["private-home"] !== undefined) {
    privateHome = resolve(String(args["private-home"]));
    if (!existsSync(privateHome) || !statSync(privateHome).isDirectory()) die(`--private-home ${privateHome} is not a folder on this Mac; nothing was cloned`);
  }
  apiToken();

  const listed = await call("GET", "/projects", undefined, OWNER);
  const names = Array.isArray(listed) ? listed.map((p) => p.name) : [];
  if (!names.includes(name)) die(`no project named ${name} on ${server()}; nothing was cloned. ${names.length ? `Its projects: ${names.join(", ")}.` : "It has no projects."}`);
  const { project: record } = await call("GET", P(name), undefined, OWNER);
  const base = await call("POST", `${P(name)}/baseline-token`, { scope: "write" }, OWNER);
  const branch = base.defaultBranch;

  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  // A full clone of the branch: no depth, every commit of its history. The
  // remote is named origin whatever clone.defaultRemoteName says, since
  // this command and those after it name it so.
  git(["clone", "--quiet", "--no-checkout", "--origin", "origin", "--branch", branch, base.remote, dir], { cwd: parent, token: base.token });
  // The receipts: the provenance notes each merge pushes to the baseline,
  // which git log shows beside the commits they describe.
  const notes = git(["ls-remote", base.remote, "refs/notes/atelier"], { cwd: dir, token: base.token });
  if (notes) git(["fetch", "--quiet", base.remote, "refs/notes/atelier:refs/notes/atelier"], { cwd: dir, token: base.token });
  // The files, without the token. Artifacts holds Git LFS pointers alone,
  // so they are kept as pointers, as every clone of a baseline keeps them.
  git(["reset", "--quiet", "--hard", "HEAD"], { cwd: dir, env: { GIT_LFS_SKIP_SMUDGE: "1" } });
  git(["config", "--local", "notes.displayRef", "refs/notes/atelier"], { cwd: dir });
  try { installMergeConfig(dir, { git }); } catch (error) { die(error.message); }
  const identity = record?.policy?.commitIdentity;
  if (identity?.name && identity?.email) {
    git(["config", "--local", "user.name", identity.name], { cwd: dir });
    git(["config", "--local", "user.email", identity.email], { cwd: dir });
  }

  // A baseline built from part of the history (init --history-since) starts
  // at a root commit that says so. Here the checkout's history is the
  // baseline's own, so each commit is paired with itself, and merge, sync
  // and status read this checkout as they read the one it was built from.
  const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd: dir });
  const roots = git(["log", "--format=%B", "--max-parents=0", "HEAD"], { cwd: dir });
  const fresh = roots.split("\n").some((line) => line.startsWith(`${FRESH_TRAILER}: `));
  const commits = git(["rev-list", "HEAD"], { cwd: dir }).split("\n").filter(Boolean);
  if (fresh) savePairs(gitDir, name, Object.fromEntries(commits.map((c) => [c, c])));

  const { fresh: _wasFresh, ...kept } = old ?? {};
  cfg.projects ??= {};
  cfg.projects[name] = { ...kept, path: dir, branch, protect: record?.policy?.protected ?? [], ...(fresh ? { fresh: true } : {}), ...(privateHome ? { privateHome } : {}) };
  saveConfig(cfg);
  // The private files this Mac names for the project, linked from the
  // folder that keeps them and ignored by Git here (t645).
  let linked = null;
  try { linked = linkPrivate(dir, cfg.projects[name], { name }); } catch (error) { linked = { said: [`Private files not linked: ${error.message}`] }; }
  // This Mac keeps a copy of the list it read, so the guards hold even when
  // iCloud cannot give it later.
  privateGuardFor(name, { discover: true });

  const head = git(["rev-parse", "HEAD"], { cwd: dir });
  console.log(`${name}: cloned ${branch} @ ${short(head)}, ${commits.length} commit${commits.length === 1 ? "" : "s"}${fresh ? " (the baseline holds part of the project's history)" : ""}, into ${dir}, now this Mac's checkout of ${name}.`);
  if (elsewhere) console.log(`This replaces ${elsewhere} as ${name}'s checkout on this Mac; that folder is left as it is.`);
  console.log(`origin is the baseline; ${notes ? "its receipts are on refs/notes/atelier" : "it holds no receipts yet"}. The checkout keeps no token: Atelier's commands that reach the baseline mint their own.`);
  for (const line of linked.said) console.log(line);
  if (privateHome && !linked.said?.length) console.log(`${name}'s private files are to be kept in ${privateHome}; name them with atelier private add PATH --project ${name}.`);
  console.log(identity?.email ? `Commits here are authored as ${identity.name} <${identity.email}>, as the project's policy names.` : `Warning: ${name}'s policy names no commit identity, so commits here use this Mac's global Git identity; set one with atelier init --commit-name NAME --commit-email EMAIL.`);
}
