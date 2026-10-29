#!/usr/bin/env node
// atelier restore: puts a backup back into fresh directories (Atelier 2.0,
// task 12; docs/studio.md, "The monthly restore rehearsal").
//   node cli/restore.mjs --key PRIVATE.pem [--passphrase-file F]
//     (--file BACKUP | --env ENV --secrets DIR [--object KEY])
//     --data NEWDIR --repos NEWDIR [--check]
//   node cli/restore.mjs list --env ENV --secrets DIR
// The backup is the file given, or the object named (default the newest of
// the environment) fetched from R2. It is decrypted with the private key, its
// manifest's sizes, sums and refs checked, and restored into --data and
// --repos, which must be absent or empty. --check then starts a server on
// them, on 127.0.0.1 and a free port, and checks /api/version and every
// project's items and events against the manifest.
import { parseArgs } from "node:util";
import { ENVS } from "../src/backup/config.mjs";
import { listBackups, runRestore } from "../src/backup/restore.mjs";

const usage = "usage: node cli/restore.mjs --key PRIVATE.pem [--passphrase-file F] (--file BACKUP | --env ENV --secrets DIR [--object KEY]) --data NEWDIR --repos NEWDIR [--check]\n       node cli/restore.mjs list --env ENV --secrets DIR";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    key: { type: "string" }, "passphrase-file": { type: "string" }, file: { type: "string" }, env: { type: "string" }, secrets: { type: "string" }, object: { type: "string" },
    data: { type: "string" }, repos: { type: "string" }, work: { type: "string" }, check: { type: "boolean" }, help: { type: "boolean", short: "h" },
  },
});
if (values.help) { console.log(usage); process.exit(0); }
process.umask(0o077);
try {
  if (positionals[0] === "list") {
    if (positionals.length !== 1 || !ENVS.has(values.env ?? "") || !values.secrets) { console.error(usage); process.exit(2); }
    for (const o of await listBackups({ env: values.env, secretsDir: values.secrets })) console.log(`${o.key}  ${o.size} bytes  ${o.lastModified.toISOString()}`);
    process.exit(0);
  }
  if (positionals.length || !values.key || !values.data || !values.repos || (!values.file && (!ENVS.has(values.env ?? "") || !values.secrets))) { console.error(usage); process.exit(2); }
  await runRestore({ env: values.env, file: values.file, object: values.object, secretsDir: values.secrets, keyFile: values.key, passphraseFile: values["passphrase-file"], dataDir: values.data, reposDir: values.repos, check: values.check === true, workDir: values.work });
  process.exit(0);
} catch (error) {
  console.error(`restore failed: ${error.message}`);
  process.exit(1);
}
