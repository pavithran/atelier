#!/bin/sh
# Synchronous landing barrier, run in the registered checkout on main.
# A failure leaves land-queue.sh's durable marker in place for a retry.
set -eu
[ "$(git branch --show-current)" = main ] || { echo 'Switch to main first'; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo 'Checkout must be clean'; exit 1; }
git pull --ff-only
head=$(git rev-parse HEAD)
npm run typecheck
npm test
# Owner decision d6: deploy every checked landing. If a task declares a
# remote smoke check, supply an executable that accepts before/after.
if [ -n "${POST_MERGE_SMOKE:-}" ]; then "$POST_MERGE_SMOKE" before; fi
npm run deploy
if [ -n "${POST_MERGE_SMOKE:-}" ]; then "$POST_MERGE_SMOKE" after; fi
[ "$(git rev-parse HEAD)" = "$head" ] || { echo 'Main moved during checks'; exit 1; }
: "${NOREPLY:?Set the recorded public no-reply address}"
git fetch public
# Keep complete audit material outside tracked files. -m includes each
# merge parent's diff; --root includes an initial commit when applicable.
audit=$(git rev-parse --git-path public-audit)
mkdir -p "$audit"
git log --format='%H %ae %ce' "public/main..$head" > "$audit/addresses"
awk -v expected="$NOREPLY" '$2 != expected || $3 != expected' "$audit/addresses" > "$audit/bad-addresses"
git log --format= --name-only -m --root "public/main..$head" > "$audit/paths"
git log --format=fuller -p -m --root --binary "public/main..$head" > "$audit/history.patch"
if [ -s "$audit/bad-addresses" ]; then
  cat "$audit/bad-addresses"; echo 'Repair outgoing commit identities before publishing'; exit 1
fi
if grep -E '^(PROJECT|AGENTS)\.md$|^\.env' "$audit/paths"; then
  echo 'Remove private files from outgoing history, not just its tip'; exit 1
fi
# A pattern scan cannot establish that arbitrary prose/binary assets are
# public. Require an explicit audit of ALL outgoing history at this head.
if [ "${PUBLIC_AUDIT_HEAD:-}" != "$head" ]; then
  echo "Review $audit/addresses, $audit/paths and $audit/history.patch (including binary assets)."
  echo "After clearing every private detail, restart with PUBLIC_AUDIT_HEAD=$head."
  exit 1
fi
[ "$(git rev-parse HEAD)" = "$head" ] || { echo 'Main moved during audit'; exit 1; }
git push public "$head:refs/heads/main"
