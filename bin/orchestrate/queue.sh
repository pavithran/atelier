#!/bin/zsh
# queue.sh TASK CONTEXTFILE NOTE: waits for the project's landing lock (one
# landing at a time on this machine), merges main into the task's workspace,
# and lands it with land.sh when the merge is clean and type-checks. Exits 4
# on conflicts, leaving the merge in the workspace to resolve, 5 when the
# merged tree fails its type check, and 6 when main cannot be fetched or merged.
set -u
source "${0:A:h}/lib.sh"
t=$1 ctx=${2:A} note=$3
M=$(checkout_of "$ATELIER_PROJECT") || exit 1
W=$(workspace_of "$ATELIER_PROJECT" "$t")
# One landing at a time on this machine: the script runs again under the
# kernel's file lock (flock on Linux, lockf on macOS), which waits for the
# holder and is released when the holder exits or dies, so it is never left
# stale.
lock="$ATELIER_CACHE/landing-$ATELIER_PROJECT.lock"
if [ -z "${ATELIER_LANDING_LOCKED:-}" ]; then
  mkdir -p "$ATELIER_CACHE"; touch "$lock"
  export ATELIER_LANDING_LOCKED=1
  if command -v flock >/dev/null; then exec flock "$lock" zsh "${0:A}" "$@"; fi
  exec lockf -k "$lock" zsh "${0:A}" "$@"
fi
cd "$W" || exit 1
# A workspace an agent never built in has no dependencies yet; the type check
# below needs them, and the project's generated types.
if [ -f package.json ] && [ ! -d node_modules ]; then
  npm ci --prefer-offline --no-audit --no-fund >/dev/null || { echo "$t: npm ci failed"; exit 5; }
  if node -e 'process.exit(require("./package.json").scripts?.types ? 0 : 1)'; then
    npm run types >/dev/null || { echo "$t: npm run types failed"; exit 5; }
  fi
fi
git fetch -q "$M" main || { echo "$t: could not fetch main from $M"; exit 6; }
merge=$(git merge --no-ff -m "Merge main into $t" FETCH_HEAD 2>&1); merged=$?
echo "$merge" | grep -E "CONFLICT|Merge made|Already"
if [ -n "$(git diff --name-only --diff-filter=U)" ]; then echo "$t: CONFLICTS: $(git diff --name-only --diff-filter=U | tr '\n' ' ')"; exit 4; fi
[ $merged -eq 0 ] || { echo "$t: the merge of main failed:"; echo "$merge" | tail -5; exit 6; }
if [ -f tsconfig.json ]; then { npx tsc -p . && { [ ! -f test/tsconfig.json ] || npx tsc -p test; }; } || { echo "$t: TYPECHECK FAILED after merge"; exit 5; }; fi
"${0:A:h}/land.sh" "$t" "$ctx" "$note"
