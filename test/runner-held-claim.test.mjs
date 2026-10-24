// t241: a claim the server answers 409 held, a core-file hold or a lost race
// for one blocking it, is a wait for the runner: no failed run, no failure
// counted, no run report or run skip, and the task is claimed again at the
// next poll that offers it. A real runner_forbidden is still a refusal: it is
// logged as one and the unchanged task is passed by. On 2026-10-24 studio-3
// logged runner_forbidden for t232 while t223 won the ledger.ts hold in the
// same second.
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRunner, claimRefusedLine } from "../cli/runner.mjs";
import { config, assignment, fixture } from "./runner-shared.mjs";

const HELD = "atelier: held: t13 is held: the core files hold it: it waits on t1 (claimed by codex/gpt-6): both scopes reach core file src/ledger.ts. The claim it waits on is live, its runner polling, so t13 is not offered while it holds; the queue offers it again once the hold clears\n";
const FORBIDDEN = "atelier: runner_forbidden: runner home:studio (token tok) is not authorized for this operation\n";

// Runs the runner for `polls` polls, each offering t13, with the first claim
// answered `refusal`. Returns the claims, the logs, the run reports and run
// skips sent, and the exit code a --once run set.
async function run(t, refusal, { polls: total = 2, once = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-held-claim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify(config));
  t.mock.method(console, "log", () => {});
  const { io, logs } = fixture();
  const claimed = [], reports = [], skips = [];
  io.cli = async (argv) => {
    if (argv[0] !== "claim") return;
    claimed.push(argv[1]);
    if (claimed.length === 1) throw Object.assign(new Error(refusal), { claimRefused: true });
  };
  let polls = 0;
  const exitBefore = process.exitCode;
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path, ...(once ? { once: true } : {}) }, {
    workspacePath: io.workspacePath, taskIO: io, wait: () => tick(),
    async reportRun(body) { reports.push(body); },
    async reportRunSkip(body) { skips.push(body); },
    async queue() {
      if (++polls > total) { process.emit("SIGTERM"); return []; }
      return [assignment];
    },
  });
  const exitCode = process.exitCode;
  process.exitCode = exitBefore;
  return { claimed, logs, reports, skips, exitCode };
}

test("a held claim is a wait: no run report, no run skip, no refusal, and the next poll claims it again", async (t) => {
  const { claimed, logs, reports, skips } = await run(t, HELD);
  assert.deepEqual(claimed, ["t13", "t13"]);
  assert.deepEqual(reports, []);
  assert.deepEqual(skips, []);
  const line = logs.find((l) => l.startsWith("claim held, waiting: "));
  assert.ok(line, logs.join("\n"));
  assert.match(line, /t1 \(claimed by codex\/gpt-6\)/);
  assert.match(line, /core file src\/ledger\.ts/);
  assert.ok(!logs.some((l) => l.startsWith("claim refused: ")), logs.join("\n"));
  assert.ok(!logs.some((l) => /needs the developer's attention/.test(l)), logs.join("\n"));
});

test("held claims at every poll count no failures: the task is never skipped for them", async (t) => {
  // Two failed runs under one dispatch skip a task (passedBy); held answers
  // at every poll but the last are no failed runs, so each poll claims.
  const dir = mkdtempSync(join(tmpdir(), "atelier-held-claim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify(config));
  t.mock.method(console, "log", () => {});
  const { io, logs } = fixture();
  const claimed = [];
  io.cli = async (argv) => {
    if (argv[0] !== "claim") return;
    claimed.push(argv[1]);
    if (claimed.length < 4) throw Object.assign(new Error(HELD), { claimRefused: true });
  };
  let polls = 0;
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path }, {
    workspacePath: io.workspacePath, taskIO: io, wait: () => tick(),
    async queue() {
      if (++polls > 4) { process.emit("SIGTERM"); return []; }
      return [assignment];
    },
  });
  assert.deepEqual(claimed, ["t13", "t13", "t13", "t13"]);
  assert.ok(!logs.some((l) => /Skipped after|needs the developer's attention/.test(l)), logs.join("\n"));
});

test("a runner run once that ends on a held claim does not exit as failed; one refused does", async (t) => {
  assert.notEqual((await run(t, HELD, { polls: 1, once: true })).exitCode, 1);
  assert.equal((await run(t, FORBIDDEN, { polls: 1, once: true })).exitCode, 1);
});

test("a real runner_forbidden is still a refusal: logged as one, and the unchanged task is passed by", async (t) => {
  const { claimed, logs, reports } = await run(t, FORBIDDEN);
  assert.deepEqual(claimed, ["t13"]);
  assert.deepEqual(reports, []);
  assert.ok(logs.some((l) => l.startsWith("claim refused: atelier: runner_forbidden: ")), logs.join("\n"));
  assert.ok(!logs.some((l) => l.startsWith("claim held")), logs.join("\n"));
});

test("claimRefusedLine words a held answer as a wait and anything else as a refusal", () => {
  assert.match(claimRefusedLine(HELD), /^claim held, waiting: atelier: held: t13 is held: .*; it is claimed again at a later poll that offers it$/);
  assert.equal(claimRefusedLine(FORBIDDEN), `claim refused: ${FORBIDDEN}`);
});
