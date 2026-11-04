# Source from the atelier-build control loop. Both arguments name loop functions:
# a predicate that checks all builders are idle, and a restart function that
# returns success only after all builder runners have been restarted.
refresh_build_runners() (
  [ "$(id -un)" = atelier-build ] || return 1
  [ "$#" = 2 ] || return 1
  export TMPDIR=/Users/atelier-build/tmp
  flags=/Users/atelier-build/flags
  head=$(cat "$flags/runner-refresh.head") || return 1
  case "$head" in ''|*[!0-9a-f]*) return 1 ;; esac
  [ "${#head}" = 40 ] || return 1
  applied=$(cat "$flags/runner-refresh.applied" 2>/dev/null) || applied=
  [ "$head" != "$applied" ] || return 0
  "$1" || return 0
  cd /Users/atelier-build/ai-projects/atelier-runner || return 1
  git fetch "$flags/runner-refresh.bundle" HEAD || return 1
  [ "$(git rev-parse FETCH_HEAD)" = "$head" ] || return 1
  git reset --hard "$head" || return 1
  npm ci || return 1
  "$2" || return 1
  printf '%s\n' "$head" > "$flags/runner-refresh.applied.next" || return 1
  mv -f "$flags/runner-refresh.applied.next" "$flags/runner-refresh.applied"
)
