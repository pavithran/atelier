// scripts/studio/setup-restore.sh's moves and checks (Atelier 2.0, task 12),
// exercised without root: a test sources the script's functions alone
// (SETUP_RESTORE_LIB=1) and points them at a scratch home owned by the user
// running the test. The script reads owners with BSD stat, so this runs on
// macOS only, as the Studio does.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const darwin = process.platform === "darwin" ? false : "the setup scripts read owners with BSD stat; macOS only";

function home() {
  const t = mkdtempSync(join(tmpdir(), "atelier-setup-restore-"));
  dirs.push(t);
  const h = join(t, "home");
  for (const d of ["", "data", "repos", "data/staging", "repos/staging"]) mkdirSync(join(h, d), { mode: 0o700 });
  writeFileSync(join(h, "data/staging/ledger"), "live data");
  writeFileSync(join(h, "repos/staging/HEAD"), "live repos");
  return h;
}

// Runs a bash fragment with the script's functions loaded and its paths set.
function bash(h, body) {
  const script = `
SETUP_RESTORE_LIB=1 source scripts/studio/setup-restore.sh
set +e
SVC=${userInfo().username}
HOME_DIR='${h}'
D="$HOME_DIR/data/staging"; R="$HOME_DIR/repos/staging"
D_OLD="$D.before-restore-T"; R_OLD="$R.before-restore-T"
${body}`;
  return spawnSync("bash", ["-c", script], { encoding: "utf8" });
}

test("a failed second move aside is undone: data moves back, repos stays, and nothing is left at the destinations", { skip: darwin }, () => {
  const h = home();
  // As in the script, a failure exits, and the EXIT trap runs the undo.
  const r = bash(h, `
mv() { if [ "$1" = "$R" ]; then echo "mock: the move of repos fails" >&2; return 1; fi; command mv "$@"; }
trap 'undo_moves; echo "undone moved_d=$moved_d moved_r=$moved_r"' EXIT
check_paths
move_aside
echo "not reached"`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /mock: the move of repos fails/);
  assert.match(r.stderr, /could not move .*repos\/staging aside/);
  assert.match(r.stdout, /undone moved_d=1 moved_r=$/m);
  assert.doesNotMatch(r.stdout, /not reached/);
  assert.equal(readFileSync(join(h, "data/staging/ledger"), "utf8"), "live data");
  assert.equal(readFileSync(join(h, "repos/staging/HEAD"), "utf8"), "live repos");
  assert.ok(!existsSync(join(h, "data/staging.before-restore-T")));
  assert.ok(!existsSync(join(h, "repos/staging.before-restore-T")));
});

test("a failure during placement removes the partial copy and moves both back", { skip: darwin }, () => {
  const h = home();
  const r = bash(h, `
trap 'undo_moves; echo "undo status $?"' EXIT
check_paths
move_aside
placing_d=1; mkdir "$D"; echo restored > "$D/ledger"
placing_r=1; mkdir "$R"; echo half > "$R/HEAD"
exit 1`);
  assert.match(r.stdout, /undo status 0/);
  assert.equal(readFileSync(join(h, "data/staging/ledger"), "utf8"), "live data");
  assert.equal(readFileSync(join(h, "repos/staging/HEAD"), "utf8"), "live repos");
});

test("the four paths are checked: a link at data or repos, a dangling link or a directory at a destination, is refused", { skip: darwin }, () => {
  const cases = {
    "data is a link": (h) => { rmSync(join(h, "data/staging"), { recursive: true }); symlinkSync(join(h, "elsewhere"), join(h, "data/staging")); },
    "repos is a dangling link": (h) => { rmSync(join(h, "repos/staging"), { recursive: true }); symlinkSync(join(h, "nowhere"), join(h, "repos/staging")); },
    "the data destination is a dangling link": (h) => symlinkSync(join(h, "nowhere"), join(h, "data/staging.before-restore-T")),
    "the repos destination exists": (h) => mkdirSync(join(h, "repos/staging.before-restore-T")),
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const h = home();
    arrange(h);
    const r = bash(h, "check_paths && echo passed");
    assert.notEqual(r.status, 0, name);
    assert.doesNotMatch(r.stdout, /passed/, name);
    assert.match(r.stderr, /is a link|exists already, or is a link/, name);
  }
  const fresh = home();
  assert.match(bash(fresh, "check_paths && echo passed").stdout, /passed/);
});

test("recovery moves nothing over a link or onto an existing path", { skip: darwin }, () => {
  const h = home();
  const r = bash(h, `
check_paths
move_aside
ln -s "$HOME_DIR/elsewhere" "$D"
undo_moves; echo "undo status $?"`);
  assert.match(r.stdout, /undo status 1/);
  assert.match(r.stderr, /data\/staging is a link; left as it is/);
  assert.ok(lstatSync(join(h, "data/staging")).isSymbolicLink());
  assert.equal(readFileSync(join(h, "data/staging.before-restore-T/ledger"), "utf8"), "live data");
  assert.equal(readFileSync(join(h, "repos/staging/HEAD"), "utf8"), "live repos");
});

// After any failed undo step: no start or bootstrap command, the four paths
// as they stand, and the repair line.
function assertNoStart(r, h) {
  assert.doesNotMatch(r.stdout, /STARTED/);
  assert.match(r.stdout, /recover status 1/);
  assert.match(r.stderr, /could not be undone completely; every .* job is left stopped/);
  assert.doesNotMatch(r.stderr, /launchctl|bootstrap system|start the jobs/);
  for (const p of ["data/staging", "data/staging.before-restore-T", "repos/staging", "repos/staging.before-restore-T"]) {
    assert.match(r.stderr, new RegExp(`    ${h}/${p.replace(/\./g, "\\.")}: (a directory|absent|a link to .*|present, not a directory)\n`), p);
  }
  assert.match(r.stderr, /repair these, then run setup-restore\.sh again \(or bootstrap by hand once all four are as they were\)/);
}
const LOADED = `JOBS="zone.atelier.server.staging zone.atelier.tunnel"
loaded=" zone.atelier.server.staging zone.atelier.tunnel"
start_loaded() { echo "STARTED"; }`;

test("a live path that is a link before any move: the undo fails, and no start command is printed", { skip: darwin }, () => {
  const h = home();
  rmSync(join(h, "repos/staging"), { recursive: true });
  const r = bash(h, `
${LOADED}
move_aside
ln -s "$HOME_DIR/elsewhere" "$R"
recover; echo "recover status $?"`);
  assertNoStart(r, h);
  assert.match(r.stderr, new RegExp(`    ${h}/repos/staging: a link to ${h}/elsewhere`));
  // Facts only: recovery prints no command to run.
  assert.doesNotMatch(r.stderr, /sudo |hint:/);
  assert.ok(lstatSync(join(h, "repos/staging")).isSymbolicLink());
});

test("a failed move back of repos: data is put back, and no start command is printed", { skip: darwin }, () => {
  const h = home();
  const r = bash(h, `
${LOADED}
check_paths
move_aside
placing_d=1; mkdir "$D"; echo half > "$D/ledger"
mv() { if [ "$1" = "$R_OLD" ]; then echo "mock: the move back of repos fails" >&2; return 1; fi; command mv "$@"; }
recover; echo "recover status $?"`);
  assertNoStart(r, h);
  assert.match(r.stderr, /data: this run moved the original to .*; the recovery put it back\./);
  // Facts only: recovery prints no command to run.
  assert.doesNotMatch(r.stderr, /sudo |hint:/);
  assert.equal(readFileSync(join(h, "data/staging/ledger"), "utf8"), "live data");
});

test("no original and a placed copy that cannot be removed: its state is printed, and no command is", { skip: darwin }, () => {
  const h = home();
  rmSync(join(h, "data/staging"), { recursive: true });
  const r = bash(h, `
${LOADED}
check_paths
move_aside
placing_d=1; mkdir "$D"; echo partial > "$D/ledger"
rm() { if [ "$2" = "$D" ]; then echo "mock: rm fails" >&2; return 1; fi; command rm "$@"; }
recover; echo "recover status $?"`);
  assertNoStart(r, h);
  assert.match(r.stderr, /data: this run moved nothing, and began placing the restored copy at /);
  // Facts only: recovery prints no command to run.
  assert.doesNotMatch(r.stderr, /sudo |hint:/);
});

test("a complete undo starts again the jobs that ran", { skip: darwin }, () => {
  const h = home();
  const r = bash(h, `
start_loaded() { echo "STARTED"; }
check_paths
move_aside
recover; echo "recover status $?"`);
  assert.match(r.stdout, /STARTED\nrecover status 0/);
});
