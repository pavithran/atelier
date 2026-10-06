#!/bin/zsh
# land.sh TASK CONTEXTFILE NOTE: in the task's workspace, push, run the
# checks, submit, get the cross-family review at that head (review.sh), and,
# when it approves, record the review, accept and merge in the registered
# checkout, then type-check main. Run it through queue.sh, which merges main
# into the task first and keeps landings one at a time. Exits 2 on a failed
# check, 3 when the reviewer does not approve (its answer is in
# .scratch/review-TASK.md), 7 when an atelier step fails. REVIEW_MODEL picks the reviewer (review.sh).
# `atelier land` (task t187) does this inside Atelier; prefer it once the
# server's version check allows (t190).
set -u
source "${0:A:h}/lib.sh"
t=$1 ctx=${2:A} note=$3
W=$(workspace_of "$ATELIER_PROJECT" "$t")
M=$(checkout_of "$ATELIER_PROJECT") || exit 1
cd "$W" || exit 1
# Each step must succeed before the next: a failed push or submit stops the
# landing, and a check run that reports no PASS line counts as failed.
step() { local o; o=$("$@" 2>&1) || { echo "$t: $1 $2 failed:"; echo "$o" | tail -5; exit 7; }; echo "$o" | tail -1; }
step atelier push
checked=$(atelier check 2>&1); code=$?
out=$(echo "$checked" | grep -E "PASS|FAIL"); echo "$out"
{ [ $code -eq 0 ] && echo "$out" | grep -q PASS && ! echo "$out" | grep -q FAIL; } || { echo "$t: CHECK FAILED"; echo "$checked" | tail -3; exit 2; }
step atelier submit --summary "Merged with main; checks pass."
model=${REVIEW_MODEL:-gemini-3.1-pro-high}
case $model in gpt-oss*) reviewer=antigravity/gpt-oss-120b ;; *) reviewer=antigravity/gemini-3.1-pro ;; esac
# A previous run's answer must never stand in for this one.
answer="$W/.scratch/review-$t.md"
rm -f "$answer"
"${0:A:h}/review.sh" "$W" "$W/.scratch/review-$t" "$ctx" "$model" || { echo "$t: the review did not run"; exit 7; }
{ grep -q "VERDICT: APPROVE" "$answer" && ! grep -q "VERDICT: REJECT" "$answer"; } || { echo "$t: $reviewer DID NOT APPROVE"; grep -v '^$' "$answer" | head -14; exit 3; }
cd "$M"
step atelier review "$t" --as "$reviewer" --approve --note "$note"
step atelier accept "$t"
step atelier merge "$t"
git log --oneline -1 | cut -c1-70
if [ -f tsconfig.json ]; then npx tsc -p . && { [ ! -f test/tsconfig.json ] || npx tsc -p test; } && echo "$t: main typecheck OK"; fi
