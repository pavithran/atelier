import { test, after } from "node:test";
import assert from "node:assert/strict";
import { checkMain, suiteResult, mainSuiteLines, studioMainSuite } from "../scripts/main-suite.mjs";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { readMainSuite } from "../cli/main-suite.mjs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

test("suite children ignore host diagnostics, while explicit result reads still work", (t) => {
 const result = { commit: "bad", status: "red", lastGreen: "good", failures: ["example"] };
 const read = t.mock.method(fs, "readFileSync", () => JSON.stringify(result));
 syncBuiltinESMExports();
 try {
   assert.equal(readMainSuite(), null);
   assert.deepEqual(readMainSuite("fixture.json"), result);
 } finally { read.mock.restore(); syncBuiltinESMExports(); }
});

test("main suite skips checked heads, coalesces moves and records only completed work", async () => {
 let head = "a", saved = null, runs = [];
 const deps = { head: () => head, read: () => saved, save: r => { saved = r; }, run: async h => { runs.push(h); head = "c"; return { status: 0, output: "" }; } };
 await checkMain(deps);
 assert.equal(saved.commit, "a"); assert.equal(saved.lastGreen, "a");
 await checkMain(deps); await checkMain(deps);
 assert.deepEqual(runs, ["a", "c"]);
 head = "d"; deps.run = async () => { throw Error("crash"); };
 await assert.rejects(checkMain(deps), /crash/);
 assert.equal(saved.commit, "c");
});

test("overlapping observations never start a second suite", async () => {
 let finish, calls = 0;
 const deps = { head: () => "a", read: () => null, save: () => {}, run: () => { calls++; return new Promise(r => { finish = r; }); } };
 const first = checkMain(deps);
 await checkMain(deps);
 assert.equal(calls, 1);
 finish({ status: 0, output: "" }); await first;
});

test("completed clean-clone runs publish red and green results atomically", async () => {
 const root = mkdtempSync(join(tmpdir(), "atelier-main-suite-"));
 after(() => rmSync(root, { recursive: true, force: true }));
 const repo = join(root, "repo"), work = join(root, "work"), bin = join(root, "bin");
 for (const dir of [repo, work, bin]) mkdirSync(dir, { recursive: true });
 const git = (...args) => {
   const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
   assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
 };
 git("init", "-q", "-b", "main");
 git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "fixture");
 const head = git("rev-parse", "HEAD"), file = join(root, "result.json");
 writeFileSync(join(repo, "dirty"), "must not reach suite");
 writeFileSync(join(bin, "npm"), `#!/bin/sh
if [ "$1" = ci ]; then exit 0; fi
test ! -e dirty || exit 9
git rev-parse HEAD
echo 'Failing tests:'
echo '  fixture:1: example failure'
exit 1
`, { mode: 0o755 });
 const oldPath = process.env.PATH;
 process.env.PATH = bin + ":" + oldPath;
 try {
   assert.equal(readMainSuite(file), null);
   await studioMainSuite(join(repo, ".git"), work, file);
   const red = readMainSuite(file);
   assert.equal(red.commit, head); assert.equal(red.status, "red");
   assert.deepEqual(red.failures, ["fixture:1: example failure"]);
   assert.match(readFileSync(join(root, "main-suite.log"), "utf8"), new RegExp(head));
   git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "next");
   writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
   await studioMainSuite(join(repo, ".git"), work, file);
   const green = readMainSuite(file);
   assert.equal(green.status, "green"); assert.equal(green.lastGreen, git("rev-parse", "HEAD"));
   assert.deepEqual(mainSuiteLines(green), []);
 } finally { process.env.PATH = oldPath; }
});

test("landing, claiming and shipping have no main-suite dependency or gate", () => {
 for (const file of ["cli/commands/land.mjs", "cli/commands/start.mjs", "cli/commands/ship.mjs", "src/index.ts", "src/rules.ts", "cli/ship.mjs"]) {
   assert.doesNotMatch(readFileSync(file, "utf8"), /main-suite|mainSuite/, file);
 }
 const plist = readFileSync("scripts/studio/zone.atelier.main-suite.plist.template", "utf8");
 assert.match(plist, /StartInterval<\/key><integer>60/);
 assert.match(plist, /Nice<\/key><integer>20/);
 assert.match(plist, /UserName<\/key><string>atelier-suite/);
 assert.doesNotMatch(plist, /load.mjs|TOKEN/);
 for (const file of ["cli/commands/status.mjs", "cli/commands/stuck.mjs"]) {
   assert.match(readFileSync(file, "utf8"), /mainSuiteLines/);
 }
});

test("red main retains last green and names failures; green clears warning", () => {
 const red = suiteResult("bad", { lastGreen: "good" }, { status: 1, output: "Failing tests:\n  test/example:4: refuses access\n\n" });
 assert.deepEqual(red.failures, ["test/example:4: refuses access"]);
 assert.match(mainSuiteLines(red).join("\n"), /bad.*good/s);
 assert.match(mainSuiteLines(red).join("\n"), /refuses access/);
 assert.deepEqual(mainSuiteLines(suiteResult("fixed", red, { status: 0, output: "" })), []);
});
