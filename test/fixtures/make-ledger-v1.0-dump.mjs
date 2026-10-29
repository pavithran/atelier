#!/usr/bin/env node
// Writes test/fixtures/ledger-v1.0-relic.json: a Ledger dump made by the 1.0
// code (tag v1.0, debb259b), which test/ledger-import-v1.test.mjs imports
// into a 2.0 server (task 10, t405). Run from the repository root:
//
//   node test/fixtures/make-ledger-v1.0-dump.mjs
//
// It takes v1.0's src/ and cli/ from Git into a temporary folder, rewrites
// their TypeScript as plain JavaScript (esbuild; 1.0 used syntax Node's type
// stripping refuses), and runs them over this checkout's Node runtime
// (src/runtime: the SQLite namespace and module hooks, which are not the
// Ledger's code). The 1.0 Ledger then records a project through its own
// methods: a policy, a standing decision, fast mode, tasks merged, claimed
// on an Artifacts fork, submitted, open and abandoned, with evidence,
// reviews and the events each wrote. The dump is read with 1.0's own
// collectDump, as `atelier ledger dump` from a 1.0 CLI writes it. Every
// credential is synthetic. The commits are test/helpers/v1-history.mjs's.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const V1 = "debb259bee600c1b6df47d32c09b80455d1cc71d";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT = join(ROOT, "test", "fixtures", "ledger-v1.0-relic.json");

if (process.argv[2] === "--child") {
  await child(process.argv[3], process.argv[4]);
} else {
  const tree = mkdtempSync(join(tmpdir(), "atelier-v1.0-"));
  try {
    const tar = execFileSync("git", ["archive", V1, "src", "cli", "package.json"], { cwd: ROOT, maxBuffer: 1 << 30 });
    execFileSync("tar", ["-x", "-C", tree], { input: tar });
    for (const f of ["loader.mjs", "workers.mjs", "namespace.mjs", "sql.mjs"]) cpSync(join(ROOT, "src", "runtime", f), join(tree, "src", "runtime", f));
    symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"));
    const { transformSync } = await import(pathToFileURL(join(ROOT, "node_modules", "esbuild", "lib", "main.js")).href);
    const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
    for (const f of walk(join(tree, "src"))) {
      if (f.endsWith(".ts") && !f.endsWith(".d.ts")) writeFileSync(f, transformSync(readFileSync(f, "utf8"), { loader: "ts", format: "esm", target: "es2022" }).code);
    }
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", tree, OUT], { stdio: "inherit" });
    process.exitCode = r.status ?? 1;
  } finally { rmSync(tree, { recursive: true, force: true }); }
}

async function child(tree, out) {
  await import(pathToFileURL(join(tree, "src/runtime/loader.mjs")).href);
  const { Namespace } = await import(pathToFileURL(join(tree, "src/runtime/namespace.mjs")).href);
  const { Ledger } = await import(pathToFileURL(join(tree, "src/ledger.ts")).href);
  const { collectDump } = await import(pathToFileURL(join(tree, "cli/ledger-dump.mjs")).href);
  const { criteriaOf } = await import(pathToFileURL(join(tree, "src/criteria.ts")).href);
  const { makeV1History } = await import(pathToFileURL(join(ROOT, "test/helpers/v1-history.mjs")).href);
  const dir = mkdtempSync(join(tmpdir(), "atelier-v1.0-data-"));
  const c = makeV1History(join(dir, "history"));
  const OWNER = "owner";
  const ns = new Namespace({ dir: join(dir, "data"), Class: Ledger, env: { OWNER_ACTOR: OWNER, DEPLOYED_MAIN: V1 } });
  ns.start();
  const L = ns.get(ns.idFromName("project:relic"));
  const BUILDER = "claude-code/opus-5.5", REVIEWER = "codex/gpt-6-astra";
  const record = {
    name: "relic", repo: "relic", createdAt: "2026-10-01T09:00:00.000Z", branch: "main", title: "Relic",
    policy: { checks: ["npm test"], protected: ["src/**"], proseStandard: "docs/style.md", requireReviews: 1 },
  };
  await L.setProject(record, OWNER);
  await L.recordDecision({ text: "Keep the relic's API stable.", quote: "keep the API stable" }, OWNER);
  await L.setMainHead(c.main, new Date().toISOString()).catch(() => {});

  // A task carried through to merged on Artifacts: claimed on its fork,
  // pushed, checked, reviewed, accepted and merged.
  const claimFork = async (id, actor, fork, base, token) => {
    const { generation, replaces } = await L.claim(id, actor, null, true);
    await L.setFork(id, fork, base, actor, true, generation);
    if (!await L.recordToken(id, actor, generation, replaces, token)) throw new Error(`token for ${id} not recorded`);
  };
  const t1 = await L.newItem("Add a.txt", ["*.txt"], OWNER, { brief: "One file, one line.", accept: ["a.txt holds one line"] });
  await claimFork(t1.id, BUILDER, "relic-t1", c.first, "artifacts-token-t1");
  await L.recordPush(t1.id, BUILDER, c.main, c.main, true);
  await L.addEvidence({ itemId: t1.id, claim: "npm test", grade: "observed", head: c.main, passed: true, by: BUILDER, at: new Date().toISOString(), changedPaths: ["a.txt"] }, undefined, true);
  await L.submit(t1.id, BUILDER, "a.txt added", undefined, true);
  await L.addReview({ itemId: t1.id, by: REVIEWER, head: c.main, approve: true, note: "Fine.", at: new Date().toISOString(), criteria: criteriaOf(await L.item(t1.id)) }, undefined, true);
  await L.accept(t1.id, OWNER, c.main);
  await L.merged(t1.id, OWNER, c.main, true, c.main);

  // A task claimed on an Artifacts fork, its head one commit past main:
  // `atelier migrate` carries it to t/2 on the Studio.
  const t2 = await L.newItem("Add b.txt", ["*.txt"], OWNER, { accept: ["b.txt holds one line"] });
  await claimFork(t2.id, BUILDER, "relic-t2", c.main, "artifacts-token-t2");
  await L.recordPush(t2.id, BUILDER, c.fork, c.fork, true);
  await L.addEvidence({ itemId: t2.id, claim: "npm test", grade: "observed", head: c.fork, passed: true, by: BUILDER, at: new Date().toISOString(), changedPaths: ["b.txt"] }, undefined, true);

  // A task submitted with a rejecting review, an open task and an
  // abandoned one; then fast mode, which the dump carries in meta.
  const t3 = await L.newItem("Rename README", ["README.md"], OWNER);
  await claimFork(t3.id, "codex/gpt-6", "relic-t3", c.main, "artifacts-token-t3");
  await L.recordPush(t3.id, "codex/gpt-6", c.fork, c.fork, true);
  await L.submit(t3.id, "codex/gpt-6", "renamed", undefined, true);
  await L.addReview({ itemId: t3.id, by: "claude-code/opus-5.5", head: c.fork, approve: false, note: "The rename is not in this head.", at: new Date().toISOString(), criteria: criteriaOf(await L.item(t3.id)) }, undefined, true);
  await L.newItem("Write the guide", ["docs/**"], OWNER, { brief: "A short guide to the relic." });
  const t5 = await L.newItem("A path not taken", [], OWNER);
  await L.abandon(t5.id, OWNER, "superseded by t4");
  await L.setMode(OWNER, "fast", "a small project", "claude-code/opus-5.5", "go fast on relic");

  const read = (table, after) => table === undefined ? L.dumpManifest().then((m) => ({ ...m, project: "relic", key: "relic", ledger: "project:relic" })) : L.dumpRows(table, after);
  const dump = await collectDump(read);
  await ns.close();
  writeFileSync(out, `${JSON.stringify({ ...dump, at: "2026-10-28T12:00:00.000Z", commits: c })}\n`);
  rmSync(dir, { recursive: true, force: true });
  const rows = dump.tables.reduce((n, t) => n + t.rows.length, 0);
  console.log(`wrote ${out}: ${dump.tables.length} tables, ${rows} rows, schema version ${dump.schemaVersion}`);
}
