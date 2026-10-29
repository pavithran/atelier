// The restore (Atelier 2.0, task 12): a backup, from R2 or a file, is
// decrypted with the private key, its archive and manifest checked, and put
// back into a fresh data and repos directory. With `check`, a server is
// started on the restored directories, on the loopback address and a free
// port with a one-off owner token, and must answer /api/version and give
// each project the items and events the manifest counted.
//
// It writes nowhere but its work directory and the two fresh directories it
// names before its first write, so removing those two undoes it.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { R2_NAMES, clientFrom, ownObject, prefixFor, readBackupSecrets } from "./config.mjs";
import { decryptFile, parseIdentity } from "./age.mjs";
import { registeredProjects, restoreSnapshot } from "./snapshot.mjs";

// The archive holds plain files and directories under manifest.json, data/
// and repos/, and nothing that names a path outside itself.
function checkArchive(archive) {
  const long = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\n").filter(Boolean);
  const names = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\n").filter(Boolean);
  if (!names.length || long.length !== names.length) throw new Error("the archive cannot be listed");
  if (long.some((l) => l[0] !== "-" && l[0] !== "d")) throw new Error("the archive holds something other than files and directories");
  for (const n of names) {
    const p = n.replace(/^\.\//, "");
    if (n.startsWith("/") || p.split("/").includes("..") || !/^(manifest\.json|data(\/.*)?|repos(\/.*)?)$/.test(p)) throw new Error(`the archive names ${n.slice(0, 80)}, outside a backup's layout`);
  }
}

// The newest of this environment's backups in R2, or the one named.
async function pick(client, prefix, env, object) {
  if (object) {
    if (!ownObject(prefix, env, object)) throw new Error(`${object} is not a ${env} backup under ${prefix}`);
    return object;
  }
  const own = (await client.list(prefix)).filter((o) => ownObject(prefix, env, o.key)).sort((a, b) => (a.key < b.key ? -1 : 1));
  if (!own.length) throw new Error(`no ${env} backup under ${prefix} in ${client.bucket}`);
  return own[own.length - 1].key;
}

export async function listBackups({ env, secretsDir }) {
  const secrets = readBackupSecrets(secretsDir, R2_NAMES, ["R2_PREFIX"]);
  const prefix = prefixFor(env, secrets);
  const client = clientFrom(secrets);
  return (await client.list(prefix)).filter((o) => ownObject(prefix, env, o.key));
}

// Starts a server on the restored directories and checks it against the
// manifest. Answers { version, projects: { KEY: { items, events } } }.
export async function checkRestored({ dataDir, reposDir, manifest, log = () => {} }) {
  const { startServer, SETTINGS } = await import("../runtime/server.mjs");
  const token = `atl_${randomBytes(32).toString("hex")}`;
  // No setting from the shell reaches the check server, no notification or
  // secret of the live one: only the one-off owner token, and the defaults
  // for its own origin.
  const keep = new Set(["PUBLIC_ORIGIN", "AI_GATEWAY_ID", "DEPLOYED_MAIN"]);
  const vars = Object.fromEntries(SETTINGS.filter((n) => !keep.has(n)).map((n) => [n, undefined]));
  vars.ATELIER_TOKEN = token;
  const server = await startServer({ env: manifest.env === "production" ? "production" : "staging", dataDir, reposDir, host: "127.0.0.1", port: 0, vars });
  try {
    const get = async (path) => {
      const r = await fetch(`${server.url}${path}`, { headers: { authorization: `Bearer ${token}`, "x-atelier-actor": "owner" } });
      if (r.status !== 200) throw new Error(`the restored server answered ${r.status} to GET ${path}`);
      return r.json();
    };
    const version = await get("/api/version");
    log(`  the restored server answers /api/version`);
    const projects = {};
    // Every project the restored index registers, each answered by name and
    // matched with the counts the backup took from its Ledger.
    for (const { name, key } of registeredProjects(join(dataDir, "ledgers", "__index.sqlite"))) {
      const want = manifest.projects?.[key];
      if (!want) throw new Error(`the restored index registers ${name}, which the backup counted nothing for`);
      const p = await get(`/api/projects/${encodeURIComponent(name)}`);
      let events = 0, last = 0, before = null;
      for (;;) {
        const page = await get(`/api/projects/${encodeURIComponent(name)}/events${before === null ? "" : `?before=${before}`}`);
        events += page.events.length;
        if (!last && page.events.length) last = page.events[0].seq;
        if (page.next === null || page.next === undefined) break;
        before = page.next;
      }
      if (p.items.length !== want.items || events !== want.events || last !== want.lastSeq) {
        throw new Error(`${name} on the restored server holds ${p.items.length} items and ${events} events to #${last}; the backup counted ${want.items} and ${want.events} to #${want.lastSeq}`);
      }
      projects[name] = { items: p.items.length, events };
      log(`  ${name}: ${p.items.length} items, ${events} events, as the backup counted`);
    }
    return { version, projects };
  } finally { await server.close(); }
}

// One restore. `file` is a local backup, or `object` (default the newest)
// is fetched from R2 with the secrets in secretsDir.
export async function runRestore({ env, file, object, secretsDir, keyFile, dataDir, reposDir, check = false, workDir, log = console.log }) {
  if (!keyFile) throw new Error("--key FILE names the age identity file");
  const identity = parseIdentity(readFileSync(keyFile, "utf8"));
  const data = resolve(dataDir), repos = resolve(reposDir);
  const work = mkdtempSync(join(workDir ?? tmpdir(), "atelier-restore-"));
  try {
    let sealed = file ? resolve(file) : null;
    if (!sealed) {
      if (!env) throw new Error("--env names whose backup to fetch from R2");
      const secrets = readBackupSecrets(secretsDir, R2_NAMES, ["R2_PREFIX"]);
      const prefix = prefixFor(env, secrets);
      const client = clientFrom(secrets);
      const key = await pick(client, prefix, env, object);
      sealed = join(work, "backup.enc");
      await client.get(key, sealed);
      log(`fetched ${client.bucket}/${key} from ${new URL(client.origin).host}`);
    }
    const archive = join(work, "backup.tgz");
    await decryptFile(sealed, archive, identity);
    checkArchive(archive);
    const snap = join(work, "snapshot");
    mkdirSync(snap, { mode: 0o700 });
    execFileSync("tar", ["-xzf", archive, "-C", snap], { stdio: ["ignore", "ignore", "pipe"] });
    log(`restoring into ${data} and ${repos}, fresh directories: removing both undoes this restore`);
    const manifest = await restoreSnapshot({ from: snap, dataDir: data, reposDir: repos, log: (m) => log(`  ${m}`) });
    log(`restored the ${manifest.env} backup made at ${manifest.createdAt}: ${manifest.files.length} files, ${manifest.repos.length} repositories, the manifest's sums and refs checked`);
    const checked = check ? await checkRestored({ dataDir: data, reposDir: repos, manifest, log }) : null;
    return { manifest, checked };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
