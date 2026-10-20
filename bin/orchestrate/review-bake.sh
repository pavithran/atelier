#!/bin/zsh
# review-bake.sh: a reviewer bake-off. It measures how well each reviewer
# judges a build, on builds whose defects a judge already confirmed (the model
# bake-off's builds and judge verdicts: one folder of build workspaces, one
# tasks.txt, one judge/verdict-TASK.md per task).
#
#   review-bake.sh run   --sample FILE --out DIR --reviewers LIST [options]
#   review-bake.sh run   --cases DIR --out DIR --reviewers LIST [options]
#   review-bake.sh score --out DIR --truth FILE [--labels FILE]
#   review-bake.sh score --out DIR --cases DIR [--version TEXT] [--write]
#
# run   gives every reviewer in LIST the same blind brief and the same diff of
#       every build in the sample, read-only, and collects each reply. Reviews
#       run per family at the same time: at most 2 Codex, 2 Antigravity, 1
#       Claude Code. A reply in which review-bake-score.mjs finds no verdict is tried
#       again once; a second miss is recorded as failed for that build. A run
#       can be repeated: a review that already has its verdict is kept. Every
#       scheduled reviewer/build pair is written to DIR/pairs.txt; the scorer
#       counts a pair with no result as a failed review.
# score compares each review with the judge's verdict (review-bake-score.mjs,
#       described there): per build the defects caught and missed, the false
#       blocking findings, the approvals of C or D builds and the rejections of
#       A builds; per reviewer the totals, precision and recall.
#
# Reviewers, written harness/model:
#   codex/MODEL          codex exec -m MODEL -s read-only --skip-git-repo-check -
#                        (brief and diff on standard input)
#   antigravity/MODEL    node cli/agy-review.mjs --model ID ... (ID is MODEL, but
#                        gemini-3.1-pro is gemini-3.1-pro-high)
#   claude-code/MODEL    ~/.local/bin/atelier-claude MODEL ... in its review mode
#                        (opus-5.5, sonnet-5.5, haiku-5.5, fable-5.1; needs
#                        `claude -p` signed in, so a run says --skip when it is not)
#
# The sample file has one build per line: "SLUG-TASK<TAB>GRADE<TAB>why"; blank
# lines and lines starting # are ignored. SLUG-TASK names the build workspace
# in --builds. Its task's base commit is in BAKE/tasks.txt ("t684 base SHA ref
# SHA"); the change is `git diff BASE HEAD` of the workspace.
#
# Options of run:
#   --sample FILE    the builds to review (required, unless --cases)
#   --cases DIR      a portable case set (bin/orchestrate/review-cases/v1): DIR/sample.txt
#                    is the sample, and each case folder holds the brief, the diff and
#                    the base commit. A review runs in a clone of --source at that base
#                    with the diff applied, uncommitted; nothing outside the repository
#                    is read (--bake and --builds are not used)
#   --source DIR     the repository a case's base commit is cloned from (default: the
#                    repository this script is in)
#   --out DIR        where everything goes (required): reviews/, status/, logs/, inputs/
#   --reviewers LIST comma-separated harness/model (required)
#   --skip LIST      reviewers in LIST are not run; they are written to DIR/skipped.txt
#   --bake DIR       the model bake-off's data folder (default ~/Documents/ai-project-data/atelier/bake-2026-10-15)
#   --builds DIR     the build workspaces (default ~/Library/Caches/ai-projects/atelier-bake)
#   --cache DIR      where the throwaway review clones go (default ~/Library/Caches/ai-projects/atelier-review-bake)
#   --tries N        runs per review before it counts as failed (default 2)
#   --retry-sleep S  seconds to wait before a second try (default 120; a rate limit needs minutes)
#   --timeout S      seconds one review may take (default 2400)
#   --dry-run        print the jobs and run nothing
# Environment: RB_AGY_REVIEW (path of agy-review.mjs, default cli/ beside this
# script's repository), RB_CLAUDE (path of atelier-claude), RB_CODEX (codex).
#
# What a reviewer sees: a clean clone of the build at its head, with the
# build's node_modules linked in so it can run tests, and no .scratch/ of the
# builder. It does not see the judge's verdict or the build's grade. It can see
# the commit message and author of the build's commits (git log), so it is blind
# to the model's name only as far as the builder left no trace in them.
set -u
here=${0:A:h}
repo=${here:h:h}
sub=${1:-}
shift 2>/dev/null

die() { print -u2 -r -- "review-bake.sh: $*"; exit 64; }

# reviewer_family harness/model: the family that sets how many run at once.
reviewer_family() {
  case $1 in
    codex/*) print codex ;;
    antigravity/*) print antigravity ;;
    claude-code/*) print claude ;;
    *) return 1 ;;
  esac
}

# prepare_case BUILD: the same inputs, copied from the case set (head is its base commit).
prepare_case() {
  local d=$RB_OUT/inputs/$1 c=$RB_CASES/$1
  [[ -s $c/brief.md && -s $c/diff.txt && -s $c/base ]] || { print -u2 "case $1 in $RB_CASES lacks brief.md, diff.txt or base"; return 1 }
  git -C $RB_SOURCE cat-file -e "$(<$c/base)^{commit}" 2>/dev/null || { print -u2 "base $(<$c/base) of case $1 is not a commit of $RB_SOURCE"; return 1 }
  mkdir -p $d && cp $c/brief.md $c/diff.txt $d/ && cp $c/base $d/head
}

# prepare_inputs BUILD: OUT/inputs/BUILD/{brief.md,diff.txt,head} once, the same for every reviewer.
prepare_inputs() {
  [[ -n $RB_CASES ]] && { prepare_case $1; return }
  local build=$1 task=${1##*-} ws=$RB_BUILDS/$1 d=$RB_OUT/inputs/$1 base head
  [[ -d $ws/.git || -f $ws/.git ]] || { print -u2 "no build workspace $ws"; return 1 }
  [[ -s $d/diff.txt && -s $d/brief.md ]] && return 0
  base=$(awk -v t=$task '$1==t{print $3}' $RB_BAKE/tasks.txt)
  [[ -n $base ]] || { print -u2 "no base for $task in $RB_BAKE/tasks.txt"; return 1 }
  head=$(git -C $ws rev-parse HEAD) || return 1
  mkdir -p $d
  # The blind brief the model bake-off gave its reviewers, kept if the build has it, else
  # rebuilt with that run's score.sh recipe.
  if [[ -s $ws/.scratch/review-brief.md ]]; then
    cp $ws/.scratch/review-brief.md $d/brief.md
  else
    { print -r -- "Read only: change no file, commit nothing, push nothing, run no atelier command. You may run the project's tests (node --test FILES, npx vitest run FILES)."
      print; print -r -- "You review a change to Atelier (a Git platform on Cloudflare for coding agents) at ${head:0:8}; the workspace is at that head and the change is ${base:0:8} to ${head:0:8} (diff below). The task and its acceptance criteria:"
      print; cat $RB_BAKE/briefs/$task.md
      print; print -r -- "Check that each criterion is met, that each new test fails without the fix (reason it through or run it), that nothing else regresses, and that the fix cannot be bypassed. Report each finding as a line 'FINDING: blocking|followup file:line text' (blocking means a criterion not met or a real defect)."
      print; print -r -- "Your reply MUST end with exactly one line: VERDICT: APPROVE or VERDICT: REJECT"
    } > $d/brief.md
  fi
  git -C $ws diff $base $head -- . ':(exclude).scratch' > $d/diff.txt
  [[ -s $d/diff.txt ]] || { print -u2 "empty diff for $build"; rm -f $d/diff.txt; return 1 }
  print -r -- $head > $d/head
}

# has_verdict FILE: true when review-bake-score.mjs reads a verdict in FILE.
has_verdict() { node $here/review-bake-score.mjs --has-verdict $1 }

# one REVIEWER BUILD: one review, with its tries; writes reviews/ and status/.
one() {
  local reviewer=$1 build=$2 key=${1//\//_}__$2
  local in=$RB_OUT/inputs/$build ws=$RB_BUILDS/$build
  [[ -n $RB_CASES ]] && ws=$RB_SOURCE
  local res=$RB_OUT/reviews/$key.md st=$RB_OUT/status/$key.json log=$RB_OUT/logs/$key
  mkdir -p $RB_OUT/reviews $RB_OUT/status $RB_OUT/logs $RB_CACHE
  if [[ -s $res ]] && has_verdict $res; then print "kept   $reviewer $build"; return 0; fi
  local head=$(<$in/head) clone=$RB_CACHE/$$-$key try=0 ok=0 started=$SECONDS
  rm -rf $clone
  git -c advice.detachedHead=false clone -q $ws $clone && git -C $clone -c advice.detachedHead=false checkout -q --detach $head && { [[ -z $RB_CASES ]] || git -C $clone apply $in/diff.txt; } || { print -u2 "clone failed for $key"; print -r -- "{\"reviewer\":\"$reviewer\",\"build\":\"$build\",\"tries\":0,\"ok\":false,\"seconds\":0,\"error\":\"clone failed\"}" > $st; return 1 }
  git -C $clone remote remove origin 2>/dev/null
  [[ -d $ws/node_modules ]] && ln -s $ws/node_modules $clone/node_modules
  mkdir -p $clone/.scratch; print ".scratch/" >> $clone/.git/info/exclude
  while (( try < RB_TRIES && ! ok )); do
    (( try++ )); (( try > 1 )) && sleep $RB_SLEEP
    : > $res.try
    case $reviewer in
      codex/*)
        ( cd $clone && { cat $in/brief.md; print; print '`````diff'; cat $in/diff.txt; print '`````'; } \
          | timeout $RB_TIMEOUT ${RB_CODEX:-codex} exec -m ${reviewer#codex/} -s read-only --skip-git-repo-check - > $res.try 2> $log.err ) ;;
      antigravity/*)
        local id=${reviewer#antigravity/}; [[ $id == gemini-3.1-pro ]] && id=gemini-3.1-pro-high
        timeout $RB_TIMEOUT node ${RB_AGY_REVIEW:-$repo/cli/agy-review.mjs} --model $id --brief $in/brief.md --diff $in/diff.txt --verdict $res.try --workspace $clone > $log.out 2> $log.err ;;
      claude-code/*)
        timeout $RB_TIMEOUT ${RB_CLAUDE:-$HOME/.local/bin/atelier-claude} ${reviewer#claude-code/} $in/brief.md $clone undefined $in/diff.txt $res.try > $log.out 2> $log.err ;;
    esac
    # A reply counts when the scorer's parser finds a verdict in it: one parser for collection, retention and scoring.
    has_verdict $res.try && ok=1 || cp $res.try $res.fail$try
  done
  if (( ok )); then mv $res.try $res; else rm -f $res.try; : > $res; fi
  print -r -- "{\"reviewer\":\"$reviewer\",\"build\":\"$build\",\"tries\":$try,\"ok\":$( (( ok )) && print true || print false ),\"seconds\":$(( SECONDS - started ))}" > $st
  [[ -n ${RB_KEEP:-} ]] || rm -rf $clone
  print "$( (( ok )) && print done || print FAILED) $reviewer $build (tries $try, $(( SECONDS - started ))s)"
}

# Parse the options of run.
parse() {
  RB_BAKE=~/Documents/ai-project-data/atelier/bake-2026-10-15
  RB_BUILDS=~/Library/Caches/ai-projects/atelier-bake
  RB_CACHE=~/Library/Caches/ai-projects/atelier-review-bake
  RB_TRIES=2 RB_SLEEP=120 RB_TIMEOUT=2400
  RB_CASES= RB_SOURCE=$repo
  sample= RB_OUT= reviewers= skip= dry=
  while (( $# )); do
    case $1 in
      --sample) sample=$2; shift 2 ;;
      --out) RB_OUT=${2:A}; shift 2 ;;
      --reviewers) reviewers=$2; shift 2 ;;
      --skip) skip=$2; shift 2 ;;
      --cases) RB_CASES=${2:A}; shift 2 ;;
      --source) RB_SOURCE=${2:A}; shift 2 ;;
      --bake) RB_BAKE=${2:A}; shift 2 ;;
      --builds) RB_BUILDS=${2:A}; shift 2 ;;
      --cache) RB_CACHE=${2:A}; shift 2 ;;
      --tries) RB_TRIES=$2; shift 2 ;;
      --retry-sleep) RB_SLEEP=$2; shift 2 ;;
      --timeout) RB_TIMEOUT=$2; shift 2 ;;
      --dry-run) dry=1; shift ;;
      *) die "unknown option $1" ;;
    esac
  done
  [[ -z $RB_CASES || -d $RB_CASES ]] || die "no case set $RB_CASES"
  [[ -z $sample && -n $RB_CASES ]] && sample=$RB_CASES/sample.txt
  export RB_BAKE RB_BUILDS RB_CACHE RB_TRIES RB_SLEEP RB_TIMEOUT RB_OUT RB_CASES RB_SOURCE
}

case $sub in
  one) RB_OUT=${RB_OUT:?} RB_CASES=${RB_CASES:-} RB_SOURCE=${RB_SOURCE:-$repo} ; one "$@"; exit $? ;;
  run)
    parse "$@"
    [[ -n $sample && -f $sample && -n $RB_OUT && -n $reviewers ]] || die "run needs --sample FILE (or --cases DIR), --out DIR and --reviewers LIST"
    builds=(${(f)"$(grep -vE '^\s*(#|$)' $sample | awk -F'\t' '{print $1}' | awk '{print $1}')"})
    (( ${#builds} )) || die "the sample lists no build"
    mkdir -p $RB_OUT
    # The output folder belongs to one case set: a rerun into it keeps old verdicts, so it must be the same cases.
    ident=none; [[ -n $RB_CASES ]] && { ident=$(node $here/review-bake-score.mjs --case-identity $RB_CASES) || die "cannot read the case set $RB_CASES"; }
    if [[ -f $RB_OUT/case-set.json ]]; then
      [[ $(<$RB_OUT/case-set.json) == $ident ]] || die "$RB_OUT holds reviews of another case set ($(<$RB_OUT/case-set.json)), not $ident; use a new --out"
    elif [[ -n $RB_CASES && -d $RB_OUT/reviews ]]; then
      die "$RB_OUT already holds reviews and records no case set; use a new --out"
    fi
    [[ -n $RB_CASES ]] && print -r -- $ident > $RB_OUT/case-set.json
    [[ ${sample:A} == $RB_OUT/sample.txt ]] || cp $sample $RB_OUT/sample.txt
    typeset -a run_list=() skipped=()
    for r in ${(s:,:)reviewers}; do
      reviewer_family $r >/dev/null || die "no such reviewer $r (codex/, antigravity/ or claude-code/ MODEL)"
      if [[ ,$skip, == *,$r,* ]]; then skipped+=($r); else run_list+=($r); fi
    done
    (( ${#skipped} )) && print -rl -- $skipped > $RB_OUT/skipped.txt && print "skipped (not run): ${skipped[*]}"
    for b in $builds; do prepare_inputs $b || die "inputs for $b"; done
    typeset -A lane
    for b in $builds; do for r in $run_list; do f=$(reviewer_family $r); lane[$f]+="$r $b"$'\n'; done; done
    if [[ -n $dry ]]; then for f in ${(k)lane}; do print "lane $f:"; print -r -- ${lane[$f]}; done; exit 0; fi
    # Every scheduled pair is recorded, so the scorer can count one that left no result as failed.
    for b in $builds; do for r in $run_list; do print -r -- "$r	$b"; done; done >> $RB_OUT/pairs.txt
    sort -u -o $RB_OUT/pairs.txt $RB_OUT/pairs.txt
    pids=()
    for f in ${(k)lane}; do
      case $f in codex) par=2 ;; antigravity) par=2 ;; *) par=1 ;; esac
      ( print -rn -- ${lane[$f]} | xargs -n2 -P$par zsh ${0:A} one ) &
      pids+=($!)
    done
    wait
    print "run finished: $(ls $RB_OUT/reviews | wc -l | tr -d ' ') review files in $RB_OUT/reviews"
    ;;
  score)
    exec node $here/review-bake-score.mjs "$@" ;;
  *) sed -n '2,/^set -u/p' $0 | sed '$d' | sed 's/^# \{0,1\}//'; exit 64 ;;
esac
