# Shared by the orchestration scripts: where a project's registered checkout
# and a task's workspace are on this machine, read from the Atelier CLI's own
# config and cache, so nothing here names one machine's paths.
ATELIER_CONFIG_DIR=${ATELIER_CONFIG_DIR:-$HOME/.config/atelier}
ATELIER_CACHE=${ATELIER_CACHE:-$HOME/Library/Caches/ai-projects/cloudflare-git}
ATELIER_PROJECT=${ATELIER_PROJECT:-atelier}

# checkout_of NAME: the registered checkout's path, from config.json.
checkout_of() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["projects"][sys.argv[2]]["path"])' \
    "$ATELIER_CONFIG_DIR/config.json" "$1" 2>/dev/null || { echo "no registered checkout for $1 in $ATELIER_CONFIG_DIR/config.json" >&2; return 1; }
}

# workspace_of NAME ID: the task's workspace, where atelier claim made it.
workspace_of() { echo "$ATELIER_CACHE/work/$1/$2"; }

# project_of WORKSPACE: the project a workspace belongs to, from its Git config.
project_of() { git -C "$1" config --local atelier.project; }

# fork_point WORKSPACE MAIN PROJECT: the commit a task's workspace forked from,
# for review.sh. WORKSPACE has just fetched MAIN's main into FETCH_HEAD. Where
# the two share history that is their merge base. A project whose baseline was
# built with --history-since starts at its own root commit, so the workspace
# shares no commit with the checkout; then the fork point is the newest commit
# of the workspace's history that the checkout's baseline map (git dir,
# atelier-baseline-map.json, baseline commit to project commit) lists, that
# is, the baseline's main as the task last saw it. With neither, it says so
# on standard error and fails, so nothing is written from a missing base (t688).
fork_point() {
  local ws=$1 main=$2 project=$3 base map key
  local -a held
  base=$(git -C "$ws" merge-base HEAD FETCH_HEAD 2>/dev/null) || base=
  if [ -n "$base" ]; then echo "$base"; return 0; fi
  map=$(git -C "$main" rev-parse --absolute-git-dir 2>/dev/null)/atelier-baseline-map.json
  if [ -f "$map" ]; then
    for key in $(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1])).get(sys.argv[2], {})))' "$map" "$project" 2>/dev/null); do
      git -C "$ws" merge-base --is-ancestor "$key" HEAD 2>/dev/null && held+=("$key")
    done
  fi
  if [ ${#held[@]} -gt 0 ]; then
    git -C "$ws" merge-base --independent "${held[@]}" | head -1
    return 0
  fi
  echo "review.sh: the workspace $ws shares no commit with $project's main in $main, and $map pairs none of the workspace's commits; the project's baseline was probably built with --history-since and this checkout has not pulled it (run atelier pull in the checkout), or set MAIN_REPO to a clone that holds the task's fork point" >&2
  return 1
}
