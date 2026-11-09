// t592: a failed ship step prints its last output lines and saves its whole
// output, redacted, in the ship state folder. Each test runs ship() from
// cli/ship.mjs with the real runner; only the server and git are stood in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileDeployStore, ship } from "../cli/ship.mjs";
import { redact } from "../cli/atelier.mjs";

const head = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";

function setup(t, deploy) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-ship-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs/atelier"), { recursive: true });
  writeFileSync(join(dir, "docs/atelier/ship.json"), JSON.stringify({ schema_version: 1, kind: "atelier.ship", class: "web", push: false, deploy, "verify-deploy": { run: ["true"] } }));
  const logDir = join(dir, "state");
  mkdirSync(logDir);
  return { dir, logDir };
}

// Runs the ship; returns what it printed and how it ended.
async function runShip({ dir, logDir }, extra = {}) {
  const lines = []; let ended = null;
  const git = (args) => args[0] === "branch" ? "main" : args[0] === "rev-parse" ? head : "";
  const request = async (method, path) => {
    if (path.endsWith("/actions") && method === "GET") return { approvals: [{ id: "a1", kind: "deploy", commit: head, by: "owner", at: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString() }] };
    if (path.endsWith("/consume")) return { id: "a1" };
    return {};
  };
  await ship({
    name: "p", cwd: dir, branch: "main", git, request, print: (l) => lines.push(l), fail: (m) => { ended = m; throw new Error(m); },
    inProgress: () => [], baselineHead: head, paired: () => head, stage() {}, wrap: async () => ({ status: 0 }), deployed: async () => {}, env: process.env, secrets: [], redact, logDir, ...extra,
  }).catch((error) => { if (error.message !== ended) throw error; });
  return { out: lines.join("\n"), ended };
}

const logs = (logDir) => readdirSync(logDir).filter((f) => f.endsWith(".log")).sort();

test("a step that echoes then exits 1 prints its last 40 lines and names the file holding all of its output", async (t) => {
  const s = setup(t, { run: ["/bin/sh", "-c", "i=1; while [ $i -le 60 ]; do echo line$i; i=$((i+1)); done; echo oops >&2; exit 1"] });
  const r = await runShip(s);
  assert.match(r.ended, /ship stopped at deploy: .* exited 1/);
  const [file] = logs(s.logDir);
  assert.match(file, /^s-[a-z0-9]+-deploy\.log$/);
  assert.match(r.out, new RegExp(`deploy: full output saved to ${join(s.logDir, file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const shown = r.out.split("last 40 lines of its output:\n")[1].split("\ndeploy: full output")[0].split("\n");
  assert.equal(shown.length, 40);
  assert.equal(shown.at(-1), "oops");
  assert.ok(!shown.includes("line10"));
  const saved = readFileSync(join(s.logDir, file), "utf8");
  assert.match(saved, /^line1\n/);
  assert.match(saved, /line60\noops\n$/);
});

test("the saved file and printed lines are cut of the secrets ship redacts, and of nothing else", async (t) => {
  const s = setup(t, { run: ["/bin/sh", "-c", 'echo "given=$GIVEN env=$MY_API_TOKEN short=$MY_KEY plain=hello-world-123"; exit 1'] });
  process.env.MY_API_TOKEN = "env-secret-value-1234"; process.env.MY_KEY = "short"; process.env.GIVEN = "given-secret-9876";
  t.after(() => { delete process.env.MY_API_TOKEN; delete process.env.MY_KEY; delete process.env.GIVEN; });
  const { shipSecrets } = await import("../cli/ship.mjs");
  const r = await runShip(s, { secrets: shipSecrets(process.env, ["given-secret-9876"]) });
  const saved = readFileSync(join(s.logDir, logs(s.logDir)[0]), "utf8");
  const printed = r.out.split("last 40 lines of its output:\n")[1];
  for (const text of [saved, printed]) {
    assert.match(text, /given=\[redacted\] env=\[redacted\] short=short plain=hello-world-123/);
    assert.doesNotMatch(text, /given-secret-9876|env-secret-value-1234/);
  }
});

test("a passing step's output is not printed and nothing is saved", async (t) => {
  const s = setup(t, { run: ["/bin/sh", "-c", "echo fine"] });
  const r = await runShip(s);
  assert.doesNotMatch(r.out, /last 40 lines|full output/);
  assert.deepEqual(logs(s.logDir), []);
});

test("two ships keep two files; neither overwrites the other", async (t) => {
  const s = setup(t, { run: ["/bin/sh", "-c", "echo first; exit 1"] });
  await runShip(s);
  await new Promise((done) => setTimeout(done, 5));
  writeFileSync(join(s.dir, "docs/atelier/ship.json"), JSON.stringify({ schema_version: 1, kind: "atelier.ship", class: "web", push: false, deploy: { run: ["/bin/sh", "-c", "echo second; exit 1"] }, "verify-deploy": { run: ["true"] } }));
  await runShip(s);
  const files = logs(s.logDir);
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((f) => readFileSync(join(s.logDir, f), "utf8").trim()).sort(), ["first", "second"]);
});

test("a step stopped at its time limit is saved and printed, its last line the SIGKILL note", async (t) => {
  const s = setup(t, { run: ["/bin/sh", "-c", "echo started; sleep 30"], timeout_seconds: 1 });
  const r = await runShip(s);
  assert.match(r.ended, /ship stopped at deploy: .* ended by SIGKILL/);
  const saved = readFileSync(join(s.logDir, logs(s.logDir)[0]), "utf8");
  assert.match(saved.trimEnd().split("\n").at(-1), /^\[atelier\] ended by SIGKILL with its process group after its 1s timeout$/);
  assert.match(r.out, /started\n+\[atelier\] ended by SIGKILL.*\ndeploy: full output saved to /);
});

test("a write interrupted part way leaves no named log, and the ship still stops with its failure", async (t) => {
  const s = setup(t, { run: ["/bin/sh", "-c", "echo lost; exit 1"] });
  const io = {
    writeFileSync: (path, text) => { writeFileSync(path, text.slice(0, 2)); throw new Error("disk went away"); },
    renameSync: () => assert.fail("a half-written log must not be renamed"),
    rmSync,
  };
  const r = await runShip(s, { logIo: io });
  assert.match(r.ended, /ship stopped at deploy/);
  assert.deepEqual(readdirSync(s.logDir), [], "no SHIP-STEP.log and no temporary file is left");
  assert.match(r.out, /its full output could not be saved/);
});

test("a ship that dies before its step ends saves nothing", async (t) => {
  const s = setup(t, { run: ["/bin/sh", "-c", "echo partial; exit 1"] });
  await assert.rejects(runShip(s, { checkpoint: async (step) => { if (step === "deploy") throw new Error("killed"); } }), /killed/);
  assert.deepEqual(readdirSync(s.logDir), []);
});

test("two claims on one file store: the second is queued and writes no log", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-ship-log-claim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const live = () => true;
  const a = fileDeployStore(dir, { pid: 1, alive: live }), b = fileDeployStore(dir, { pid: 2, alive: live });
  assert.deepEqual(await a.claim("1".repeat(40)), { run: true });
  assert.deepEqual(await b.claim("2".repeat(40)), { run: false, running: "1".repeat(40) });
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".log")), []);
  assert.ok(existsSync(join(dir, "state.json")));
});

test("a failed step with no output still gets a log holding its exit line, and the report names it", async (t) => {
  const s = setup(t, { run: ["/bin/sh", "-c", "exit 1"] });
  const r = await runShip(s);
  const [file] = logs(s.logDir);
  assert.ok(file, "a log is saved");
  assert.match(readFileSync(join(s.logDir, file), "utf8"), /exited 1/);
  assert.match(r.out, new RegExp(`deploy: full output saved to ${join(s.logDir, file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("a record that throws after a failed step does not lose its log", async (t) => {
  const s = setup(t, { run: ["/bin/sh", "-c", "echo kept; exit 1"] });
  const request = async (method, path, body) => {
    if (path.endsWith("/actions") && method === "GET") return { approvals: [{ id: "a1", kind: "deploy", commit: head, by: "owner", at: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString() }] };
    if (path.endsWith("/consume")) return { id: "a1" };
    if (method === "POST" && path.endsWith("/actions/runs") && body?.step === "deploy") throw new Error("server down");
    return {};
  };
  await runShip(s, { request }).catch((error) => assert.equal(error.message, "server down"));
  assert.equal(logs(s.logDir).length, 1, "the log is saved before the record is tried");
  assert.match(readFileSync(join(s.logDir, logs(s.logDir)[0]), "utf8"), /kept/);
});
