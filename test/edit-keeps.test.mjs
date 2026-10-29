// G12 (lessons-to-2.0, S21, row 26): task edits do not destroy. Each test
// starts the real Node server and drives it with the CLI, as the
// orchestrator does, through real criteria reviews. Every credential is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { startServer } from "../src/runtime/server.mjs";

const run = promisify(execFile);
const OWNER = "atl_00112233445566778899aabbccddeeff";
const OPUS = "claude-code/opus-5.5";
const GPT = "codex/gpt-6";
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function world(t, policy = {}) {
  const root = mkdtempSync(join(tmpdir(), "atelier-edit-keeps-"));
  dirs.push(root);
  const secrets = join(root, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  writeFileSync(join(secrets, "ATELIER_TOKEN"), OWNER, { mode: 0o600 });
  const server = await startServer({ env: "staging", dataDir: join(root, "data"), host: "127.0.0.1", secretsDir: secrets });
  t.after(() => server.close());
  // A reviewer claims as its runner does, naming the runner.
  const api = async (method, path, body, actor = "owner") => {
    const runner = actor === "owner" ? {} : { "x-atelier-runner": "home:studio" };
    const res = await fetch(`${server.url}/api${path}`, { method, headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": actor, "x-atelier-acting": OPUS, ...runner }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const config = join(root, "config");
  mkdirSync(config);
  const cli = async (argv) => {
    const env = { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: OWNER, ATELIER_SERVER: server.url, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: OPUS };
    for (const k of ["ATELIER_PROJECT", "ATELIER_ACTOR", "ATELIER_JSON"]) delete env[k];
    try { const { stdout, stderr } = await run(process.execPath, ["cli/atelier.mjs", ...argv, "--project", "demo"], { env, timeout: 60_000 }); return { code: 0, stdout, stderr }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  assert.equal((await api("PUT", "/projects/demo", policy)).status, 200);
  const detail = async (id) => (await api("GET", `/projects/demo/items/${id}`)).body;
  const task = async (body) => (await api("POST", "/projects/demo/items", body)).body.id;
  return { api, cli, detail, task };
}

// A criteria review asked of GPT, claimed and approved through the routes a
// reviewer's runner calls. Returns the brief the claim handed the reviewer.
async function approveCriteria(w, id) {
  const asked = await w.cli(["criteria-review", id, "--reviewer", GPT]);
  assert.equal(asked.code, 0, asked.stderr);
  const claim = await w.api("POST", `/projects/demo/items/${id}/criteria-review-claim`, {}, GPT);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const c = claim.body.review ?? claim.body;
  const verdict = await w.api("POST", `/projects/demo/items/${id}/criteria-review`, { approve: true, rev: c.rev, criteria: c.criteria, request: c.id ?? c.request, note: "observable" }, GPT);
  assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
  return JSON.stringify(claim.body);
}

test("--add-accept appends and leaves the stored criteria alone; the lost approval is stated and, where required, a review of the added criterion is asked by command", async (t) => {
  const w = await world(t, { requireCriteriaReview: true });
  const id = await w.task({ title: "Keeps criteria", accept: ["the list shows every task", "a closed task is grey"] });
  await approveCriteria(w, id);
  assert.equal((await w.detail(id)).criteriaReview.status.approved, true);

  const added = await w.cli(["edit", id, "--add-accept", "the list sorts by id"]);
  assert.equal(added.code, 0, added.stderr);
  assert.deepEqual((await w.detail(id)).item.accept, ["the list shows every task", "a closed task is grey", "the list sorts by id"]);
  assert.match(added.stdout, /Added: 3\. the list sorts by id The criteria before them are unchanged\./);
  assert.match(added.stdout, /The criteria review that approved the old criteria approves nothing now\./);
  assert.match(added.stdout, new RegExp(`ask for one of the added criteria with atelier criteria-review ${id}\\.`));
  assert.doesNotMatch(added.stdout, /Dropped/, "an append drops nothing");

  // The review asked next judges the added criterion: the brief says so.
  const asked = await w.cli(["criteria-review", id, "--reviewer", GPT]);
  assert.equal(asked.code, 0, asked.stderr);
  const claim = await w.api("POST", `/projects/demo/items/${id}/criteria-review-claim`, {}, GPT);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.match(JSON.stringify(claim.body), /Revision 2 only added criterion-3 to revision 1, which a criteria review approved with criterion-1 to criterion-2 as they still stand/);

  // A changed criterion, while that review is claimed: it is withdrawn and the
  // answer says so, names the dropped criteria and the event that keeps them.
  const replaced = await w.cli(["edit", id, "--accept", "the list shows every task", "--accept", "a closed task is hidden"]);
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.match(replaced.stdout, /Criteria review withdrawn: the open review of the old criteria\./);
  assert.match(replaced.stdout, /Dropped criteria: "a closed task is grey", "the list sorts by id"/);
  const seq = Number(/kept on event (\d+): atelier edit t\d+ --restore \1 puts them back/.exec(replaced.stdout)?.[1]);
  assert.ok(seq > 0, replaced.stdout);
  const edited = (await w.detail(id)).events.find((e) => e.seq === seq);
  assert.equal(edited.kind, "item.edited");
  assert.deepEqual(edited.data.acceptWas, ["the list shows every task", "a closed task is grey", "the list sorts by id"]);
  assert.equal(edited.data.acting, OPUS, "the developer-token edit names the acting model");

  const restored = await w.cli(["edit", id, "--restore", String(seq)]);
  assert.equal(restored.code, 0, restored.stderr);
  assert.deepEqual((await w.detail(id)).item.accept, ["the list shows every task", "a closed task is grey", "the list sorts by id"]);
  // A number that is no edit of this task is refused with the next command.
  const wrong = await w.cli(["edit", id, "--restore", "1"]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /no_event: event 1 is not an edit of t\d+/);
  assert.match(wrong.stderr, /\nnext: run atelier show t\d+ --json/);
});

test("a project that does not require criteria reviews asks for none when a criterion is added", async (t) => {
  const w = await world(t);
  const id = await w.task({ title: "No criteria gate", accept: ["one"] });
  const added = await w.cli(["edit", id, "--add-accept", "two"]);
  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stdout, /Added: 2\. two/);
  assert.doesNotMatch(added.stdout, /criteria-review/);
  assert.deepEqual((await w.detail(id)).item.accept, ["one", "two"]);
});

test("--add-brief appends; a replaced brief or scope is named, kept on the event and restored", async (t) => {
  const w = await world(t);
  const id = await w.task({ title: "Brief kept", brief: "Build the list.", scope: ["src/list/**", "test/list/**"] });
  const added = await w.cli(["edit", id, "--add-brief", "Sort it by id."]);
  assert.equal(added.code, 0, added.stderr);
  assert.equal((await w.detail(id)).item.brief, "Build the list.\n\nSort it by id.");

  const replaced = await w.cli(["edit", id, "--brief", "Build the board.", "--scope", "src/board/**"]);
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.match(replaced.stdout, /Dropped scope: src\/list\/\*\*, test\/list\/\*\*/);
  assert.match(replaced.stdout, /Replaced brief: the old text is kept on the edit event\./);
  const seq = Number(/--restore (\d+)/.exec(replaced.stdout)[1]);
  assert.equal((await w.cli(["edit", id, "--restore", String(seq)])).code, 0);
  const item = (await w.detail(id)).item;
  assert.equal(item.brief, "Build the list.\n\nSort it by id.");
  assert.deepEqual(item.scope, ["src/list/**", "test/list/**"]);
});

test("bad_title and bad_field print the limit and the length given", async (t) => {
  const w = await world(t);
  const id = await w.task({ title: "Limits", accept: ["one"] });
  const title = await w.cli(["edit", id, "--title", "x".repeat(95)]);
  assert.equal(title.code, 1);
  assert.match(title.stderr, /bad_title: a title is at most 80 characters and this one is 95/);
  const criterion = await w.cli(["edit", id, "--add-accept", "short", "--add-accept", "y".repeat(340)]);
  assert.equal(criterion.code, 1);
  assert.match(criterion.stderr, /bad_field: each addAccept entry is at most 300 characters; entry 2 is 340/);
  const replace = await w.cli(["edit", id, "--accept", "z".repeat(301)]);
  assert.match(replace.stderr, /each accept entry is at most 300 characters; entry 1 is 301/);
  const many = await w.cli(["edit", id, ...Array.from({ length: 12 }, (_, i) => ["--add-accept", `c${i}`]).flat()]);
  assert.equal(many.code, 1);
  assert.match(many.stderr, /accept holds at most 12 criteria; 1 are stored and 12 were given/);
  assert.deepEqual((await w.detail(id)).item.accept, ["one"], "a refused edit changes nothing");
});
