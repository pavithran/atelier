import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { failedStep, failureReport, runLandJob } from "../cli/land-queue.mjs";
import { offerFrom, runRunner } from "../cli/runner.mjs";
import { parseConfig } from "../cli/runner-config.mjs";

// The land job (t226): a runner that lists it and holds the project's
// registered checkout runs `atelier land ID` there. A new landing is refused,
// with the reason, in a dirty checkout or one whose main is not the baseline's;
// one that left a journal is resumed by the command itself; a failure is told
// once with its step and the tail of its log.

process.env.ATELIER_LOAD = "0";

const HEAD = "a".repeat(40), OTHER = "b".repeat(40);
const jobIo = (over = {}) => {
  const ran = [];
  return {
    ran,
    io: {
      checkout: "/checkout", git: async (argv) => (argv[0] === "status" ? { code: 0, output: "" } : { code: 0, output: `${HEAD}\n` }),
      baselineHead: async () => HEAD, hasJournal: () => false,
      land: async () => { ran.push("land"); return { code: 0, output: "landed" }; },
      ...over,
    },
  };
};

test("a clean checkout on the baseline's head runs the landing", async () => {
  const { io, ran } = jobIo();
  assert.deepEqual(await runLandJob("t9", io), { ok: true });
  assert.deepEqual(ran, ["land"]);
});

test("a dirty checkout is refused with the reason and nothing runs", async () => {
  const { io, ran } = jobIo({ git: async (argv) => (argv[0] === "status" ? { code: 0, output: " M cli/land.mjs\n?? notes.txt\n" } : { code: 0, output: HEAD }) });
  const result = await runLandJob("t9", io);
  assert.equal(result.ok, false);
  assert.equal(result.refused, true);
  assert.match(result.reason, /\/checkout has uncommitted changes \(cli\/land\.mjs, notes\.txt\)/);
  assert.deepEqual(ran, []);
});

test("a main that differs from the baseline is refused with both commits named", async () => {
  const { io, ran } = jobIo({ baselineHead: async () => OTHER });
  const result = await runLandJob("t9", io);
  assert.equal(result.refused, true);
  assert.match(result.reason, /main in the checkout \/checkout is at aaaaaaaa, not at the baseline's bbbbbbbb/);
  assert.deepEqual(ran, []);
});

test("a baseline's commit paired with the checkout's head by the history-since map is the same main", async () => {
  const { io } = jobIo({ baselineHead: async () => OTHER, samePaired: async (here, base) => here === HEAD && base === OTHER });
  assert.deepEqual(await runLandJob("t9", io), { ok: true });
});

test("a landing killed earlier left a journal: the command resumes it, whatever the checkout holds", async () => {
  const { io, ran } = jobIo({ hasJournal: () => true, git: async () => { throw new Error("the checkout must not be judged"); } });
  assert.deepEqual(await runLandJob("t9", io), { ok: true });
  assert.deepEqual(ran, ["land"]);
});

test("a failed landing is reported with its step and the tail of its log", async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  const { io } = jobIo({ land: async () => ({ code: 1, output: `${lines}\natelier merge failed (exit 1):\nconflict` }) });
  const result = await runLandJob("t9", io);
  assert.equal(result.ok, false);
  assert.equal(result.refused, false);
  assert.match(result.reason, /^landing t9 failed at merge:\n/);
  assert.ok(result.reason.includes("conflict") && !result.reason.includes("line 5\n"));
  assert.equal(failedStep("nothing recognisable"), "land");
  assert.match(failureReport("t1", ""), /^landing t1 failed at land\.$/);
});

test("the config lists the land job, and the offer names a checkout only when the job is listed", () => {
  const agents = [{ agent: "codex", models: ["gpt-6-astra"] }];
  assert.deepEqual(parseConfig({ agents, jobs: ["build", "land"] }).errors, []);
  assert.deepEqual(offerFrom({ agents, jobs: ["land"] }, "home:studio").jobs, ["land"]);
  assert.ok(!offerFrom({ agents }, "home:studio").jobs.includes("land"));
});

// The runner's loop: the offers it polls with and the job it runs.
async function loop(t, { checkouts, config = {}, git = {}, journal = false, land = { code: 0, output: "ok" }, polls = 1 }) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-land-job-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify({ agents: [{ agent: "codex", models: ["gpt-6-astra"], command: ["codex", "{model}", "{brief_file}"] }], jobs: ["land"], ...config }));
  const logs = [], offers = [], spawned = [];
  const job = { project: "atelier", item: { id: "t9", title: "x", dispatch: { job: "land", at: "2026-10-24T00:00:00.000Z" } }, agent: "atelier", model: "lander", actor: "atelier/lander" };
  let n = 0;
  const executeChild = async (argv, options) => {
    if (argv[0] === "git") {
      const key = argv[1];
      return key in git ? git[key] : { code: 0, output: key === "rev-parse" ? `${HEAD}\n` : "" };
    }
    spawned.push({ argv, cwd: options.cwd, env: options.env });
    return { ...land, stderr: "" };
  };
  t.mock.method(console, "log", (line) => logs.push(String(line)));
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path }, {
    workspacePath: () => dir, executeChild, checkouts, checkoutOf: () => "/checkout", landJournal: () => journal,
    baselineHead: async () => HEAD, harnessReady: async () => ({ ready: true }),
    wait: () => new Promise((resolve) => setImmediate(resolve)),
    async queue(offer) { offers.push(offer); if (++n > polls) { process.emit("SIGTERM"); return []; } return [job]; },
  });
  return { logs, offers, spawned };
}

test("a runner with no registered checkout names none and runs no land job", async (t) => {
  const { offers, spawned } = await loop(t, { checkouts: [] });
  assert.deepEqual(offers[0].checkouts, []);
  assert.deepEqual(spawned, []);
});

test("a runner with the checkout offers it and runs atelier land there without its runner name", async (t) => {
  process.env.ATELIER_RUNNER_NAME = "studio";
  t.after(() => { delete process.env.ATELIER_RUNNER_NAME; });
  const { offers, spawned, logs } = await loop(t, { checkouts: ["atelier"] });
  assert.deepEqual(offers[0].checkouts, ["atelier"]);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].argv.slice(2), ["land", "t9", "--project", "atelier"]);
  assert.equal(spawned[0].cwd, "/checkout");
  assert.equal(spawned[0].env.ATELIER_RUNNER_NAME, undefined);
  assert.ok(logs.some((l) => l.includes("landed atelier/t9")));
});

test("a config that does not list the job offers no checkouts", async (t) => {
  const { offers } = await loop(t, { checkouts: ["atelier"], config: { jobs: ["build"] }, polls: 0 });
  assert.equal(offers[0].checkouts, undefined);
});

test("a dirty checkout is refused in the log once, however many polls find it, and runs nothing", async (t) => {
  const { logs, spawned } = await loop(t, { checkouts: ["atelier"], git: { status: { code: 0, output: " M a.txt\n" } }, polls: 3 });
  assert.deepEqual(spawned, []);
  assert.equal(logs.filter((l) => l.includes("refused:") && l.includes("uncommitted changes")).length, 1);
});

test("after a kill the next run of the job resumes from the journal even in a checkout holding the landing's merge", async (t) => {
  const { spawned } = await loop(t, { checkouts: ["atelier"], journal: true, git: { status: { code: 0, output: "UU cli/x.mjs\n" } } });
  assert.equal(spawned.length, 1);
});

test("a failed landing is told once with its step, and not run again at the next poll", async (t) => {
  const { logs, spawned } = await loop(t, { checkouts: ["atelier"], land: { code: 1, output: "atelier check failed (exit 1):\n1 failing" }, polls: 3 });
  assert.equal(spawned.length, 1);
  assert.equal(logs.filter((l) => l.includes("failed at check")).length, 1);
});

test("land --queue with --dry-run is refused before anything is asked of the server", () => {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "../cli/atelier.mjs"), "land", "t9", "--queue", "--dry-run", "--project", "atelier"], { encoding: "utf8", env: { ...process.env, ATELIER_SERVER: "http://127.0.0.1:9" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--queue and --dry-run say two things/);
});
