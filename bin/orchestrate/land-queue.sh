#!/bin/zsh
# land-queue.sh [TASK:HARNESS/MODEL ...]: lands tasks one after another.
#
# Run it from the project's registered checkout, as one long-lived background
# job. Each argument, and each line later appended to the queue file, names a
# task and the reviewer for its landing. One landing runs at a time, and each
# waits until the machine's five-minute load average is under LAND_QUEUE_LOAD
# (default 25), so a landing's checks do not run beside a dozen others.
#
# Each landing prints exactly one line, "LANDQ tN: OUTCOME", for a watcher to
# match: landed, paused at its conflict stage, rejected by the reviewer,
# refused on route level, or failed. The full output of each landing is kept
# under the queue folder as tN.log. A successful workflow then runs the
# synchronous post-merge.sh barrier (or LAND_QUEUE_POST_MERGE executable).
# Its failure retains PROJECT.queue.post-merge; restart retries it before
# taking another task. Its output is tN.post-merge.log. Run only one consumer.
#
# The queue file is $ATELIER_CACHE/land-queue/PROJECT.queue (one
# "tN:harness/model" per line). Add a landing while the queue runs with
#   land-queue.sh --add TASK:HARNESS/MODEL ...
# which takes the queue's lock (the directory PROJECT.queue.lock), as the
# script does to take the first line, so no addition is lost. Do not append
# with a bare >>: it does not take the lock. To reorder, hold the lock
# yourself (mkdir the lock directory, edit, rmdir it). The script exits after
# LAND_QUEUE_IDLE seconds (default 7200) with nothing queued; LAND_QUEUE_POLL
# (default 20) is the seconds between looks at an empty queue.
#
# This is a workaround: a queue of landings kept by the server, so that a
# session submits a task and its reviewer and the landings run in turn, is the
# feature that replaces it (t460, which superseded t432).
set -u
project=${ATELIER_PROJECT:-atelier}
cache=${ATELIER_CACHE:-$HOME/Library/Caches/ai-projects/cloudflare-git}
dir=$cache/land-queue; mkdir -p "$dir"
queue=$dir/$project.queue; touch "$queue"
limit=${LAND_QUEUE_LOAD:-25}; idle_limit=${LAND_QUEUE_IDLE:-7200}
cli=${ATELIER_CLI:-node cli/atelier.mjs}
poll=${LAND_QUEUE_POLL:-20}
lock=$queue.lock
pending=$queue.post-merge
post_merge=${LAND_QUEUE_POST_MERGE:-${0:A:h}/post-merge.sh}

# lock_queue / unlock_queue: mkdir is atomic, so one process holds the lock.
# A lock whose owner's pid is gone is taken over.
lock_queue() {
  until mkdir "$lock" 2>/dev/null; do
    pid=$(cat "$lock/pid" 2>/dev/null)
    if [[ -n $pid ]] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$lock"; continue; fi
    sleep 0.05
  done
  print -r -- $$ > "$lock/pid"
}
unlock_queue() { rm -rf "$lock"; }
enqueue() { lock_queue; for x in "$@"; do print -r -- "$x" >> "$queue"; done; unlock_queue; }

if [[ ${1:-} == --add ]]; then shift; enqueue "$@"; exit 0; fi
enqueue "$@"

# The five-minute load average: macOS prints "{ 1m 5m 15m }", Linux "1m 5m 15m ...".
load5() { if [[ -r /proc/loadavg ]]; then awk '{print int($2)}' /proc/loadavg; else sysctl -n vm.loadavg | awk '{print int($3)}'; fi; }

# Persist the barrier across exits/restarts. A failing hook leaves the next
# task in the queue; restarting retries the hook, never the landed task.
finish_merge() {
  [[ -f $pending ]] || return 0
  local task=$(cat "$pending")
  if "$post_merge" "$task" > "$dir/$task.post-merge.log" 2>&1; then
    rm -f "$pending"
    print -r -- "LANDQ $task: post-merge complete"
  else
    print -r -- "LANDQ $task: post-merge blocked; read $dir/$task.post-merge.log and restart after fixing it"
    return 1
  fi
}
finish_merge || exit 1
idle=0
while (( idle < idle_limit )); do
  lock_queue
  next=$(head -1 "$queue"); tail -n +2 "$queue" > "$queue.new"; cat "$queue.new" > "$queue"; rm -f "$queue.new"
  unlock_queue
  if [[ -z $next ]]; then sleep $poll; (( idle += poll )); continue; fi
  idle=0
  t=${next%%:*} reviewer=${next#*:}
  until (( $(load5) < limit )); do sleep 30; done
  ${=cli} land "$t" --project "$project" --workflow --wait --reviewer "$reviewer" > "$dir/$t.log" 2>&1
  out=$(sed 's/\x1b\[[0-9;]*m//g' "$dir/$t.log" | grep -E "landed through|failed:|conflict stage|route level|can no longer be read|FAIL " | tail -1)
  # Match the CLI's completion message, not just its exit status (a paused
  # workflow may also exit successfully).
  if [[ $out == *"landed through the landing Workflow"* ]]; then
    print -r -- "$t" > "$pending"
  fi
  print -r -- "LANDQ $t: ${out:0:300}"
  finish_merge || exit 1
done
print -r -- "LANDQ idle: nothing queued for $((idle_limit / 60)) minutes; exiting"
