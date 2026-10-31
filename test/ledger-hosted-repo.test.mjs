// Exercise imported records and a restart without opening a server socket.
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import "../src/runtime/loader.mjs";
import { Namespace } from "../src/runtime/namespace.mjs";
import { manifestOf } from "../cli/ledger-dump.mjs";
import { LocalRepos } from "../src/git/local-repos.mjs";
import { makeV1History } from "./helpers/v1-history.mjs";
const { Ledger } = await import("../src/ledger.ts");
const { default: worker } = await import("../src/index.ts");
const { dumpChecksum, repoName } = await import("../src/rules.ts");
const V1 = JSON.parse(readFileSync(new URL("./fixtures/ledger-v1.0-relic.json", import.meta.url), "utf8"));

async function imported(t, { server = true, moved = false, name = "relic" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-hosted-repo-"));
  const env = server ? { GIT: {} } : {};
  const repos = new LocalRepos({ reposDir: join(dir, "repos") });
  Object.assign(env, { REPOS: repos, ATELIER_TOKEN: "atl_00112233445566778899aabbccddeeff00112233", PUBLIC_ORIGIN: "http://localhost" });
  if (server) {
    const history = join(dir, "history");
    makeV1History(history);
    const bare = join(dir, "repos", "relic.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    execFileSync("git", ["-C", history, "push", "-q", bare, "main:refs/heads/main"]);
  }
  let ns = new Namespace({ dir, Class: Ledger, env });
  env.LEDGER = ns;
  const ledger = () => ns.get(ns.idFromName("project:relic"));
  t.after(async () => { await ns.close(); repos.close(); rmSync(dir, { recursive: true, force: true }); });
  const dump = structuredClone(V1);
  dump.record = { ...dump.record, name, repo: "relic-2" };
  dump.tables.find((table) => table.name === "meta").rows.find((row) => row[0] === "project")[1] = JSON.stringify(dump.record);
  if (moved) {
    const events = dump.tables.find((table) => table.name === "events");
    const event = { seq: 100, item_id: null, at: new Date().toISOString(), actor: "owner", kind: "project.host_moved", data: JSON.stringify({ head: V1.commits.main }) };
    events.rows.push(events.columns.map((c) => event[c.name] ?? null));
    dump.sequences.find((s) => s.name === "events").seq = 100;
  }
  for (const table of dump.tables) {
    const sum = dumpChecksum();
    for (const row of table.rows) sum.add(row);
    table.checksum = sum.value();
  }
  const begun = await ledger().importBegin(manifestOf(dump), "hosted-repo");
  for (const table of dump.tables) if (table.rows.length) await ledger().importRows(begun.import, table.name, table.columns.map((c) => c.name), table.rows);
  assert.equal((await ledger().project()).repo, "relic-2", "reads during import preserve the dump for checksum verification");
  await ledger().importFinish(begun.import);
  return {
    ledger,
    restart: async () => { await ns.close(); ns = new Namespace({ dir, Class: Ledger, env }); env.LEDGER = ns; },
    api: async (path, method = "GET") => worker.fetch(new Request(`http://localhost/api/projects/relic/${path}`, {
      method, headers: { authorization: `Bearer ${env.ATELIER_TOKEN}`, "x-atelier-actor": "owner", "x-atelier-acting": "codex/gpt-6-astra" },
    }), env, { waitUntil() {} }),
    repairs: async () => (await ledger().dumpRows("events")).rows.filter((r) => r[4] === "project.repo_repaired"),
    stored: async () => JSON.parse((await ledger().dumpRows("meta")).rows.find((r) => r[0] === "project")[1]),
  };
}

test("ledger import: a successful move stores the server repository and keeps the project policy", async (t) => {
  const w = await imported(t);
  assert.equal((await w.ledger().project()).repo, "relic-2");
  await w.ledger().hostMoved("owner", "project.host_moved", { head: V1.commits.main }, V1.commits.main);
  assert.equal((await w.stored()).repo, repoName("relic"));
  const baseline = await w.api("baseline-head");
  assert.equal(baseline.status, 200, await baseline.clone().text());
  assert.equal((await baseline.json()).head, V1.commits.main);
  assert.equal((await w.api("refreshes", "POST")).status, 200);
  assert.equal((await w.api("refreshes")).status, 200);
  assert.deepEqual((await w.stored()).policy, V1.record.policy);
  assert.equal((await w.repairs()).length, 1);
  await w.restart();
  assert.equal((await w.ledger().project()).repo, "relic");
  assert.equal((await w.repairs()).length, 1);
});

test("ledger import: an old move is repaired once on first read after restart, using the stable key after a rename", async (t) => {
  const w = await imported(t, { moved: true, name: "renamed" });
  assert.equal((await w.stored()).repo, "relic-2");
  await w.restart();
  const baseline = await w.api("baseline-head");
  assert.equal(baseline.status, 200, await baseline.clone().text());
  assert.equal((await baseline.json()).head, V1.commits.main);
  assert.equal((await w.ledger().project()).repo, repoName("relic"));
  assert.equal((await w.stored()).repo, "relic");
  await w.ledger().project();
  await w.restart();
  await w.ledger().project();
  const repairs = await w.repairs();
  assert.equal(repairs.length, 1);
  assert.deepEqual(JSON.parse(repairs[0][5]), { key: "relic", before: "relic-2", repo: "relic" });
});

for (const options of [{ server: true, moved: false }, { server: false, moved: true }]) {
  test(`ledger import: repo stays unchanged with server=${options.server}, moved=${options.moved}`, async (t) => {
    const w = await imported(t, options);
    await w.restart();
    assert.equal((await w.ledger().project()).repo, "relic-2");
    assert.equal((await w.stored()).repo, "relic-2");
    assert.equal((await w.repairs()).length, 0);
  });
}
