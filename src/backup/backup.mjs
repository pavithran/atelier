// The nightly backup (Atelier 2.0, task 12; design section 4.9, with R2 in
// place of the home server on PAVI's decision): snapshot, pack, encrypt to
// the public key, upload to R2, then keep 30 days of this environment's own
// objects. Run by cli/backup.mjs as atelierd.
//
// Every full backup stands alone: full bundles every night, so no backup
// needs another to restore, and retention can delete any old one. The
// repositories are small next to R2's prices, so the weekday incrementals of
// the design buy nothing worth a chain.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEEP_DAYS, R2_NAMES, clientFrom, objectKey, ownObject, prefixFor, readBackupSecrets } from "./config.mjs";
import { encryptFile } from "./age.mjs";
import { makeSnapshot, sha256File } from "./snapshot.mjs";

const DAY = 86_400_000;

// Deletes this environment's own backups older than keepDays, judged both by
// the time in the object's name and by R2's LastModified, and never `keep`
// (the one just uploaded). Objects of any other name or prefix are left.
// Answers the keys deleted.
export async function prune(client, { prefix, env, now = new Date(), keepDays = KEEP_DAYS, keep }) {
  const cutoff = now.getTime() - keepDays * DAY;
  const deleted = [];
  for (const o of await client.list(prefix)) {
    const at = ownObject(prefix, env, o.key);
    if (!at || o.key === keep) continue;
    if (at.getTime() >= cutoff || !(o.lastModified.getTime() < cutoff)) continue;
    await client.delete(o.key);
    deleted.push(o.key);
  }
  return deleted;
}

// One backup. Answers { key, bytes, manifest, deleted }.
export async function runBackup({ env, dataDir, reposDir, secretsDir, workDir, now = new Date(), keepDays = KEEP_DAYS, log = console.log, client: given }) {
  const secrets = readBackupSecrets(secretsDir, [...R2_NAMES, "BACKUP_PUBLIC_KEY"], ["R2_PREFIX"]);
  const prefix = prefixFor(env, secrets);
  const client = given ?? clientFrom(secrets);
  const work = mkdtempSync(join(workDir ?? tmpdir(), "atelier-backup-"));
  try {
    const snap = join(work, "snapshot");
    log(`backup of ${env}: data ${dataDir}, repositories ${reposDir}`);
    const manifest = await makeSnapshot({ dataDir, reposDir, out: snap, env, now, log: (m) => log(`  ${m}`) });
    const archive = join(work, "backup.tgz");
    execFileSync("tar", ["-czf", archive, "-C", snap, "manifest.json", "data", "repos"], { stdio: ["ignore", "ignore", "pipe"] });
    rmSync(snap, { recursive: true, force: true });
    const sealed = join(work, "backup.enc");
    await encryptFile(archive, sealed, secrets.BACKUP_PUBLIC_KEY);
    rmSync(archive, { force: true });
    const bytes = statSync(sealed).size;
    const key = objectKey(prefix, env, now);
    await client.put(key, sealed, await sha256File(sealed));
    log(`  uploaded ${bytes} encrypted bytes to ${client.bucket}/${key} at ${new URL(client.origin).host}`);
    const deleted = await prune(client, { prefix, env, now, keepDays, keep: key });
    log(`  kept ${keepDays} days: deleted ${deleted.length} older backup${deleted.length === 1 ? "" : "s"} under ${prefix}${deleted.length ? ` (${deleted.join(", ")})` : ""}`);
    return { key, bytes, manifest, deleted };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
