// The settings the backup and restore commands share (Atelier 2.0, task 12):
// where the backups go in R2, how they are named, and how the secrets
// directory is read.
//
// The secrets directory (/Users/atelierd/secrets/backup on the Studio,
// atelierd's, mode 700) holds one file per name, each mode 600:
//   R2_ENDPOINT           https://ACCOUNT.r2.cloudflarestorage.com
//   R2_BUCKET             the bucket's name
//   R2_ACCESS_KEY_ID      an R2 API token's access key id
//   R2_SECRET_ACCESS_KEY  and its secret
//   BACKUP_PUBLIC_KEY     the X25519 public key (PEM) backups are encrypted to
//   R2_PREFIX             optional; default atelier/ENV/
// It is a directory of its own, not the server's secrets/ENV, so the server
// never reads the R2 credentials into its settings.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { S3Client } from "./s3.mjs";

export const KEEP_DAYS = 30;
export const ENVS = new Set(["production", "staging"]);

export function prefixFor(env, secrets = {}) {
  const prefix = secrets.R2_PREFIX ?? `atelier/${env}/`;
  if (!/^[A-Za-z0-9._\-/]+\/$/.test(prefix) || prefix.startsWith("/") || prefix.includes("//")) throw new Error("R2_PREFIX is a path of letters, digits, '.', '_', '-' and '/', ending in '/'");
  return prefix;
}

// The object a backup made at `now` is stored as, and the pattern that
// recognises this command's own objects under a prefix.
export function objectKey(prefix, env, now) {
  return `${prefix}atelier-${env}-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}.backup`;
}
export function ownObject(prefix, env, key) {
  if (typeof key !== "string" || !key.startsWith(prefix)) return null;
  const m = /^atelier-([a-z]+)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.backup$/.exec(key.slice(prefix.length));
  if (!m || m[1] !== env) return null;
  const at = new Date(`${m[2]}-${m[3]}-${m[4]}T${m[5]}:${m[6]}:${m[7]}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

// Reads the named files from a secrets directory. The directory and each
// file must be readable by their owner alone; a value is never printed.
export function readBackupSecrets(dir, required, optional = []) {
  if (!dir) throw new Error("--secrets DIR names the backup's secrets directory");
  const mode = (p) => statSync(p).mode & 0o777;
  let st;
  try { st = statSync(dir); } catch { throw new Error(`no secrets directory at ${dir}`); }
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (mode(dir) & 0o077) throw new Error(`${dir} is open to a group or others; it must be mode 700`);
  const out = {};
  for (const name of [...required, ...optional]) {
    const path = join(dir, name);
    let text;
    try {
      if (mode(path) & 0o077) throw new Error(`${path} is open to a group or others; it must be mode 600`);
      text = readFileSync(path, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") { if (required.includes(name)) throw new Error(`${dir} lacks ${name}`); continue; }
      throw err;
    }
    out[name] = name === "BACKUP_PUBLIC_KEY" ? text : text.trim();
    if (!out[name]) throw new Error(`${path} is empty`);
  }
  return out;
}

export function clientFrom(secrets) {
  return new S3Client({ endpoint: secrets.R2_ENDPOINT, bucket: secrets.R2_BUCKET, accessKeyId: secrets.R2_ACCESS_KEY_ID, secretAccessKey: secrets.R2_SECRET_ACCESS_KEY });
}
export const R2_NAMES = ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
