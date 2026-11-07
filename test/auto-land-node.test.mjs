// t520: Atelier lands an approved, checked task with no session. Each test
// runs the real Node server, its bare repository and hook (test/land-node-
// shared.mjs), records a task's submit and a cross-company approval, runs the
// stage tick, and lets the runner's land job (cli/runner.mjs) run the real
// `atelier land` in the registered checkout. No test runs a landing by hand
// except where it says so.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRunner } from "../cli/runner.mjs";
import { eventsOf, landingWorld } from "./land-node-shared.mjs";

process.env.ATELIER_LOAD = "0";
const OWNER = "atl_00112233445566778899aabbccddeeff";
const MIN = 60_000;

// The tick, then the runner's land job: a live lander is a runner offer that
// lists the land job and the project's checkout; the runner polls the land
// jobs the ledger offers it and runs each as the real command, in the
// checkout, one after another.
async function autoLand(t, w, { jobs = null } = {}) {
  const index = w.server.namespace.get(w.server.namespace.idFromName("__index"));
  const offer = { runner: "home:lander", kind: "home", agents: [], projects: ["demo"], jobs: ["land"], checkouts: ["demo"] };
  await index.putRunnerOffer(offer, new Date(Date.now() + 600 * MIN).toISOString());
  const tick = await w.L().stageTick(new Date());
  const offered = await w.L().landJobs(offer, ["demo"]);
  const dir = mkdtempSync(join(tmpdir(), "atelier-auto-land-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify({ agents: [{ agent: "codex", models: ["gpt-6-astra"], command: ["codex", "{model}", "{brief_file}"] }], jobs: ["land"] }));
  const executeChild = async (argv, options = {}) => {
    if (argv[0] === "git") { const r = await w.netGit(options.cwd, ...argv.slice(1)); return { code: r.status, output: r.stdout, stderr: r.stderr }; }
    const r = await w.cli(argv.slice(2), { cwd: options.cwd, project: false });
    return { code: r.status, output: r.stdout, stderr: r.stderr };
  };
  const logs = [];
  const log = console.log;
  console.log = (line) => { logs.push(String(line)); };
  let n = 0;
  try {
    await runRunner({ _: ["runner"], multi: {}, name: "home:lander", config: path }, {
      workspacePath: () => dir, executeChild, checkouts: ["demo"], checkoutOf: () => w.checkout, landJournal: () => false,
      baselineHead: async () => w.git(w.checkout, "rev-parse", "HEAD"), // the checkout's own main: the precheck is land-job.test.mjs's harnessReady: async () => ({ ready: true }),
      wait: () => new Promise((resolve) => setImmediate(resolve)),
      async queue() {
        if (++n > 1) { process.emit("SIGTERM"); return []; }
        return (jobs ?? offered).map((item) => ({ project: "demo", item, agent: "atelier", model: "lander", actor: "atelier/lander" }));
      },
    });
  } finally { console.log = log; }
  return { tick, offered, logs };
}

test("an approved, checked task merges with no session command: submit, review approve, the tick, the lander", async (t) => {
  const w = await landingWorld(t);
  const { id, head } = await w.task({ files: { "task.txt": "task\n" } });
  assert.equal((await w.detail(id)).item.state, "submitted");
  const { tick, offered, logs } = await autoLand(t, w);
  assert.equal(tick.recorded, 1, "the tick queued the landing");
  assert.deepEqual(offered.map((j) => j.id), [id]);
  const d = await w.detail(id);
  assert.equal(d.item.state, "merged", logs.join("\n"));
  assert.deepEqual(w.parents(await w.tip()).at(-1), head);
  assert.ok(logs.some((l) => l.includes(`landed demo/${id}`)), logs.join("\n"));
  assert.equal(eventsOf(d, "stage.land-queued").length, 1);
});

test("two approved tasks land one after the other, the second tested on main including the first", async (t) => {
  const w = await landingWorld(t);
  // Both tasks are checked at their own heads, which never held the other's
  // file; the check on the merged tree holds a.txt only once the first landed.
  await w.setPolicy({ checks: ["test -f a.txt"], protected: ["**"] });
  const a = await w.task({ files: { "a.txt": "a\n" }, title: "first" });
  const b = await w.task({ files: { "b.txt": "b\n" }, title: "second" });
  const { offered, logs } = await autoLand(t, w);
  assert.deepEqual(offered.map((j) => j.id), [a.id, b.id], "the landings queue in the order the tasks were approved");
  const first = await w.detail(a.id), second = await w.detail(b.id);
  assert.equal(first.item.state, "merged", logs.join("\n"));
  assert.equal(second.item.state, "merged", logs.join("\n"));
  const mergeB = await w.tip();
  const [onto, headB] = w.parents(mergeB);
  assert.equal(headB, b.head);
  assert.deepEqual(w.parents(onto).at(-1), a.head, "the second merge sits on the first task's merge");
  assert.equal(eventsOf(second, "land.checks")[0].data.reused, undefined, "the second was tested on the merged tree, not reused");
  assert.equal(eventsOf(second, "land.checks")[0].data.mergeCommit, mergeB);
});

// ── the builder's passing checks, reused or run again ───────────────────────

// A counted check: it records each run, and fails once main's line is in
// shared.txt, so a run on a merge that holds main's edit fails.
async function countedCheck(w) {
  const script = `${w.root}/check.sh`, count = `${w.root}/check-runs`;
  writeFileSync(script, `#!/bin/sh\necho x >> ${count}\n! grep -q 'main line' shared.txt\n`, { mode: 0o700 });
  const cmd = `sh ${script}`;
  await w.setPolicy({ checks: [cmd], checkClasses: [{ command: cmd, by: "owner", note: "a test double that counts its runs" }], protected: ["**"] });
  const runs = () => { try { return readFileSync(count, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
  return { cmd, runs };
}

// The builder's receipt for a check at the head: passing, an ordinary run, its
// base the merge base with main when it ran.
async function receipt(w, id, head, cmd, base, paths) {
  await w.L().addEvidence({ itemId: id, claim: cmd, grade: "observed", head, passed: true, by: "codex/gpt-6", at: new Date(Date.now() + 5000).toISOString(), changedPaths: paths, where: "runner",
    reuse: { project: "demo", task: id, head, base, mainHead: null, mode: "ordinary", where: "runner", command: cmd, preparation: "none" } });
}
const TASK_FILES = { "shared.txt": "task line 1\n" + Array.from({ length: 11 }, (_, i) => `line ${i + 2}\n`).join("") };

test("main moved only other paths: the builder's passing checks are reused and the landing records it", async (t) => {
  const w = await landingWorld(t);
  const check = await countedCheck(w);
  const base = w.git(w.checkout, "rev-parse", "HEAD");
  const { id, head } = await w.task({ files: TASK_FILES });
  await receipt(w, id, head, check.cmd, base, ["shared.txt"]);
  const moved = await w.moveMain({ "other.txt": "unrelated\n" }, "main moves another path");
  const r = await w.cli(["land", id]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Reused the builder's passing checks/);
  assert.equal(check.runs(), 0, "no check ran on the merged tree");
  const d = await w.detail(id);
  assert.equal(d.item.state, "merged");
  const checks = eventsOf(d, "land.checks");
  assert.equal(checks.length, 1);
  assert.equal(checks[0].data.reused, true);
  assert.equal(checks[0].data.mainHead, moved, "the reuse names the main it was made against");
  assert.equal(checks[0].data.base, base);
  assert.deepEqual(checks[0].data.statuses, [`reused: ${check.cmd}`]);
});

test("main moved a path the task touches: the checks run on the merged tree, and a failure merges nothing", async (t) => {
  const w = await landingWorld(t);
  const check = await countedCheck(w);
  const base = w.git(w.checkout, "rev-parse", "HEAD");
  const { id, head } = await w.task({ files: TASK_FILES });
  await receipt(w, id, head, check.cmd, base, ["shared.txt"]);
  // main's edit merges cleanly with the task's, and the check fails on it.
  const moved = await w.moveMain({ "shared.txt": Array.from({ length: 12 }, (_, i) => `line ${i + 1}\n`).join("") + "main line 13\n" }, "main edits the same file");
  const r = await w.cli(["land", id]);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /Running the checks on the merged tree: main moved 1 path the task touches/);
  assert.equal(check.runs(), 1, "the check ran on the merged tree");
  assert.equal(await w.tip(), moved, "nothing was pushed to main");
  const d = await w.detail(id);
  assert.equal(d.item.state, "accepted");
  assert.equal(d.landing.failedStep, "checks");
  assert.equal(eventsOf(d, "land.checks").filter((e) => e.data.reused).length, 0);
});

// A regeneration that moves main once, after the merge is made and before its
// checks, as another landing does between a landing's merge and its push.
function moverAfterMerge(w, files) {
  const script = `${w.root}/move-main.sh`, count = `${w.root}/moves`;
  const url = w.remote(OWNER);
  const writes = Object.entries(files).map(([path, text]) => `printf '%s' '${text}' >> ${path}`).join(" && ");
  writeFileSync(script, `#!/bin/sh
export HOME=${w.root} GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
n=$(cat ${count} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${count}
if [ $n -le 1 ]; then
  d=$(mktemp -d) && git clone -q ${url} $d && cd $d && ${writes} && git add . && git -c user.name=Demo -c user.email=t@example.test commit -q -m "main moves during the landing" && git -C ${w.bare} fetch -q $d HEAD:refs/heads/main
  cd / && rm -rf $d
fi
exit 0
`, { mode: 0o700 });
  return `sh ${script}`;
}

test("main moves between a landing's check and its merge: the new merged tree is re-checked, and a failure there merges nothing", async (t) => {
  const w = await landingWorld(t);
  const check = await countedCheck(w);
  const mover = moverAfterMerge(w, { "shared.txt": "main line 13\n" });
  await w.setPolicy({ regenerate: mover });
  const base = w.git(w.checkout, "rev-parse", "HEAD");
  const { id, head } = await w.task({ files: TASK_FILES });
  await receipt(w, id, head, check.cmd, base, ["shared.txt"]);
  const r = await w.cli(["land", id]);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /Reused the builder's passing checks/, "the first merge, made before main moved, reused them");
  assert.match(r.output, /main moved from [0-9a-f]{8} to [0-9a-f]{8} after t\d+'s merge was checked/);
  assert.match(r.output, /Running the checks on the merged tree: main moved 1 path the task touches/);
  assert.equal(check.runs(), 1, "only the second merge's tree was run");
  const d = await w.detail(id);
  assert.equal(d.item.state, "accepted");
  assert.equal(d.landing.failedStep, "checks");
  assert.ok(!w.log().some((l) => l.includes(head)), "main does not hold the task's head");
});

test("main moves only another path between a landing's check and its merge: the checks are reused again against the new main", async (t) => {
  const w = await landingWorld(t);
  const check = await countedCheck(w);
  const mover = moverAfterMerge(w, { "other.txt": "other\n" });
  await w.setPolicy({ regenerate: mover });
  const base = w.git(w.checkout, "rev-parse", "HEAD");
  const { id, head } = await w.task({ files: TASK_FILES });
  await receipt(w, id, head, check.cmd, base, ["shared.txt"]);
  const r = await w.cli(["land", id]);
  assert.equal(r.status, 0, r.output);
  const d = await w.detail(id);
  assert.equal(d.item.state, "merged");
  const [first, second] = w.parents(await w.tip());
  assert.equal(second, head);
  assert.match(w.log().find((l) => l.startsWith(first)), /main moves during the landing/, "the landing merged onto the commit that moved main");
  const checks = eventsOf(d, "land.checks");
  assert.equal(checks.length, 2);
  assert.deepEqual(checks.map((e) => e.data.reused), [true, true]);
  assert.equal(checks[1].data.mainHead, first, "the second reuse names the new main");
  assert.equal(check.runs(), 0);
});

// ── a conflict goes back to the builder ─────────────────────────────────────

test("a landing that fails on a conflict is sent back to its builder, and the same head is not retried", async (t) => {
  const w = await landingWorld(t);
  const { id, head } = await w.task({ files: { "shared.txt": "task's first line\n" } });
  await w.moveMain({ "shared.txt": "main's first line\n" }, "main rewrites the same line");
  const { logs } = await autoLand(t, w);
  const d = await w.detail(id);
  assert.equal(d.item.state, "open", `the dispatch released the task to its builder: ${logs.join("\n")}`);
  assert.equal(d.landing.failedStep, "merge-main");
  assert.deepEqual(d.landing.files, ["shared.txt"]);
  assert.ok(logs.some((l) => l.includes("was sent back to its builder")), logs.join("\n"));
  assert.equal(d.item.dispatch?.job, "merge-main", "the task is dispatched to its builder");
  // A runner note is facts only (automaticNote), so the files ride in the landing record asserted above.
  assert.match(d.item.dispatch?.note ?? "", /step merge/);
  assert.equal(d.item.head, head);
  // Another tick and another lander pass: the failed head is queued and run no more.
  const again = await autoLand(t, w);
  assert.equal(again.tick.recorded, 0, "the tick queues nothing for the failed head");
  assert.deepEqual(again.offered, []);
  assert.equal(eventsOf(await w.detail(id), "land.start").length, 1, "the landing started once");
});
