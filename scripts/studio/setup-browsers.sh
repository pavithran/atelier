#!/bin/sh
# setup-browsers.sh [--check] [DIR...]: give the Studio build runners a
# Playwright module and its browsers, and tell the runners where they are.
# Run it as atelier-build on the Studio (docs/runners.md, "Browser tests on
# the build runners"). DIR is a runner config folder (~/.config/atelier/studio-*);
# each build*.json in it gets PLAYWRIGHT_MODULE and PLAYWRIGHT_BROWSERS_PATH in
# every harness entry's env, and each start-build*.zsh exports them, so a
# build's workspace sees them (cli/runner.mjs harnessEnv). Restart the runners
# afterwards. With --check, only launch chromium from the installed module and
# load about:blank (run it after a restart); nothing is changed.
#
# Layout under SETUP_BROWSERS_ROOT (default ~/playwright-runner):
#   node_modules/playwright   the module PLAYWRIGHT_MODULE names
#   browsers/                 PLAYWRIGHT_BROWSERS_PATH, installed by that module
#
# Rerunnable. A run first discards what an earlier run left in its staging
# folder, then installs into staging, launches chromium there, and only then
# moves the result into place and the configs over their old files, so the
# module, browsers and configs are either as they were or complete. A module
# that is already the pinned version and launches is not reinstalled; a config
# that already names the variables is not rewritten. A run killed between the
# two moves leaves the old module in ROOT.old; the next run puts it back.
# A second run while one is running exits 75 naming its pid; a lock left by a
# run that died is taken over.
#
# Each step runs under a time limit, SETUP_BROWSERS_LIMIT seconds (default
# 900). A step past it is killed and the script exits 124 naming the step;
# every timed step works in staging or on .new copies, so nothing in place has
# changed. The moves into place are not timed steps: they are renames.
set -eu

VERSION=${SETUP_BROWSERS_VERSION:-1.61.1}
ROOT=${SETUP_BROWSERS_ROOT:-$HOME/playwright-runner}
LIMIT=${SETUP_BROWSERS_LIMIT:-900}
LOCK=$ROOT.lock
STAGE=$ROOT.staging
OLD=$ROOT.old
say() { echo "setup-browsers: $*" >&2; }
die() { say "$*"; exit "${2:-1}"; }

check_only=0
if [ "${1:-}" = "--check" ]; then check_only=1; shift; fi
case $ROOT in *[!A-Za-z0-9_./-]*|'') die "SETUP_BROWSERS_ROOT must hold only letters, digits and _ . / -" 64 ;; esac
case $LIMIT in ''|*[!0-9]*) die "SETUP_BROWSERS_LIMIT must be a number of seconds" 64 ;; esac
[ "$check_only" = 1 ] || [ "$#" -ge 1 ] || { say "usage: setup-browsers.sh [--check] DIR..."; exit 64; }

# Launch chromium from the module at $1 with browsers at $2 and load about:blank.
launch_check() {
  PLAYWRIGHT_BROWSERS_PATH=$2 node -e '
    const { chromium } = require(process.argv[1]);
    (async () => {
      const browser = await chromium.launch();
      try { const page = await browser.newPage(); await page.goto("about:blank"); }
      finally { await browser.close(); }
    })().catch((e) => { console.error(e && e.message || e); process.exit(1); });
  ' "$1"
}
module_version() { node -e 'process.stdout.write(require(process.argv[1] + "/package.json").version)' "$1" 2>/dev/null || true; }

if [ "$check_only" = 1 ]; then
  launch_check "$ROOT/node_modules/playwright" "$ROOT/browsers" || die "chromium did not launch from $ROOT/node_modules/playwright"
  say "chromium launched from $ROOT/node_modules/playwright and loaded about:blank"
  exit 0
fi

# The lock: a folder holding the owner's pid.
mkdir -p "$(dirname "$ROOT")"
acquire() {
  mkdir "$LOCK" 2>/dev/null && { echo $$ > "$LOCK/pid"; return 0; }
  return 1
}
if ! acquire; then
  holder=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then die "another run holds $LOCK (pid $holder)" 75; fi
  say "taking over $LOCK left by pid ${holder:-unknown}, which is gone"
  rm -rf "$LOCK"
  acquire || die "another run holds $LOCK (pid $(cat "$LOCK/pid" 2>/dev/null || echo unknown))" 75
fi
swapped=0 committed=0 DIRS=$*
cleanup() {
  rc=$?
  trap - EXIT
  # A move into place that did not finish all its renames is undone.
  if [ "$swapped" = 1 ] && [ "$committed" = 0 ]; then
    rm -rf "$ROOT"; [ ! -e "$OLD" ] || mv "$OLD" "$ROOT"
  fi
  rm -rf "$STAGE"
  [ "$committed" = 1 ] || for d in $DIRS; do rm -f "$d"/*.new; done
  [ "$(cat "$LOCK/pid" 2>/dev/null)" != "$$" ] || rm -rf "$LOCK"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

kill_tree() {
  for child in $(pgrep -P "$1" 2>/dev/null || true); do kill_tree "$child"; done
  kill -TERM "$1" 2>/dev/null || true
}
flag=$LOCK/timed-out
run_step() {
  name=$1; shift
  say "step $name"
  rm -f "$flag"
  "$@" &
  pid=$!
  ( sleep "$LIMIT"; : > "$flag"; kill_tree "$pid" ) &
  dog=$!
  rc=0; wait "$pid" || rc=$?
  kill_tree "$dog"; wait "$dog" 2>/dev/null || true
  [ ! -e "$flag" ] || die "step $name exceeded its ${LIMIT}s limit; the module, browsers and configs are unchanged" 124
  [ "$rc" = 0 ] || die "step $name failed (exit $rc); the module, browsers and configs are unchanged"
}

# A run killed between the two moves left the module in ROOT.old.
if [ ! -e "$ROOT" ] && [ -e "$OLD" ]; then mv "$OLD" "$ROOT"; fi
rm -rf "$OLD" "$STAGE"
mkdir "$STAGE"

install_stage() {
  npm install --prefix "$STAGE" --no-audit --no-fund --save-exact "playwright@$VERSION"
}
install_browsers() {
  PLAYWRIGHT_BROWSERS_PATH=$STAGE/browsers node "$STAGE/node_modules/playwright/cli.js" install chromium
}
stage_check() { launch_check "$STAGE/node_modules/playwright" "$STAGE/browsers"; }

if [ -d "$ROOT/node_modules/playwright" ] && [ "$(module_version "$ROOT/node_modules/playwright")" = "$VERSION" ] \
   && launch_check "$ROOT/node_modules/playwright" "$ROOT/browsers" >/dev/null 2>&1; then
  say "playwright $VERSION in $ROOT already launches chromium; not reinstalling"
  need_swap=0
else
  run_step install-module install_stage
  run_step install-browsers install_browsers
  run_step launch-check stage_check
  need_swap=1
fi

# The configs, prepared as .new copies beside the real files.
MODULE=$ROOT/node_modules/playwright BROWSERS=$ROOT/browsers
export MODULE BROWSERS
prepare_one_config() {
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const want = ["PLAYWRIGHT_MODULE", "PLAYWRIGHT_BROWSERS_PATH"];
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(config.agents)) { console.error(file + " has no agents list"); process.exit(1); }
    let changed = false;
    for (const entry of config.agents) {
      const have = Array.isArray(entry.env) ? entry.env : [];
      const next = [...have, ...want.filter((n) => !have.includes(n))];
      if (next.length !== have.length) { entry.env = next; changed = true; }
    }
    if (changed) fs.writeFileSync(file + ".new", JSON.stringify(config, null, 2) + "\n", { mode: fs.statSync(file).mode & 0o777 });
  ' "$1"
}
prepare_one_start() {
  file=$1
  grep -q '^export PATH=' "$file" || { say "$file has no export PATH= line; cannot place the exports"; return 1; }
  awk -v m="export PLAYWRIGHT_MODULE=\"$MODULE\"" -v b="export PLAYWRIGHT_BROWSERS_PATH=\"$BROWSERS\"" '
    /^export PLAYWRIGHT_(MODULE|BROWSERS_PATH)=/ { next }
    { print }
    /^export PATH=/ { print m; print b }
  ' "$file" > "$file.new"
  if cmp -s "$file" "$file.new"; then rm -f "$file.new"; else chmod "$(stat -f %Lp "$file" 2>/dev/null || stat -c %a "$file")" "$file.new"; fi
}
prepare_configs() {
  for dir in "$@"; do
    [ -d "$dir" ] || { say "$dir is not a folder"; return 1; }
    found=0
    for file in "$dir"/build*.json; do [ -f "$file" ] && { found=1; prepare_one_config "$file"; }; done
    for file in "$dir"/start-build*.zsh; do [ -f "$file" ] && { found=1; prepare_one_start "$file"; }; done
    [ "$found" = 1 ] || { say "no build*.json or start-build*.zsh in $dir"; return 1; }
  done
}
cleanup_new() { for dir in "$@"; do rm -f "$dir"/*.new; done; }
# Leftovers from an earlier interrupted run are discarded before preparing.
cleanup_new "$@"
run_step prepare-configs prepare_configs "$@"

# Move into place: the module first, then each config over its old file.
if [ "$need_swap" = 1 ]; then
  [ ! -e "$ROOT" ] || mv "$ROOT" "$OLD"
  swapped=1
  mv "$STAGE" "$ROOT"
fi
for dir in "$@"; do
  for new in "$dir"/*.new; do [ -f "$new" ] && mv -f "$new" "${new%.new}"; done
done
committed=1
if [ "$need_swap" = 1 ]; then rm -rf "$OLD"; fi
say "playwright $VERSION ready: PLAYWRIGHT_MODULE=$MODULE PLAYWRIGHT_BROWSERS_PATH=$BROWSERS; restart the runners"
