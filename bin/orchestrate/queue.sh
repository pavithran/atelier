#!/bin/zsh
# queue.sh TASK CONTEXTFILE NOTE: waits for the project's landing lock (one
# landing at a time on this machine), merges main into the task's workspace,
# and lands it with land.sh when the merge is clean and type-checks. Exits 4
# on conflicts, leaving the merge in the workspace to resolve, and 5 when the
# merged tree fails its type check.
set -u
source "${0:A:h}/lib.sh"
t=$1 ctx=$2 note=$3
M=$(checkout_of "$ATELIER_PROJECT") || exit 1
W=$(workspace_of "$ATELIER_PROJECT" "$t")
lock="$ATELIER_CACHE/landing-$ATELIER_PROJECT.lock"
until mkdir "$lock" 2>/dev/null; do sleep 20; done
echo $$ > "$lock/pid"
trap 'rm -rf "$lock"' EXIT
cd "$W" || exit 1
git fetch -q "$M" main && git merge --no-ff -m "Merge main into $t" FETCH_HEAD 2>&1 | grep -E "CONFLICT|Merge made|Already"
if [ -n "$(git diff --name-only --diff-filter=U)" ]; then echo "$t: CONFLICTS: $(git diff --name-only --diff-filter=U | tr '\n' ' ')"; exit 4; fi
if [ -f tsconfig.json ]; then { npx tsc -p . && { [ ! -f test/tsconfig.json ] || npx tsc -p test; }; } || { echo "$t: TYPECHECK FAILED after merge"; exit 5; }; fi
"${0:A:h}/land.sh" "$t" "$ctx" "$note"
