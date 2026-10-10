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
# under the queue folder as tN.log.
#
# The queue file is $ATELIER_CACHE/land-queue/PROJECT.queue (one
# "tN:harness/model" per line). Append to it to add a landing while the queue
# runs; edit it to reorder. The script exits after LAND_QUEUE_IDLE seconds
# (default 7200) with nothing queued.
#
# This is a workaround: a queue of landings kept by the server, so that a
# session submits a task and its reviewer and the landings run in turn, is the
# feature that replaces it (t432).
set -u
project=${ATELIER_PROJECT:-atelier}
cache=${ATELIER_CACHE:-$HOME/Library/Caches/ai-projects/cloudflare-git}
dir=$cache/land-queue; mkdir -p "$dir"
queue=$dir/$project.queue; touch "$queue"
limit=${LAND_QUEUE_LOAD:-25}; idle_limit=${LAND_QUEUE_IDLE:-7200}
cli=${ATELIER_CLI:-node cli/atelier.mjs}
for x in "$@"; do print -r -- "$x" >> "$queue"; done

# The five-minute load average: macOS prints "{ 1m 5m 15m }", Linux "1m 5m 15m ...".
load5() { if [[ -r /proc/loadavg ]]; then awk '{print int($2)}' /proc/loadavg; else sysctl -n vm.loadavg | awk '{print int($3)}'; fi; }

idle=0
while (( idle < idle_limit )); do
  if [[ ! -s $queue ]]; then sleep 20; (( idle += 20 )); continue; fi
  idle=0
  next=$(head -1 "$queue"); sed -i.bak 1d "$queue" && rm -f "$queue.bak"
  t=${next%%:*} reviewer=${next#*:}
  until (( $(load5) < limit )); do sleep 30; done
  ${=cli} land "$t" --project "$project" --workflow --wait --reviewer "$reviewer" > "$dir/$t.log" 2>&1
  out=$(sed 's/\x1b\[[0-9;]*m//g' "$dir/$t.log" | grep -E "landed through|failed:|conflict stage|route level|can no longer be read|FAIL " | tail -1)
  print -r -- "LANDQ $t: ${out:0:300}"
done
print -r -- "LANDQ idle: nothing queued for $((idle_limit / 60)) minutes; exiting"
