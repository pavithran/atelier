#!/bin/bash
# Atelier 2.0 on the Studio: puts a restored environment in place (plan task
# 12; docs/studio.md, "Restoring for real"). The backup is decrypted and
# restored on the developer's Mac with cli/restore.mjs, where the age
# identity is; the identity never comes to the Studio. The restored
# directories come here as one tar, and this script, run as root by the
# developer, who types the administrator password at sudo's prompt, installs
# them:
#
#   sudo bash setup-restore.sh ENV RESTORED.tar
#
# ENV           staging or production
# RESTORED.tar  made on the Mac from the directory holding the restored
#               data/ and repos/: tar -cf RESTORED.tar -C DIR data repos
#
# DRYRUN=1 prints what would change and needs no root.
#
# As in the other setup scripts, the developer's sudo is the decision to
# trust these bytes once: they are copied into root-owned storage, checked
# there, and never run. The order is setup-tunnel.sh's: everything prepared
# and checked first; then every atelierd job stops and no atelierd process
# may run while root writes, its directories checked again once it is quiet.
# The undo is recorded before the next step: the current data/ENV and
# repos/ENV are moved aside to ENV.before-restore-STAMP, never deleted, and
# the command that undoes the restore is printed before they move. A failure
# from then on puts them back and starts again the jobs that ran.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
umask 077

usage="usage: setup-restore.sh staging|production RESTORED.tar"
ENV=${1:?$usage}
TAR_SRC=${2:?$usage}
case "$ENV" in staging|production) ;; *) echo "setup: ENV is staging or production, not $ENV" >&2; exit 1 ;; esac

SVC=atelierd
HOME_DIR=/Users/$SVC
JOBS="zone.atelier.server.staging zone.atelier.server.production zone.atelier.tunnel zone.atelier.backup.staging zone.atelier.backup.production"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
D="$HOME_DIR/data/$ENV"
R="$HOME_DIR/repos/$ENV"
D_OLD="$D.before-restore-$STAMP"
R_OLD="$R.before-restore-$STAMP"

fail() { echo "setup: $*" >&2; exit 1; }
dry() { [ "${DRYRUN:-}" = 1 ]; }
run() { if dry; then printf '+ %s\n' "$*"; else "$@"; fi; }

dry || [ "$(id -u)" = 0 ] || fail "run as root (sudo), or DRYRUN=1"
[ -f "$TAR_SRC" ] && [ ! -L "$TAR_SRC" ] || fail "no restored tar at $TAR_SRC"

safe_dir() {
  local d=$1 owner
  [ -d "$d" ] && [ ! -L "$d" ] || fail "$d is not a plain directory"
  owner=$(stat -f %Su "$d")
  [ "$owner" = root ] || [ "$owner" = "$SVC" ] || fail "$d is owned by $owner"
  [ $(( 0$(stat -f %Lp "$d") & 022 )) = 0 ] || fail "$d is writable by a group or others"
  ! ls -lde "$d" | sed -n '2,$p' | grep -q . || fail "$d carries an ACL"
}
check_dirs() {
  safe_dir "$HOME_DIR"; safe_dir "$HOME_DIR/data"; safe_dir "$HOME_DIR/repos"
  [ ! -e "$D" ] || safe_dir "$D"
  [ ! -e "$R" ] || safe_dir "$R"
}
safe_dir /Library/LaunchDaemons
if ! dry; then
  dscl . -read /Users/$SVC >/dev/null 2>&1 || fail "$SVC does not exist; run setup-staging.sh first"
  check_dirs
fi
for p in "$D" "$R" "$D_OLD" "$R_OLD"; do [ ! -L "$p" ] || fail "$p is a link"; done
[ ! -e "$D_OLD" ] && [ ! -e "$R_OLD" ] || fail "$D_OLD or $R_OLD exists already"

WORK=$(mktemp -d /var/tmp/atelier-restore-setup.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

# 1. The tar into root-owned storage, then checked there: plain files and
#    directories under data/ and repos/ only, nothing outside itself.
cp "$TAR_SRC" "$WORK/restored.tar"
tar -tvf "$WORK/restored.tar" > "$WORK/list-long" || fail "the tar cannot be listed"
tar -tf "$WORK/restored.tar" > "$WORK/list" || fail "the tar cannot be listed"
[ -s "$WORK/list" ] || fail "the tar is empty"
if awk '{t=substr($1,1,1); if (t!="-" && t!="d") bad=1} END {exit bad?0:1}' "$WORK/list-long"; then fail "the tar holds something other than files and directories"; fi
if grep -E '(^/|(^|/)\.\.(/|$))' "$WORK/list" >/dev/null; then fail "the tar names a path outside itself"; fi
if grep -vE '^(\./)?(data|repos)(/|$)' "$WORK/list" >/dev/null; then fail "the tar holds something besides data/ and repos/"; fi
mkdir "$WORK/x"
tar -xf "$WORK/restored.tar" --no-same-owner --no-same-permissions -C "$WORK/x"
X="$WORK/x"
[ -f "$X/data/ledgers/__index.sqlite" ] || fail "the restored data has no ledgers/__index.sqlite"
[ -d "$X/repos" ] || fail "the tar has no repos/"
# Every database passes SQLite's integrity check, and every project the
# index registers has its Ledger.
find "$X/data" -name '*.sqlite' -type f > "$WORK/dbs"
while IFS= read -r db; do
  [ "$(sqlite3 -readonly "$db" 'PRAGMA integrity_check' 2>/dev/null)" = ok ] || fail "${db#$X/} fails SQLite's integrity check"
done < "$WORK/dbs"
sqlite3 -readonly "$X/data/ledgers/__index.sqlite" "SELECT coalesce(json_extract(json, '\$.key'), name) FROM projects" > "$WORK/keys" 2>/dev/null || fail "the restored index cannot be read"
while IFS= read -r key; do
  # A Ledger's file name is "project:KEY" percent-encoded (fileName in
  # src/runtime/namespace.mjs); each candidate is decoded and compared.
  found=
  for f in "$X/data/ledgers/"project%3A*.sqlite; do
    n=$(basename "$f" .sqlite)
    [ "$(printf '%b' "$(printf '%s' "$n" | sed 's/%\(..\)/\\x\1/g')")" = "project:$key" ] && { found=1; break; }
  done
  [ -n "$found" ] || fail "the restored index registers $key, whose Ledger is missing"
done < "$WORK/keys"
for repo in "$X/repos"/*; do
  [ -e "$repo" ] || continue
  case "$(basename "$repo")" in *.git) [ -f "$repo/HEAD" ] || fail "${repo#$X/} is not a bare repository" ;; *) fail "${repo#$X/} is not a KEY.git repository" ;; esac
done

# What ran, recorded before recovery is armed.
loaded=
if ! dry; then
  for job in $JOBS; do
    if launchctl print "system/$job" >/dev/null 2>&1; then
      [ -f "/Library/LaunchDaemons/$job.plist" ] && [ ! -L "/Library/LaunchDaemons/$job.plist" ] || fail "$job is loaded but its plist is missing or a link"
      loaded="$loaded $job"
    fi
  done
fi

stop_all() {
  local job
  for job in $JOBS; do
    launchctl print "system/$job" >/dev/null 2>&1 || continue
    launchctl bootout "system/$job" 2>/dev/null
    for _ in $(seq 1 20); do launchctl print "system/$job" >/dev/null 2>&1 || break; sleep 0.5; done
    if launchctl print "system/$job" >/dev/null 2>&1; then echo "setup: $job would not stop" >&2; return 1; fi
  done
  for _ in $(seq 1 60); do pgrep -u "$SVC" >/dev/null || break; sleep 0.5; done
  if pgrep -u "$SVC" >/dev/null; then echo "setup: a process of $SVC is still running" >&2; return 1; fi
}
start_loaded() {
  local job rc=0
  for job in $JOBS; do
    case " $loaded " in *" $job "*) launchctl bootstrap system "/Library/LaunchDaemons/$job.plist" || { echo "setup: $job did not start; sudo launchctl bootstrap system /Library/LaunchDaemons/$job.plist" >&2; rc=1; } ;; esac
  done
  return $rc
}
stopped=
moved=
restore() {
  [ -n "$stopped" ] || return 0
  set +e
  echo "setup: putting the previous $ENV data and repositories back" >&2
  if ! stop_all; then echo "setup: nothing was put back" >&2; return 1; fi
  if ! ( check_dirs ) 2>/dev/null; then echo "setup: a directory of $SVC is not safe to write; nothing was put back" >&2; return 1; fi
  if [ -n "$moved" ]; then
    local p
    for p in "$D:$D_OLD" "$R:$R_OLD"; do
      local cur=${p%%:*} old=${p#*:}
      if [ -d "$old" ] && [ ! -L "$old" ]; then
        [ ! -e "$cur" ] || [ -L "$cur" ] || rm -rf "$cur"
        mv "$old" "$cur" || echo "setup: could not move $old back to $cur" >&2
      fi
    done
  fi
  start_loaded
}
trap 'status=$?; [ $status = 0 ] || restore; rm -rf "$WORK"; exit $status' EXIT

# 2. Everything of atelierd's stops; its directories are checked again.
if ! dry; then
  stopped=1
  stop_all || fail "the $SVC jobs could not all be stopped"
  check_dirs
fi

# 3. The undo, recorded before the next step, then the move aside.
echo "to undo this restore: stop the $SVC jobs, then move $D_OLD back to $D and $R_OLD back to $R"
[ ! -e "$D" ] || run mv "$D" "$D_OLD"
[ ! -e "$R" ] || run mv "$R" "$R_OLD"
moved=1

# 4. The restored directories in place, atelierd's, directories 700 and
#    files 600.
run cp -R "$X/data" "$D"
run cp -R "$X/repos" "$R"
run chown -R "$SVC:$SVC" "$D" "$R"
run chmod -R u=rwX,go= "$D" "$R"
if ! dry; then
  find "$D" "$R" -type f -exec chmod 600 {} +
  safe_dir "$D"; safe_dir "$R"
fi

# 5. The jobs that ran start again.
if dry; then echo "+ (start again the atelierd jobs that were loaded)"; else start_loaded || fail "a job that was running did not start again"; fi
stopped=
echo "the restored $ENV data and repositories are in place; the previous ones are kept as $D_OLD and $R_OLD"
