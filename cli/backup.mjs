#!/usr/bin/env node
// atelier backup: one nightly backup of an environment to R2 (Atelier 2.0,
// task 12; design section 4.9; docs/studio.md). Run as atelierd by the
// LaunchDaemon zone.atelier.backup.ENV at 03:00:
//   node cli/backup.mjs --env production|staging --data DIR --repos DIR
//     --secrets DIR [--work DIR] [--keep-days N]
// --data and --repos are the environment's, as serve.mjs is given them;
// --secrets the backup's own directory (src/backup/config.mjs names its
// files). The Ledgers are copied through SQLite while the server runs, the
// repositories bundled, the large objects copied, all packed with a manifest
// of sizes and SHA-256 sums, encrypted to the public key, uploaded, and
// backups of this environment older than --keep-days (30) deleted.
// Prints what it acted on; never a secret.
//   node cli/backup.mjs keygen --out DIR
// makes a key pair, DIR/backup.key (the private key, for PAVI alone, never
// the Studio) and DIR/backup.pub.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runBackup } from "../src/backup/backup.mjs";
import { ENVS, KEEP_DAYS } from "../src/backup/config.mjs";
import { generateKeys } from "../src/backup/envelope.mjs";

const usage = "usage: node cli/backup.mjs --env production|staging --data DIR --repos DIR --secrets DIR [--work DIR] [--keep-days N]\n       node cli/backup.mjs keygen --out DIR";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { env: { type: "string" }, data: { type: "string" }, repos: { type: "string" }, secrets: { type: "string" }, work: { type: "string" }, "keep-days": { type: "string" }, out: { type: "string" }, help: { type: "boolean", short: "h" } },
});
if (values.help) { console.log(usage); process.exit(0); }
process.umask(0o077);

if (positionals[0] === "keygen") {
  if (!values.out || positionals.length !== 1) { console.error(usage); process.exit(2); }
  const priv = join(values.out, "backup.key"), pub = join(values.out, "backup.pub");
  if (existsSync(priv) || existsSync(pub)) { console.error(`${values.out} already holds backup.key or backup.pub; nothing was written`); process.exit(1); }
  mkdirSync(values.out, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeys();
  writeFileSync(priv, privateKey, { mode: 0o600, flag: "wx" });
  writeFileSync(pub, publicKey, { mode: 0o644, flag: "wx" });
  console.log(`wrote ${priv} (the private key: keep it off the Studio, where only you can read it) and ${pub} (for setup-backup.sh)`);
  process.exit(0);
}

if (positionals.length || !ENVS.has(values.env ?? "") || !values.data || !values.repos || !values.secrets) { console.error(usage); process.exit(2); }
const keepDays = values["keep-days"] === undefined ? KEEP_DAYS : Number(values["keep-days"]);
if (!Number.isInteger(keepDays) || keepDays < 1) { console.error(`--keep-days is a whole number of days, not ${values["keep-days"]}`); process.exit(2); }
try {
  await runBackup({ env: values.env, dataDir: values.data, reposDir: values.repos, secretsDir: values.secrets, workDir: values.work, keepDays, log: (m) => console.log(`${new Date().toISOString()} ${m}`) });
} catch (error) {
  console.error(`${new Date().toISOString()} backup of ${values.env} failed: ${error.message}`);
  process.exit(1);
}
