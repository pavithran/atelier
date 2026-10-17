import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { takenBackNotice } from "../cli/atelier.mjs";

// t391: on t389 the holder's finish was refused with only "this task must be
// live and held by you", after the owner's dispatch had ended its claim. The
// holder's next push or finish now reads that the dispatch took the task back
// (finding: the first version of this notice was never reached by push, whose
// revoked token sent it to the renewal refusal, nor by a runner token's finish).

const cli = resolve("cli/atelier.mjs");
const HOLDER = "deepseek/v4", OTHER = "codex/gpt-6";
const TAKEN = "taken back by the developer's dispatch (atelier dispatch --release)";
// The ledger's detail answers newest first.
const released = (from, note, actor = "owner") => ({ kind: "item.released", actor, data: { from, note } });
const claimed = (actor) => ({ kind: "item.claimed", actor, data: {} });

test("a holder whose claim the developer's dispatch ended is told so", () => {
  const d = { item: { owner: null, state: "open" }, events: [released(HOLDER, TAKEN), claimed(HOLDER)] };
  assert.match(takenBackNotice(d, HOLDER, "t389"), /^t389 was taken back by the developer's dispatch .*no longer yours/);
});

test("only the most recent event that ended this actor's claim counts", () => {
  const open = { owner: null, state: "open" };
  // Taken back, claimed again, released in the ordinary way: no notice.
  assert.equal(takenBackNotice({ item: open, events: [released(HOLDER, "out of time", HOLDER), claimed(HOLDER), released(HOLDER, TAKEN), claimed(HOLDER)] }, HOLDER, "t1"), null);
  // Taken back twice: the latest.
  const twice = takenBackNotice({ item: open, events: [released(HOLDER, `${TAKEN} again`), claimed(HOLDER), released(HOLDER, TAKEN), claimed(HOLDER)] }, HOLDER, "t1");
  assert.match(twice, /taken back by the developer's dispatch \(atelier dispatch --release\) again/);
  // Someone else claimed after the take-back, or it was handed on or abandoned: nothing.
  assert.equal(takenBackNotice({ item: { owner: OTHER }, events: [claimed(OTHER), released(HOLDER, TAKEN)] }, HOLDER, "t1"), null);
  assert.equal(takenBackNotice({ item: { owner: OTHER }, events: [{ kind: "item.handoff", actor: "owner", data: { from: HOLDER, to: OTHER } }, released(HOLDER, TAKEN)] }, HOLDER, "t1"), null);
  assert.equal(takenBackNotice({ item: { owner: null, state: "abandoned" }, events: [{ kind: "item.abandoned", actor: "owner", data: {} }, released(HOLDER, TAKEN)] }, HOLDER, "t1"), null);
  // Still the holder's, or no events: nothing.
  assert.equal(takenBackNotice({ item: { owner: HOLDER }, events: [released(HOLDER, TAKEN)] }, HOLDER, "t1"), null);
  assert.equal(takenBackNotice({ item: { owner: null } }, HOLDER, "t1"), null);
});

// The real commands in a workspace whose claim was taken back, against a
// stand-in server: git answers 401 (the revoked token) and the task read
// answers as the scenario says.
async function workspace(t, { read }) {
  const root = mkdtempSync(join(tmpdir(), "atelier-taken-back-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const http = createServer((req, res) => {
    req.resume();
    const send = (status, data, type = "application/json") => { res.writeHead(status, { "content-type": type }); res.end(typeof data === "string" ? data : JSON.stringify(data)); };
    if (req.url.startsWith("/git/")) return send(401, "Invalid or expired token", "text/plain");
    if (req.method === "GET" && /\/items\/t389$/.test(req.url)) return read(send);
    return send(200, {});
  });
  t.after(() => http.close());
  await new Promise((done, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", done); });
  const origin = `http://127.0.0.1:${http.address().port}`;
  const dir = join(root, "ws");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x.test" };
  writeFileSync(join(root, "gitconfig"), "");
  const git = (...a) => execFileSync("git", a, { cwd: dir, env, encoding: "utf8" });
  execFileSync("git", ["init", "-q", "-b", "task", dir], { env });
  writeFileSync(join(dir, "f"), "x");
  git("add", "."); git("commit", "-qm", "work");
  git("remote", "add", "origin", `${origin}/git/fork.git`);
  for (const [k, v] of [["project", "demo"], ["item", "t389"], ["actor", HOLDER], ["branch", "task"]]) git("config", `atelier.${k}`, v);
  const run = (argv) => new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd: dir, env: { ...env, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "plain-token", ATELIER_SERVER: origin, ATELIER_ACTOR: HOLDER } });
    let output = "";
    child.stdout.on("data", (s) => (output += s));
    child.stderr.on("data", (s) => (output += s));
    child.on("close", (status) => done({ status, output }));
  });
  return { run };
}

const takenBack = (send) => send(200, { item: { id: "t389", state: "open", owner: null }, policy: {}, events: [released(HOLDER, TAKEN), claimed(HOLDER)] });
const forbidden = (send) => send(403, { error: "runner_forbidden", detail: "this runner no longer holds t389" });

for (const command of ["push", "finish"]) {
  test(`atelier ${command} after the dispatch took the task back says so, not a token refusal`, async (t) => {
    const f = await workspace(t, { read: takenBack });
    const r = await f.run([command, "t389", "--project", "demo", ...(command === "finish" ? ["--summary", "done"] : [])]);
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /t389 was taken back by the developer's dispatch/);
    assert.doesNotMatch(r.output, /token as expired|must be live and held/);
  });

  test(`atelier ${command} by a runner whose job was dropped says the workspace no longer holds the task`, async (t) => {
    const f = await workspace(t, { read: forbidden });
    const r = await f.run([command, "t389", "--project", "demo", ...(command === "finish" ? ["--summary", "done"] : [])]);
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /this workspace no longer holds t389 \(it may have been taken back by the developer's dispatch\): run atelier show t389/);
    assert.doesNotMatch(r.output, /runner_forbidden|Renewing it failed/);
  });
}
