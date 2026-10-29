// G14 (lessons-to-2.0-2026-10-28.md): moving a project carries its tokens,
// policy, decisions, mode and open tasks. A rename keeps every agent and
// runner token working with no reissue, a runner token limited to the old
// name included; a move to another server (`atelier ledger dump` there,
// `import` here) carries the tokens that reach the project, by hash, with
// its open tasks, decisions, mode and policy under the same ids; and
// `atelier import-tasks` files a project's own docs/TASKS.md and records its
// docs/DECISIONS.md, refusing a line it cannot read and changing nothing when
// run again. Two Node servers, the real CLI. Every credential is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";
import { parseTaskFile } from "../cli/commands/import-tasks.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff00112233";
const ACTING = "claude-code/opus-5.5";
const FIXTURE = new URL("./fixtures/ledger-v1.0-relic.json", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "atelier-project-move-"));
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, HOME: root, NO_COLOR: "1" };
for (const k of Object.keys(env)) if (k.startsWith("ATELIER_")) delete env[k];

// Two servers, A (where the project lives) and B (where it moves).
const servers = {};
const cli = (on, argv) => new Promise((ok) => execFile(process.execPath, [join(process.cwd(), "cli/atelier.mjs"), ...argv], {
  cwd: root, encoding: "utf8", timeout: 60_000,
  env: { ...env, ATELIER_CONFIG_DIR: join(root, `config-${on}`), ATELIER_TOKEN: OWNER, ATELIER_SERVER: servers[on].base, ATELIER_SECRET_STORE: "file", ATELIER_ACTING: ACTING },
}, (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
const api = async (on, method, path, body, token = OWNER, actor = "owner") => {
  const res = await fetch(`${servers[on].base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": actor, ...(token === OWNER ? { "x-atelier-acting": ACTING } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const ledger = (on, key) => servers[on].server.namespace.get(servers[on].server.namespace.idFromName(`project:${key}`));
const index = (on) => servers[on].server.namespace.get(servers[on].server.namespace.idFromName("__index"));
let agent, runner;

before(async () => {
  for (const on of ["a", "b", "c"]) {
    const server = await startServer({ env: "test", dataDir: join(root, `data-${on}`), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER } });
    servers[on] = { server, base: server.url.replace("localhost", "127.0.0.1") };
    assert.equal((await cli(on, ["login", "--server", servers[on].base])).code, 0);
  }
  // relic lives on A, with its 1.x record: tasks, a decision, fast mode.
  const imported = await cli("a", ["ledger", "import", "--file", FIXTURE, "--project", "relic"]);
  assert.equal(imported.code, 0, imported.stderr);
  agent = (await api("a", "POST", "/tokens", { actor: "claude-code/opus-5.5", projects: ["relic"] })).body;
  runner = (await api("a", "POST", "/tokens", { runner: "home:studio", projects: ["relic"] })).body;
  assert.ok(agent.token && runner.token);
});
after(async () => { for (const s of Object.values(servers)) await s.server.close(); });

test("a rename keeps agent and runner tokens working with no reissue; a runner token limited to the old name reaches the project under the new one", async () => {
  const r = await cli("a", ["projects", "rename", "relic", "relic-site", "--project", "relic"]);
  assert.equal(r.code, 0, r.stderr);
  // The agent token, limited to relic, reads and writes relic-site.
  const items = await api("a", "GET", "/projects/relic-site/items", undefined, agent.token, "claude-code/opus-5.5");
  assert.equal(items.status, 200, JSON.stringify(items.body));
  assert.ok(JSON.stringify(items.body).includes("Write the guide"));
  // The runner token, limited to relic, polls relic-site.
  const me = await api("a", "GET", "/runners/me", undefined, runner.token, runner.actor);
  assert.equal(me.status, 200, JSON.stringify(me.body));
  const queue = await api("a", "GET", "/projects/relic-site/decisions", undefined, runner.token, runner.actor);
  assert.equal(queue.status, 200, JSON.stringify(queue.body));
  // No token was reissued: the same ids, the same hashes.
  const listed = (await api("a", "GET", "/tokens")).body;
  assert.deepEqual(listed.filter((t) => [agent.id, runner.id].includes(t.id)).map((t) => t.projects), [["relic"], ["relic"]]);
});

test("a move to another server carries the tokens that reach the project, by hash, with its open tasks, decisions, mode and policy under the same ids", async () => {
  const file = join(root, "relic-site.json");
  const dumped = await cli("a", ["ledger", "dump", "--file", file, "--project", "relic-site"]);
  assert.equal(dumped.code, 0, dumped.stderr);
  const dump = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(dump.names.sort(), ["relic", "relic-site"]);
  assert.deepEqual(dump.tokens.map((t) => t.id).sort(), [agent.id, runner.id].sort());
  assert.doesNotMatch(JSON.stringify(dump), new RegExp(`${agent.token}|${runner.token}`), "no token, only hashes");

  const r = await cli("b", ["ledger", "import", "--file", file, "--project", "relic-site"]);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /2 tokens carried with the project/);
  // The same tokens work on B, limited to the name the project has there.
  const items = await api("b", "GET", "/projects/relic-site/items", undefined, agent.token, "claude-code/opus-5.5");
  assert.equal(items.status, 200, JSON.stringify(items.body));
  const me = await api("b", "GET", "/runners/me", undefined, runner.token, runner.actor);
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.deepEqual(me.body.projects, ["relic-site"], "the former name is the project's name here");
  assert.equal((await api("b", "GET", "/projects/relic-site/decisions", undefined, runner.token, runner.actor)).status, 200);
  const carried = (await index("b").agentTokens()).filter((t) => [agent.id, runner.id].includes(t.id));
  assert.equal(carried.length, 2);
  // Open tasks keep their ids and states; decisions, mode and policy are there.
  const L = ledger("b", "relic-site");
  assert.deepEqual(await Promise.all(["t2", "t3", "t4"].map(async (id) => (await L.item(id)).state)), ["claimed", "submitted", "open"]);
  assert.deepEqual((await L.decisions()).map((d) => d.id), (await ledger("a", "relic").decisions()).map((d) => d.id));
  assert.match(JSON.stringify(await L.decisions()), /Keep the relic's API stable/);
  assert.equal((await api("b", "GET", "/projects/relic-site/mode")).body.mode, "fast");
  assert.deepEqual((await L.project()).policy.checks, ["npm test"]);

  // A server that already holds one of the tokens under another hash
  // refuses the move before anything is loaded.
  await index("c").putAgentToken({ id: agent.id, hash: "f".repeat(64), actor: "claude-code/opus-5.5", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400e3).toISOString() });
  const clash = await cli("c", ["ledger", "import", "--file", file, "--project", "relic-site"]);
  assert.notEqual(clash.code, 0);
  assert.match(clash.stderr, new RegExp(`token_conflict: this server already holds token ${agent.id} under another hash or id`));
  assert.match(clash.stderr, /next: only the developer can: revoke the clashing token/);
  assert.ok(!(await index("c").projects()).some((p) => p.name === "relic-site"));
});

test("import-tasks files a project's own tasks and decisions, refuses a line it cannot read, and changes nothing when run again", async () => {
  const tasks = join(root, "TASKS.md");
  writeFileSync(tasks, [
    "# Tasks", "", "<!-- kept by hand while off Atelier -->",
    "- [ ] Port the search page", "  The old one reads the whole index; page it.", "  Keep the URLs.",
    "- [x] Fix the footer",
    "- [ ] Add a sitemap", "",
  ].join("\n"));
  const decisions = join(root, "DECISIONS.md");
  writeFileSync(decisions, ["# Decisions", "", "- No tracking scripts on any page.", "- Plain URLs: no query strings", "  for content pages.", ""].join("\n"));
  const before = (await ledger("b", "relic-site").items()).length;
  const r = await cli("b", ["import-tasks", tasks, decisions, "--project", "relic-site"]);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /from .*TASKS\.md: 2 tasks filed: t6 \(line 4\), t7 \(line 8\); 0 decisions recorded\./);
  assert.match(r.stdout, /1 finished task was not filed\./);
  assert.match(r.stdout, /from .*DECISIONS\.md: 0 tasks filed; 2 decisions recorded: d\d+ \(line 3\), d\d+ \(line 4\)\./);
  const L = ledger("b", "relic-site");
  const t6 = await L.item("t6");
  assert.equal(t6.title, "Port the search page");
  assert.equal(t6.brief, "The old one reads the whole index; page it. Keep the URLs.");
  assert.equal(t6.state, "open");
  const imported = (await L.dumpRows("events")).rows.map((r) => ({ kind: r[4], data: JSON.parse(r[5]) })).filter((e) => e.kind === "project.imported");
  assert.equal(imported[0].data.acting, ACTING, "the developer token's write names the acting model (G18)");
  assert.match(JSON.stringify(await L.decisions()), /Plain URLs: no query strings for content pages\./);
  const decided = (await L.decisions()).length;

  // Again: nothing changes.
  const again = await cli("b", ["import-tasks", tasks, decisions, "--project", "relic-site"]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /0 tasks filed; 0 decisions recorded\.\n2 entries were imported before and left as they are: t6 \(line 4\), t7 \(line 8\)\./);
  assert.equal((await L.items()).length, before + 2);
  assert.equal((await L.decisions()).length, decided);

  // A line that is no entry refuses the file, naming it, and sends nothing.
  writeFileSync(tasks, ["- [ ] One more task", "Some prose the format does not know.", "- [ ] And another"].join("\n"));
  const bad = await cli("b", ["import-tasks", tasks, "--project", "relic-site"]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /TASKS\.md line 2 is not an entry: "Some prose the format does not know\."/);
  assert.match(bad.stderr, /nothing was imported\.\nnext: fix that line/);
  assert.equal((await L.items()).length, before + 2);
  assert.throws(() => parseTaskFile("  indented with nothing above\n", "X.md"), /X\.md line 1 is not an entry/);
});

test("a token minted between an import's begin and its finish that clashes with a carried one is a token_conflict with a next, and the import stays open", async () => {
  const dump = JSON.parse(readFileSync(join(root, "relic-site.json"), "utf8"));
  const { manifestOf } = await import("../cli/ledger-dump.mjs");
  const url = "/projects/relic-site/ledger/import";
  // Server C refused this dump at begin for its clashing token; with that
  // token revoked and gone, a fresh server D takes the begin.
  const server = await startServer({ env: "test", dataDir: join(root, "data-d"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER } });
  servers.d = { server, base: server.url.replace("localhost", "127.0.0.1") };
  const begun = await api("d", "POST", url, { step: "begin", manifest: manifestOf(dump) });
  assert.equal(begun.status, 201, JSON.stringify(begun.body));
  for (const t of dump.tables) if (t.rows.length) await api("d", "POST", url, { step: "rows", import: begun.body.import, table: t.name, columns: t.columns.map((c) => c.name), rows: t.rows });
  // Meanwhile a token is minted on D under a carried token's id.
  await index("d").putAgentToken({ id: runner.id, hash: "e".repeat(64), actor: "runner/other", runner: "home:other", projects: ["x"], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400e3).toISOString() });
  const finish = await api("d", "POST", url, { step: "finish", import: begun.body.import, tokens: dump.tokens, names: dump.names });
  assert.equal(finish.status, 409, JSON.stringify(finish.body));
  assert.equal(finish.body.error, "token_conflict");
  assert.match(finish.body.detail, new RegExp(`holds token ${runner.id} under another hash or id, minted since the import began`));
  assert.match(finish.body.next, /atelier token revoke ID.*--resume .*--abort/);
  assert.ok(!(await index("d").projects()).some((p) => p.name === "relic-site"), "nothing was registered");
  assert.equal((await api("d", "POST", url, { step: "abort", import: begun.body.import })).status, 200, "the import is still open to abort");
});
