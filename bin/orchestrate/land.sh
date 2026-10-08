#!/bin/zsh
# land.sh TASK CONTEXTFILE NOTE: in the task's workspace, push, run the
# checks, submit, get the cross-family review at that head (review.sh), and,
# when it approves, record the review, accept and merge in the registered
# checkout, then type-check main. Run it through queue.sh, which merges main
# into the task first and keeps landings one at a time. Exits 2 on a failed
# check, 3 when the reviewer does not approve, its rejection and findings
# recorded on the task (its answer is in .scratch/review-TASK.md), 7 when an
# atelier step fails. REVIEW_MODEL picks the reviewer (review.sh):
# gemini-3.1-pro-high, recorded as antigravity/gemini-3.1-pro, or
# gpt-oss-120b-medium, recorded as antigravity/gpt-oss-120b; any other is
# refused before anything runs, so a review is never recorded under a model
# that did not give it. The review is recorded with the reviewer's own
# summary as its note and NOTE goes on the acceptance; both name the head
# that was reviewed, read before review.sh runs, so a later push is never
# taken as reviewed. The task's acceptance criteria are read then too, given
# to the reviewer with the context, and the review names their binding, so a
# change of the criteria while it runs has the verdict refused.
# `atelier land` (task t187) does this inside Atelier; prefer it once the
# server's version check allows (t190).
set -u
source "${0:A:h}/lib.sh"
t=$1 ctx=${2:A} note=$3
model=${REVIEW_MODEL:-gemini-3.1-pro-high}
case $model in
  gemini-3.1-pro-high) reviewer=antigravity/gemini-3.1-pro ;;
  gpt-oss-120b-medium) reviewer=antigravity/gpt-oss-120b ;;
  *) echo "$t: REVIEW_MODEL $model is not one land.sh can name; use gemini-3.1-pro-high or gpt-oss-120b-medium"; exit 7 ;;
esac
W=$(workspace_of "$ATELIER_PROJECT" "$t")
M=$(checkout_of "$ATELIER_PROJECT") || exit 1
cd "$W" || exit 1
# Each step must succeed before the next: a failed push or submit stops the
# landing, and a check run that reports no PASS line counts as failed.
step() { local o; o=$("$@" 2>&1) || { echo "$t: $1 $2 failed:"; echo "$o" | tail -5; exit 7; }; echo "$o" | tail -1; }
step atelier push
checked=$(atelier check 2>&1); code=$?
out=$(echo "$checked" | grep -E "PASS|FAIL"); echo "$out"
{ [ $code -eq 0 ] && echo "$out" | grep -q PASS && ! echo "$out" | grep -q FAIL; } || { echo "$t: CHECK FAILED"; echo "$checked" | tail -25; exit 2; }
step atelier submit --summary "Merged with main; checks pass."
# The head the reviewer reads, which the review and the acceptance name.
head=$(git rev-parse HEAD) || exit 7
# A previous run's answer must never stand in for this one.
answer="$W/.scratch/review-$t.md"
rm -f "$answer"
shown=$(atelier show "$t" --json) || { echo "$t: atelier show failed"; exit 7; }
criteria=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).criteria ?? ""))' "$shown")
[ -n "$criteria" ] || { echo "$t: the server gave no criteria binding; deploy route level 16 or newer"; exit 7; }
mkdir -p "$W/.scratch"
reviewctx="$W/.scratch/review-$t.context"
{ cat "$ctx"; echo; node -e '
const b = JSON.parse(process.argv[1]), t = process.argv[2];
const list = (xs) => xs.map((c, i) => `${i + 1}. ${c}`).join("\n");
const out = [];
out.push(b.accept?.length ? `Acceptance criteria of ${t}. A change that fails one has a correctness fault, which blocks:\n${list(b.accept)}` : `${t} has no acceptance criteria of its own.`);
if (b.partAccept?.length) out.push(`The approved plan'"'"'s acceptance criteria for this part, which bind the same way:\n${list(b.partAccept)}`);
process.stdout.write(out.join("\n\n") + "\n");' "$shown" "$t"; } > "$reviewctx"
"${0:A:h}/review.sh" "$W" "$W/.scratch/review-$t" "$reviewctx" "$model" || { echo "$t: the review did not run"; exit 7; }
# The answer is read with Atelier's parser, and the verdict is recorded with
# its findings whichever way it goes, so a rejection reaches the reliability
# record and atelier finding can judge each finding later.
parsed=$(node "${0:A:h}/verdict.mjs" "$answer")
field() { node -e 'const p = JSON.parse(process.argv[1]); const v = p[process.argv[2]]; process.stdout.write(typeof v === "string" ? v : JSON.stringify(v ?? null))' "$parsed" "$1"; }
if [ "$(field ok)" != "true" ]; then echo "$t: $reviewer's answer could not be read: $(field error)"; grep -v '^$' "$answer" | head -14; exit 3; fi
cd "$M"
if [ "$(field verdict)" != "approve" ]; then
  step atelier review "$t" --as "$reviewer" --head "$head" --criteria "$criteria" --reject --note "$(field summary)" --findings "$(field findings)"
  echo "$t: $reviewer DID NOT APPROVE"; grep -v '^$' "$answer" | head -14; exit 3
fi
step atelier review "$t" --as "$reviewer" --head "$head" --criteria "$criteria" --approve --note "$(field summary)" --findings "$(field findings)"
step atelier accept "$t" --head "$head" --note "$note"
step atelier merge "$t"
git log --oneline -1 | cut -c1-70
if [ -f tsconfig.json ]; then npx tsc -p . && { [ ! -f test/tsconfig.json ] || npx tsc -p test; } && echo "$t: main typecheck OK"; fi
