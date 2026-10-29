import { gitCommand } from "../git/command.mjs";
// What a nightly backup holds and how it is put back (Atelier 2.0, task 12;
// design section 4.9). A snapshot is a directory:
//
//   manifest.json            what follows, with sizes and SHA-256 sums
//   data/ledgers/*.sqlite    each Ledger, copied by SQLite (VACUUM INTO)
//   data/*.sqlite            the alarm list and the Git grant store, likewise
//   data/large/...           the large objects, files written whole
//   repos/KEY.bundle         `git bundle create --all` of each repository
//
// Order matters for a server under writes. The index (__index.sqlite) is
// copied first, and the ledgers/ folder is listed only after it: a project is
// registered in the index only once its own Ledger exists (the init route
// makes the Ledger, then registers it), so every project the copied index
// registers has a file in the listing, and the backup checks that it does.
// The other databases follow, then the repositories, so a restored Ledger never names a commit its
// repository lacks; a repository may hold commits the Ledger has not yet
// recorded, which the server tolerates as it does a push in flight.
//
// Each Ledger copy is made inside one read transaction of SQLite's
// (VACUUM INTO), so it is the database as it stood at one moment, whatever
// the server writes meanwhile; the files under WAL are never copied raw.
// Every bundle's refs are read back from the bundle itself, so the manifest
// names what the bundle holds even when a push lands while it is made.
//
// Nothing from the secrets directories is copied, and the manifest names
// paths, sizes, sums, refs and counts only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ledgerFile } from "../runtime/ledger-file.mjs";

export const FORMAT = "atelier-backup-1";
const SQLITE = /\.sqlite$/;
const REPO = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git$/;

export async function sha256File(path) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}

function git(args, opts = {}) {
  return execFileSync(gitCommand(), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, ...opts });
}

// A consistent copy of a live SQLite database, through SQLite itself.
function copyDatabase(src, dest) {
  const db = new DatabaseSync(src);
  try {
    db.exec("PRAGMA busy_timeout = 30000");
    db.prepare("VACUUM INTO ?").run(dest);
  } finally { db.close(); }
  chmodSync(dest, 0o600);
}

// Every regular file under dir, relative to it. A link or anything else
// stops the backup: nothing in the data directory should be one.
function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      let st;
      try { st = lstatSync(p); } catch (err) { if (err.code === "ENOENT") continue; throw err; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(relative(dir, p).split(sep).join("/"));
      else throw new Error(`${p} is neither a file nor a directory`);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// The projects an index database registers: [{ name, key }].
export function registeredProjects(indexFile) {
  const db = new DatabaseSync(indexFile, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get()) return [];
    return db.prepare("SELECT name, json FROM projects ORDER BY name").all().map((r) => {
      let rec = {};
      try { rec = JSON.parse(r.json); } catch { /* the name stands */ }
      return { name: r.name, key: typeof rec.key === "string" && rec.key ? rec.key : r.name };
    });
  } finally { db.close(); }
}
export const ledgerFileOf = (key) => ledgerFile(`project:${key}`);

// LocalLarge's file being written, beside its name until renamed over it
// (src/runtime/large.mjs): NAME.PID.RANDOM.tmp.
const LARGE_TMP = /\.\d+\.[a-z0-9]*\.tmp$/;

// Counts of what each project's Ledger holds, read from its copy, so the
// restore can check the restored server answers the same.
function projectCounts(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!has("items") || !has("events")) return null;
    const items = Number(db.prepare("SELECT count(*) AS n FROM items").get().n);
    const ev = db.prepare("SELECT count(*) AS n, coalesce(max(seq), 0) AS last FROM events").get();
    return { items, events: Number(ev.n), lastSeq: Number(ev.last) };
  } finally { db.close(); }
}

// Makes a snapshot of one environment in `out` (a fresh directory). Answers
// the manifest.
export async function makeSnapshot({ dataDir, reposDir, out, env, now = new Date(), log = () => {} }) {
  if (!existsSync(join(dataDir, "ledgers"))) throw new Error(`${dataDir} holds no ledgers/ folder; is it the environment's data directory?`);
  mkdirSync(join(out, "data", "ledgers"), { recursive: true, mode: 0o700 });
  mkdirSync(join(out, "repos"), { recursive: true, mode: 0o700 });
  const files = [];
  const projects = {};
  // 1. The databases: the index first, then the listing of the rest.
  const INDEX = "ledgers/__index.sqlite";
  if (!existsSync(join(dataDir, INDEX))) throw new Error(`${dataDir} has no ${INDEX}; is it the environment's data directory?`);
  copyDatabase(join(dataDir, INDEX), join(out, "data", INDEX));
  const registered = registeredProjects(join(out, "data", INDEX));
  const listed = readdirSync(join(dataDir, "ledgers")).filter((n) => SQLITE.test(n) && n !== "__index.sqlite").sort();
  const missing = registered.filter((p) => !listed.includes(ledgerFileOf(p.key))).map((p) => p.name);
  if (missing.length) throw new Error(`the index registers ${missing.join(", ")}, whose Ledger is not in ${dataDir}/ledgers`);
  const dbs = [
    INDEX,
    ...listed.map((n) => `ledgers/${n}`),
    ...readdirSync(dataDir).filter((n) => SQLITE.test(n) && statSync(join(dataDir, n)).isFile()).sort(),
  ];
  for (const rel of dbs) {
    const dest = join(out, "data", rel);
    if (rel !== INDEX) copyDatabase(join(dataDir, rel), dest);
    files.push({ path: `data/${rel}`, kind: "sqlite", size: statSync(dest).size, sha256: await sha256File(dest) });
    const m = /^ledgers\/project%3A(.+)\.sqlite$/.exec(rel);
    if (m) {
      const counts = projectCounts(dest);
      if (counts) projects[decodeURIComponent(m[1])] = counts;
    }
  }
  log(`copied ${dbs.length} databases`);
  // 2. The large objects: each was written beside its name and renamed over
  //    it (src/runtime/large.mjs), so a plain copy reads it whole.
  //    Its files being written are left out, and a file gone between the
  //    listing and the copy is skipped.
  const large = filesUnder(join(dataDir, "large")).filter((rel) => !LARGE_TMP.test(rel));
  let copiedLarge = 0;
  for (const rel of large) {
    const dest = join(out, "data", "large", ...rel.split("/"));
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    try { copyFileSync(join(dataDir, "large", ...rel.split("/")), dest); } catch (err) { if (err.code === "ENOENT") continue; throw err; }
    copiedLarge++;
    chmodSync(dest, 0o600);
    files.push({ path: `data/large/${rel}`, kind: "large", size: statSync(dest).size, sha256: await sha256File(dest) });
  }
  log(`copied ${copiedLarge} large objects`);
  // 3. The repositories, after the databases.
  const repos = [];
  const names = existsSync(reposDir) ? readdirSync(reposDir).filter((n) => REPO.test(n)).sort() : [];
  for (const name of names) {
    const key = REPO.exec(name)[1];
    const dir = join(reposDir, name);
    if (!existsSync(join(dir, "HEAD"))) continue;
    let head = null;
    try { head = git(["symbolic-ref", "HEAD"], { cwd: dir }).trim(); } catch { /* a detached HEAD: none */ }
    const hasRefs = git(["for-each-ref", "--count=1", "--format=%(refname)"], { cwd: dir }).trim() !== "";
    if (!hasRefs) { repos.push({ key, head, empty: true }); continue; }
    const bundle = join(out, "repos", `${key}.bundle`);
    git(["bundle", "create", "--quiet", bundle, "--all"], { cwd: dir });
    chmodSync(bundle, 0o600);
    const refs = {};
    for (const line of git(["bundle", "list-heads", bundle]).split("\n").filter(Boolean)) {
      const [sha, ref] = line.split(" ");
      if (ref !== "HEAD") refs[ref] = sha;
    }
    repos.push({ key, head, path: `repos/${key}.bundle`, refs, size: statSync(bundle).size, sha256: await sha256File(bundle) });
  }
  log(`bundled ${repos.length} repositories`);
  const manifest = { format: FORMAT, env, createdAt: now.toISOString(), registered, files, repos, projects };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  return manifest;
}

// Reads and checks a snapshot's manifest: the format, and every file it
// names present with its size and sum, and nothing it does not name.
export async function checkSnapshot(dir) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")); } catch { throw new Error("the backup has no readable manifest.json"); }
  if (manifest?.format !== FORMAT || !Array.isArray(manifest.files) || !Array.isArray(manifest.repos)) throw new Error(`the manifest is not ${FORMAT}`);
  const named = new Set(["manifest.json"]);
  const safe = (p) => typeof p === "string" && !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === "" || s === ".");
  for (const f of [...manifest.files, ...manifest.repos.filter((r) => !r.empty)]) {
    if (!safe(f.path) || !(f.path.startsWith("data/") || f.path.startsWith("repos/"))) throw new Error(`the manifest names a path outside the backup: ${String(f.path).slice(0, 80)}`);
    const p = join(dir, ...f.path.split("/"));
    if (!existsSync(p) || statSync(p).size !== f.size) throw new Error(`${f.path} is missing or not ${f.size} bytes`);
    if ((await sha256File(p)) !== f.sha256) throw new Error(`${f.path} does not match its SHA-256 in the manifest`);
    named.add(f.path);
  }
  const extra = filesUnder(dir).filter((p) => !named.has(p));
  if (extra.length) throw new Error(`the backup holds files the manifest does not name: ${extra.slice(0, 3).join(", ")}`);
  return manifest;
}

function emptyOrAbsent(dir) {
  return !existsSync(dir) || (statSync(dir).isDirectory() && readdirSync(dir).length === 0);
}

// Puts a checked snapshot back into a fresh data and repos directory, each
// absent or empty. Every database passes SQLite's integrity check, and every
// repository's refs equal the manifest's.
export async function restoreSnapshot({ from, dataDir, reposDir, log = () => {} }) {
  for (const d of [dataDir, reposDir]) if (!emptyOrAbsent(d)) throw new Error(`${d} is not empty; a restore goes into a fresh directory`);
  const manifest = await checkSnapshot(from);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(reposDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  chmodSync(reposDir, 0o700);
  for (const f of manifest.files) {
    const dest = join(dataDir, ...f.path.split("/").slice(1));
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    copyFileSync(join(from, ...f.path.split("/")), dest);
    chmodSync(dest, 0o600);
    if (f.kind === "sqlite") {
      const db = new DatabaseSync(dest, { readOnly: true });
      try {
        const ok = db.prepare("PRAGMA integrity_check").all().map((r) => Object.values(r)[0]);
        if (ok.length !== 1 || ok[0] !== "ok") throw new Error(`${f.path} fails SQLite's integrity check`);
      } finally { db.close(); }
    }
  }
  // Every project the restored index registers has its Ledger.
  const indexFile = join(dataDir, "ledgers", "__index.sqlite");
  if (!existsSync(indexFile)) throw new Error("the backup holds no index (ledgers/__index.sqlite)");
  const missing = registeredProjects(indexFile).filter((p) => !existsSync(join(dataDir, "ledgers", ledgerFileOf(p.key)))).map((p) => p.name);
  if (missing.length) throw new Error(`the restored index registers ${missing.join(", ")}, whose Ledger the backup lacks`);
  log(`restored ${manifest.files.length} files into ${dataDir}`);
  for (const r of manifest.repos) {
    if (!REPO.test(`${r.key}.git`)) throw new Error(`not a repository name: ${String(r.key).slice(0, 80)}`);
    const dir = join(reposDir, `${r.key}.git`);
    const branch = r.head?.startsWith("refs/heads/") ? r.head.slice("refs/heads/".length) : "main";
    git(["init", "--bare", "--quiet", "--template=", `--initial-branch=${branch}`, dir]);
    if (!r.empty) {
      const bundle = join(from, ...r.path.split("/"));
      git(["bundle", "verify", "--quiet", bundle], { cwd: dir });
      git(["fetch", "--quiet", "--no-write-fetch-head", bundle, "+refs/*:refs/*"], { cwd: dir });
    }
    if (r.head) git(["symbolic-ref", "HEAD", r.head], { cwd: dir });
    const refs = refsOf(dir);
    if (JSON.stringify(refs) !== JSON.stringify(sortedRefs(r.refs ?? {}))) throw new Error(`${r.key}'s restored refs differ from the manifest's`);
  }
  log(`restored ${manifest.repos.length} repositories into ${reposDir}`);
  return manifest;
}

const sortedRefs = (refs) => Object.fromEntries(Object.entries(refs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// A bare repository's refs, { ref: sha }, sorted.
export function refsOf(dir) {
  const refs = {};
  for (const line of git(["for-each-ref", "--format=%(objectname) %(refname)"], { cwd: dir }).split("\n").filter(Boolean)) {
    const [sha, ref] = line.split(" ");
    refs[ref] = sha;
  }
  return sortedRefs(refs);
}
