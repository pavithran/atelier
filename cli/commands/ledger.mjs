// atelier ledger. Its forms, flags and help are declared in src/usage/commands/ledger.ts.
import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { LEDGER_DUMP_FORMAT } from "../../src/rules.ts";
import { COMMAND_USAGE } from "../help.mjs";
import { collectDump, importDump, parseDump } from "../ledger-dump.mjs";
import { OWNER, P, args, call, die, project, server } from "../atelier.mjs";

// The developer's way back from a switch of the server (t342):
// docs/orchestrating.md, "Before a switch of the server", says when to run each.
export default async function ledgerCommand() {
  const [, sub] = args._;
  const takes = { bookmark: [], restore: ["bookmark"], dump: ["file"], import: ["file"] }[sub];
  if (!takes || args._.length !== 2) die(COMMAND_USAGE.ledger);
  for (const flag of ["bookmark", "file"]) if (args[flag] !== undefined && !takes.includes(flag)) die(`atelier ledger ${sub} does not take --${flag}`);
  const name = project();
  const path = `${P(name)}/ledger`;

  if (sub === "bookmark") {
    const b = await call("POST", `${path}/bookmark`, {}, OWNER);
    console.log(formatBookmark(b));
    return;
  }
  if (sub === "restore") {
    if (typeof args.bookmark !== "string" || !args.bookmark.trim()) die(`name the bookmark to restore: atelier ledger restore --bookmark ID --project ${name}`);
    await restoreLedger(name, path, args.bookmark.trim(), new URL(server()).host);
    return;
  }
  if (sub === "dump") {
    const file = typeof args.file === "string" && args.file ? args.file : `ledger-${name}-${new Date().toISOString().slice(0, 10)}.json`;
    let dump;
    try {
      dump = await collectDump((table, after) => call("GET", table === undefined ? `${path}/dump` : `${path}/dump?table=${encodeURIComponent(table)}&after=${after}`, undefined, OWNER));
    } catch (error) { die(`${name}: ${error.message}. Nothing was written`); }
    try { writeFileSync(file, JSON.stringify(dump), { flag: "wx", mode: 0o600 }); } catch (error) {
      die(error.code === "EEXIST" ? `${file} exists; name another with --file. Nothing was written` : `could not write ${file}: ${error.message}`);
    }
    console.log(formatDump(dump, file));
    return;
  }
  if (typeof args.file !== "string" || !args.file) die(`name the dump to load: atelier ledger import --file F --project ${name}`);
  let dump;
  try { dump = parseDump(readFileSync(args.file, "utf8"), LEDGER_DUMP_FORMAT); } catch (error) { die(`${args.file}: ${error.message}`); }
  const done = await importDump(dump, (body) => call("POST", `${path}/import`, body, OWNER));
  console.log(formatImport(dump, done, name));
}

// Names the server and waits for its name to be typed back. The index is
// every project's, so a restore sent to the wrong server (ATELIER_SERVER
// unset, say) rolls back the wrong one's registrations, tokens and pool.
export async function restoreLedger(name, path, bookmark, host, io = {}) {
  await confirmRestore(host, name, bookmark, io);
  const r = await (io.call ?? call)("POST", `${path}/restore`, { bookmark, server: host }, OWNER);
  (io.log ?? console.log)(formatRestore(r));
}

// `io` stands in for the terminal and the failure exit in tests.
export async function confirmRestore(host, name, bookmark, { input = process.stdin, output = process.stdout, fail = die } = {}) {
  const prompt = `Restoring ${name} to ${bookmark} on ${host} also rolls back the index, which is every project's, on ${host}.\nType the server's name (${host}) to go on: `;
  if (!input.isTTY) return fail(`restore asks for confirmation in a terminal; ${prompt.split("\n")[0]}`);
  const rl = createInterface({ input, output });
  try {
    if ((await rl.question(prompt)).trim() !== host) fail("not confirmed; nothing was restored");
  } finally { rl.close(); }
}

const rowsOf = (counts) => Object.values(counts).reduce((n, c) => n + c, 0);

export function formatBookmark(b) {
  const width = Math.max(...b.ledgers.map((l) => l.name.length));
  return [
    `${b.project}: bookmark ${b.id} recorded at ${b.at} on ${b.server}:`,
    ...b.ledgers.map((l) => `  ${l.name.padEnd(width)}  ${l.bookmark}`),
    `Restore them with: atelier ledger restore --bookmark ${b.id} --project ${b.project}`,
    "Cloudflare keeps a Ledger's history for 30 days; a bookmark older than that cannot be restored.",
  ].join("\n");
}

export function formatRestore(r) {
  return [
    `${r.project}: restoring on ${r.server} to bookmark ${r.bookmark}, recorded at ${r.recordedAt}.`,
    ...r.restoring.map((l) => `  ${l.name} restores to ${l.bookmark} on its next start, which it was asked to make once idle.`),
    "The index is every project's: what it holds (registrations, tokens, the pool) returns to that time for all of them.",
    `To undo this restore: atelier ledger restore --bookmark ${r.undo} --project ${r.project}`,
  ].join("\n");
}

export function formatDump(dump, file) {
  const rows = dump.tables.reduce((n, t) => n + t.rows.length, 0);
  return [
    `${dump.project}: wrote ${dump.tables.length} tables, ${rows} rows, to ${file}.`,
    `Schema version ${dump.schemaVersion}, written by ${dump.deployed ? dump.deployed.slice(0, 12) : "an unnamed build"}.`,
    ...(dump.redacted ? [`${dump.redacted} token${dump.redacted === 1 ? "" : "s"} pasted into text ${dump.redacted === 1 ? "was" : "were"} replaced with [redacted].`] : []),
  ].join("\n");
}

export function formatImport(dump, done, name) {
  const want = dump.tables.reduce((n, t) => n + t.rows.length, 0);
  return [
    `${name}: imported ${want} rows of ${dump.tables.length} tables from the dump of ${dump.project} (schema version ${dump.schemaVersion}); the Ledger now holds ${rowsOf(done.counts)} rows.`,
    ...(done.registered ? [`${name} was not registered on this server and is now.`] : []),
  ].join("\n");
}
