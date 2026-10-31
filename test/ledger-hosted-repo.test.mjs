// Exercise imported records and a restart without opening a server socket.
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import "../src/runtime/loader.mjs";
import { Namespace } from "../src/runtime/namespace.mjs";
import { manifestOf } from "../cli/ledger-dump.mjs";
import { LocalRepos } from "../src/git/local-repos.mjs";
import { makeV1History } from "./helpers/v1-history.mjs";
const { buildStory, QUIET, isAtelier } = await import("../src/graph.ts");
const { buildPulse, pulseFromCounts } = await import("../src/pulse.ts");
const { Ledger } = await import("../src/ledger.ts");
const { default: worker } = await import("../src/index.ts");
const { dumpChecksum, repoName } = await import("../src/rules.ts");
const V1 = JSON.parse(readFileSync(new URL("./fixtures/ledger-v1.0-relic.json", import.meta.url), "utf8"));

async function imported(t, { server = true, moved = false, name = "relic", ledgerRepo = "relic-2" } = {}) {
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
    execFileSync("git", ["clone", "-q", "--bare", bare, join(dir, "repos", "relic-t1.git")]);
  }
  let ns = new Namespace({ dir, Class: Ledger, env });
  env.LEDGER = ns;
  const ledger = () => ns.get(ns.idFromName("project:relic"));
  t.after(async () => { await ns.close(); repos.close(); rmSync(dir, { recursive: true, force: true }); });
  const dump = structuredClone(V1);
  dump.record = { ...dump.record, name, repo: ledgerRepo };
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
  assert.equal((await ledger().project()).repo, ledgerRepo, "reads during import preserve the dump for checksum verification");
  await ledger().importFinish(begun.import);
  const index = () => ns.get(ns.idFromName("__index"));
  await index().registerProject({ ...dump.record, name: "relic", repo: "relic-2" });
  if (name !== "relic") await index().renameProject("relic", name);
  globalThis.caches ??= { default: { match: async () => undefined, put: async () => {} } };
  const request = async (path, method = "GET", body) => worker.fetch(new Request(`http://localhost${path}`, {
    method, headers: { authorization: `Bearer ${env.ATELIER_TOKEN}`, "content-type": "application/json", "x-atelier-actor": "owner", "x-atelier-acting": "codex/gpt-6-astra" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil() {} });
  return {
    ledger,
    index,
    object: (name = "project:relic") => ns.object(name),
    env,
    request,
    restart: async () => {
      await ns.close(); ns = new Namespace({ dir, Class: Ledger, env }); env.LEDGER = ns;
      // The same startup reconciliation startServer runs, without sockets.
      await index().repairHostedProjectRepos();
    },
    api: async (path, method = "GET", body) => request(`/api/projects/relic/${path}`, method, body),
    probes: async (key = "project:relic") => {
      const object = ns.get(ns.idFromName(key));
      const sql = ns.object(key).sql;
      const exec = sql.exec;
      let probes = 0;
      sql.exec = function(query, ...args) {
        if (query.includes("SELECT 1 FROM events WHERE kind = 'project.host_moved'")) probes++;
        return exec.call(this, query, ...args);
      };
      try { await object.project(); await object.project(); } finally { sql.exec = exec; }
      return probes;
    },
    repairs: async () => (await ledger().dumpRows("events")).rows.filter((r) => r[4] === "project.repo_repaired"),
    stored: async () => JSON.parse((await ledger().dumpRows("meta")).rows.find((r) => r[0] === "project")[1]),
  };
}

test("ledger import: a successful move stores the server repository and keeps the project policy", async (t) => {
  const w = await imported(t);
  assert.equal((await w.ledger().project()).repo, "relic-2");
  // The Git binding reports a completed mirror; repository reads below use
  // the real bare repository, so a stale index name still fails.
  Object.assign(w.env.GIT, {
    mirror: async () => ({ branch: "main", before: null, head: V1.commits.main, remoteHead: V1.commits.main, moved: "created", notes: "none", tags: 0 }),
    wayBackOf: () => null,
    readFile: async () => null,
  });
  const move = await w.api("move-host", "POST", { remote: "https://example.test/relic.git" });
  assert.equal(move.status, 200, await move.clone().text());
  await assertIndexedReads(w);
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

test("ledger import: an old move is repaired once at restart, using the stable key after a rename", async (t) => {
  const w = await imported(t, { moved: true, name: "renamed" });
  assert.equal((await w.stored()).repo, "relic-2");
  await w.restart();
  // The index is the first external read after startup reconciliation.
  await assertIndexedReads(w, "renamed");
  assert.equal((await w.stored()).repo, "relic");
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
    assert.equal((await w.index().projects())[0].repo, "relic-2");
    assert.equal((await w.repairs()).length, 0);
  });
}

async function assertIndexedReads(w, name = "relic") {
  const listed = await w.request("/api/projects");
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).find((p) => p.name === name).repo, "relic");
  await w.index().assertRepoAvailable("another", "relic-2");
  await assert.rejects(w.index().assertRepoAvailable("another", "relic"), /repo_taken/);
  // Decisions reads a task diff and Flow reads imported Git history using
  // the index's record. Capture the repository requests because these pages
  // can render 200 even when a Git read was caught as unavailable.
  const reads = [];
  const get = w.env.REPOS.get.bind(w.env.REPOS);
  w.env.REPOS.get = async (repo) => { reads.push(repo); return get(repo); };
  try {
    for (const page of [`/decisions?project=${name}&task=t1`, "/flow"]) {
      reads.length = 0;
      const response = await w.request(page);
      const html = await response.text();
      assert.equal(response.status, 200, html);
      if (page.startsWith("/decisions")) {
        assert.doesNotMatch(html, /The diff could not be read/);
        assert.match(html, /a\.txt/);
      }
      assert.ok(reads.includes("relic"), `${page} reads the hosted repository`);
      assert.ok(!reads.includes("relic-2"), `${page} never reads the old repository`);
    }
  } finally { w.env.REPOS.get = get; }
}

test("ledger import: restart repairs the index even if round 1 already repaired the Ledger", async (t) => {
  const w = await imported(t, { moved: true, ledgerRepo: "relic" });
  await w.restart();
  await assertIndexedReads(w);
  assert.equal((await w.stored()).repo, "relic");
});

test("ledger import: repo repair is quiet platform bookkeeping without the request's acting model", async (t) => {
  const w = await imported(t, { moved: true });
  await w.ledger().actingCall("codex/gpt-6-astra", "project", []);
  // Barrier for the index update kept by the repair's waitUntil.
  assert.equal((await w.index().projects())[0].repo, "relic");
  const [row] = await w.repairs();
  const event = { seq: row[0], itemId: row[1], at: row[2], actor: row[3], kind: row[4], data: JSON.parse(row[5]) };
  assert.equal(event.actor, "atelier/events");
  assert.equal(isAtelier(event.actor), true);
  assert.equal(QUIET.has(event.kind), true);
  assert.equal(Object.hasOwn(event.data, "acting"), false);
  assert.equal(buildStory("relic", [], [event], "owner").tally.agentMoves, 0);
  assert.equal(buildPulse([event], "owner", new Date()).moves, 0);
  // QUIET also excludes repair events written by the previous release.
  const legacy = { ...event, actor: "system" };
  assert.equal(buildStory("relic", [], [legacy], "owner").tally.agentMoves, 0);
  assert.equal(buildPulse([legacy], "owner", new Date()).moves, 0);
  const counts = await w.ledger().showcaseCounts("2000-01-01T00:00:00Z");
  assert.equal(pulseFromCounts({ ...counts, days: counts.days.filter((r) => r.kind === event.kind) }, "owner", new Date()).moves, 0);
});

test("ledger import: a canonical hosted record does not probe move events on each project read", async (t) => {
  const w = await imported(t, { moved: true });
  await w.restart();
  assert.equal(await w.probes(), 0);
  await w.index().setProject({ ...V1.record, repo: "relic-2" }, "owner");
  assert.equal(await w.probes("__index"), 0, "non-project Ledgers skip the events probe too");
});


test("startup repair continues past missing and unavailable Ledgers and a bad key", async (t) => {
  const w = await imported(t, { moved: true });
  for (const name of ["a-missing", "b-unavailable", "c-bad"]) {
    await w.index().registerProject({ ...V1.record, name, repo: `${name}-2` });
  }
  // Simulate a corrupt key already present in the index.
  w.object("__index").db.prepare("UPDATE projects SET json = json_set(json, '$.name', ?) WHERE name = ?").run("///", "c-bad");
  const get = w.env.LEDGER.get.bind(w.env.LEDGER);
  t.mock.method(w.env.LEDGER, "get", (id) => {
    if (id.name === "project:b-unavailable") throw new Error("cannot open ledger");
    return get(id);
  });
  const errors = t.mock.method(console, "error", () => {});
  await w.index().repairHostedProjectRepos();
  assert.equal((await w.stored()).repo, "relic");
  assert.equal((await w.index().projects()).find((p) => p.name === "relic").repo, "relic");
  assert.equal((await w.repairs()).length, 1);
  assert.equal(errors.mock.callCount(), 3);
});

test("a rolled-back move leaves both the Ledger and the index unrepaired", async (t) => {
  const w = await imported(t);
  w.object().db.exec("CREATE TRIGGER refuse_move BEFORE INSERT ON events WHEN NEW.kind = 'project.host_moved' BEGIN SELECT RAISE(ABORT, 'move failed'); END");
  await assert.rejects(w.ledger().hostMoved("owner", "project.host_moved", {}), /move failed/);
  assert.equal((await w.stored()).repo, "relic-2");
  assert.equal((await w.index().projects())[0].repo, "relic-2");
  assert.equal((await w.repairs()).length, 0);
});

test("a failed index update is logged after the move has committed", async (t) => {
  const w = await imported(t);
  const errors = t.mock.method(console, "error", () => {});
  w.object("__index").db.exec("CREATE TRIGGER refuse_update BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT, 'index failed'); END");
  await w.ledger().hostMoved("owner", "project.host_moved", {});
  await w.index().projects();
  // Let the rejected RPC reach the waitUntil catch.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await w.stored()).repo, "relic");
  assert.equal((await w.repairs()).length, 1);
  assert.ok(errors.mock.calls.some((call) => call.arguments[0] === "repository index update failed for relic:"));
});


test("way-back renewal changes only the kept credential and retains a failed push in status until a retry succeeds", async (t) => {
  const f = await imported(t);
  const { GitHost } = await import("../src/git/host.mjs");
  const { formatStatus, formatStatusBrief, statusJson } = await import("../cli/status.mjs");
  const { formatStanding } = await import("../cli/atelier.mjs");
  const dir = process.cwd() + "/.way-back-test-" + process.pid;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = new GitHost({ dataDir: dir, reposDir: join(dir, "repos"), namespace: f.env.LEDGER, settings: {} });
  t.after(() => host.close());
  f.env.GIT = host.binding();
  const L = f.ledger();
  const remote = "/kept/baseline.git";
  host.keepWayBack({ key: "relic", remote, token: "expired-dummy" });
  await L.hostMoved("owner", "project.way_back", { state: "failed", remote, head: "a".repeat(40), detail: "remote: Invalid credential" });
  const command = "atelier projects move-host relic --renew-way-back --token-env VAR";
  const line = await L.wayBackStatus();
  assert.match(line, /unable to push.*aaaaaaaa.*Invalid credential/);
  assert.ok(line.includes(command));
  const views = [{ name: "relic", items: [], inbox: [], wayBack: line }];
  assert.ok(formatStatus(views).includes(command));
  assert.equal(statusJson(views)[0].wayBack, line);
  const standing = await (await f.request("/api/projects/relic/standing")).json();
  assert.equal(standing.wayBack, line);
  assert.ok(formatStanding(standing).includes(command));
  assert.ok(formatStatusBrief({ standing }).includes(command));
  for (const body of [{ renewWayBack: true }, { renewWayBack: true, token: "bad token" }, { renewWayBack: true, token: "fresh", endBake: true }]) {
    assert.equal((await f.request("/api/projects/relic/move-host", "POST", body)).status, 400);
  }
  const agent = await (await f.request("/api/tokens", "POST", { actor: "codex/gpt-6-astra", projects: ["relic"] })).json();
  const denied = await worker.fetch(new Request("http://localhost/api/projects/relic/move-host", {
    method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json", "x-atelier-actor": "codex/gpt-6-astra" },
    body: JSON.stringify({ renewWayBack: true, token: "agent-dummy" }),
  }), f.env, { waitUntil() {} });
  assert.equal(denied.status, 403);
  assert.equal(JSON.parse(readFileSync(join(dir, "way-back", "relic.json"), "utf8")).token, "expired-dummy");
  const before = await L.hostMoveState();
  const response = await f.request("/api/projects/relic/move-host", "POST", { renewWayBack: true, token: "fresh-dummy" });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.equal(answer.renewed, true);
  assert.ok(!JSON.stringify(answer).includes("fresh-dummy"));
  const file = join(dir, "way-back", "relic.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { remote, token: "fresh-dummy" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(await L.hostMoveState(), before);
  assert.equal(await L.wayBackStatus(), line);
  await f.restart();
  assert.equal(await f.ledger().wayBackStatus(), line);
  const { WayBack } = await import("../src/git/move.mjs");
  assert.deepEqual(new WayBack(dir).get("relic"), { remote, token: "fresh-dummy" });
  const events = await f.ledger().events(undefined, 100);
  assert.ok(!JSON.stringify(events).includes("fresh-dummy"));
  await f.ledger().hostMoved("owner", "project.way_back", { state: "pushed", remote });
  assert.equal(await f.ledger().wayBackStatus(), null);
  host.keepWayBack({ key: "relic", remote: null });
  assert.equal((await f.request("/api/projects/relic/move-host", "POST", { renewWayBack: true, token: "fresh" })).status, 409);
});
