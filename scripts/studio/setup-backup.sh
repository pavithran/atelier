#!/bin/bash
# Atelier 2.0 on the Studio: the nightly encrypted backup of one environment
# to Cloudflare R2 (design-branches-2026-10-28.md, section 4.9, with R2 in
# place of the home server on PAVI's decision; plan task 12; docs/studio.md).
# Run as root on the Studio, after setup-staging.sh has installed a server
# release holding cli/backup.mjs, by the developer, who types the
# administrator password at sudo's prompt:
#
#   sudo bash setup-backup.sh ENV R2.env BACKUP.pub
#
# ENV         staging or production
# R2.env      the R2 settings, one KEY=VALUE per line:
#               R2_ENDPOINT=https://ACCOUNT.r2.cloudflarestorage.com
#               R2_BUCKET=atelier-backups
#               R2_ACCESS_KEY_ID=...        (an R2 API token's S3 key id)
#               R2_SECRET_ACCESS_KEY=...    (and its secret)
#               R2_PREFIX=atelier/ENV/      (optional)
# BACKUP.pub  the age recipient (age1...) the backups are encrypted to; the
#             identity stays on the developer's Mac and never comes here
#
# DRYRUN=1 prints what would change and needs no root.
#
# As in setup-staging.sh and setup-tunnel.sh, the developer's sudo is the
# decision to trust these bytes once: they are copied into root-owned
# storage, checked there, and never run as root. What it makes:
# - /Users/atelierd/secrets/backup/: the R2 settings and the recipient, one
#   file each, atelierd's alone (700, files 600). A directory apart from
#   secrets/ENV, so the server never reads the R2 credentials.
# - /Users/atelierd/backup-work/: atelierd's, 700, where a backup is packed
#   and encrypted before upload, and emptied after.
# - /Library/LaunchDaemons/zone.atelier.backup.ENV.plist, from
#   zone.atelier.backup.plist.template beside this script: node
#   server/cli/backup.mjs as atelierd, production at 03:00 local, staging at
#   03:30, so the two never run together.
#
# The order is setup-tunnel.sh's: everything is prepared and checked first;
# then every atelierd job stops and no atelierd process may run while root
# writes in its directories, which are checked again once it is quiet; a
# failure from then on puts back what was there, under the same rules. The
# jobs that ran are started again, and one backup runs at once, as atelierd
# through launchd, so a wrong credential shows tonight and not at the first
# restore. No secret value is printed; the copies the developer gave are left
# for the developer to remove: root deletes nothing in a path the developer's
# user controls.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
umask 077

usage="usage: setup-backup.sh staging|production R2.env BACKUP.pub"
ENV=${1:?$usage}
R2_SRC=${2:?$usage}
PUB_SRC=${3:?$usage}

SVC=atelierd
HOME_DIR=/Users/$SVC
case "$ENV" in
  production) HOUR=3; MINUTE=0 ;;
  staging) HOUR=3; MINUTE=30 ;;
  *) echo "setup: ENV is staging or production, not $ENV" >&2; exit 1 ;;
esac
LABEL=zone.atelier.backup.$ENV
PLIST=/Library/LaunchDaemons/$LABEL.plist
# Every job that runs as atelierd, in the order they start: the servers,
# then the tunnel in front of them, then the backups.
JOBS="zone.atelier.server.staging zone.atelier.server.production zone.atelier.tunnel zone.atelier.backup.staging zone.atelier.backup.production"
TEMPLATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/zone.atelier.backup.plist.template"
B="$HOME_DIR/secrets/backup"
W="$HOME_DIR/backup-work"
LOG="$HOME_DIR/log/backup-$ENV.log"
NAMES="R2_ENDPOINT R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_PREFIX BACKUP_PUBLIC_KEY"

fail() { echo "setup: $*" >&2; exit 1; }
dry() { [ "${DRYRUN:-}" = 1 ]; }
run() { if dry; then printf '+ %s\n' "$*"; else "$@"; fi; }

dry || [ "$(id -u)" = 0 ] || fail "run as root (sudo), or DRYRUN=1"
[ -f "$R2_SRC" ] && [ ! -L "$R2_SRC" ] || fail "no R2 settings file at $R2_SRC"
[ -f "$PUB_SRC" ] && [ ! -L "$PUB_SRC" ] || fail "no recipient file at $PUB_SRC"
[ -f "$TEMPLATE" ] && [ ! -L "$TEMPLATE" ] || fail "no plist template at $TEMPLATE"

safe_dir() {
  local d=$1 owner
  [ -d "$d" ] && [ ! -L "$d" ] || fail "$d is not a plain directory"
  owner=$(stat -f %Su "$d")
  [ "$owner" = root ] || [ "$owner" = "$SVC" ] || fail "$d is owned by $owner"
  [ $(( 0$(stat -f %Lp "$d") & 022 )) = 0 ] || fail "$d is writable by a group or others"
  ! ls -lde "$d" | sed -n '2,$p' | grep -q . || fail "$d carries an ACL"
}
# The directories this script writes in or relies on, existing ones only for
# the two it creates.
check_dirs() {
  safe_dir "$HOME_DIR"; safe_dir "$HOME_DIR/bin"; safe_dir "$HOME_DIR/server"; safe_dir "$HOME_DIR/secrets"; safe_dir "$HOME_DIR/log"
  safe_dir "$HOME_DIR/data/$ENV"; safe_dir "$HOME_DIR/repos/$ENV"
  [ ! -e "$B" ] || safe_dir "$B"
  [ ! -e "$W" ] || safe_dir "$W"
}
safe_dir /Library/LaunchDaemons
if ! dry; then
  dscl . -read /Users/$SVC >/dev/null 2>&1 || fail "$SVC does not exist; run setup-staging.sh first"
  check_dirs
  [ -f "$HOME_DIR/server/cli/backup.mjs" ] && [ -f "$HOME_DIR/server/src/backup/age.mjs" ] \
    || fail "the installed server has no cli/backup.mjs; install a release holding task 12 with setup-staging.sh first"
  [ "$(stat -f %Su "$HOME_DIR/server/cli/backup.mjs")" = root ] || fail "the installed server is not root's"
fi

WORK=$(mktemp -d /var/tmp/atelier-backup-setup.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

# 1. Inputs into root-owned storage, then checked there. Values are never
#    echoed: a failure names the setting, not what it held.
cp "$R2_SRC" "$WORK/r2.env"
cp "$PUB_SRC" "$WORK/recipient"
cp "$TEMPLATE" "$WORK/template"
[ "$(LC_ALL=C tr -d '\000' < "$WORK/r2.env" | wc -c)" = "$(wc -c < "$WORK/r2.env")" ] || fail "the R2 settings hold a NUL byte"
mkdir "$WORK/values"
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%$'\r'}
  case "$line" in ''|'#'*) continue ;; esac
  key=${line%%=*}
  value=${line#*=}
  [ "$key" != "$line" ] || fail "a line of the R2 settings is not KEY=VALUE"
  case " R2_ENDPOINT R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_PREFIX " in
    *" $key "*) ;;
    *) fail "the R2 settings name $key, which is not one of R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PREFIX" ;;
  esac
  [ ! -e "$WORK/values/$key" ] || fail "the R2 settings name $key twice"
  printf '%s\n' "$value" > "$WORK/values/$key"
done < "$WORK/r2.env"
for key in R2_ENDPOINT R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do [ -s "$WORK/values/$key" ] || fail "the R2 settings lack $key"; done
LC_ALL=C grep -qxE 'https://[0-9a-f]{32}(\.(eu|fedramp))?\.r2\.cloudflarestorage\.com' "$WORK/values/R2_ENDPOINT" || fail "R2_ENDPOINT is not https://ACCOUNT.r2.cloudflarestorage.com"
LC_ALL=C grep -qxE '[a-z0-9][a-z0-9-]{1,61}[a-z0-9]' "$WORK/values/R2_BUCKET" || fail "R2_BUCKET is not a bucket name"
LC_ALL=C grep -qxE '[0-9a-f]{32}' "$WORK/values/R2_ACCESS_KEY_ID" || fail "R2_ACCESS_KEY_ID is not an R2 access key id (32 hex characters)"
LC_ALL=C grep -qxE '[0-9a-f]{64}' "$WORK/values/R2_SECRET_ACCESS_KEY" || fail "R2_SECRET_ACCESS_KEY is not an R2 secret access key (64 hex characters)"
# The prefix: segments of letters, digits, '.', '_' and '-', none "." or "..".
if [ -e "$WORK/values/R2_PREFIX" ]; then
  LC_ALL=C grep -qxE '[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*/' "$WORK/values/R2_PREFIX" \
    && ! LC_ALL=C grep -qE '(^|/)\.{1,2}/' "$WORK/values/R2_PREFIX" || fail "R2_PREFIX is not a path of plain segments ending in /"
fi
# The recipient: one age1 line, and nothing secret.
! LC_ALL=C grep -qi 'AGE-SECRET-KEY' "$WORK/recipient" || fail "$PUB_SRC holds an age identity; the identity never comes to the Studio. Give the .pub file"
[ "$(grep -cv '^#' "$WORK/recipient" || true)" = 1 ] && grep -v '^#' "$WORK/recipient" | LC_ALL=C grep -qxE 'age1[02-9ac-hj-np-z]{58}' \
  || fail "$PUB_SRC is not an age recipient (age1..., as cli/backup.mjs keygen writes it)"
grep -v '^#' "$WORK/recipient" > "$WORK/values/BACKUP_PUBLIC_KEY"

# 2. The plist, from the template, checked field by field.
sed -e "s|@ENV@|$ENV|g" -e "s|@HOME@|$HOME_DIR|g" -e "s|@HOUR@|$HOUR|g" -e "s|@MINUTE@|$MINUTE|g" "$WORK/template" > "$WORK/plist"
plutil -lint "$WORK/plist" >/dev/null || fail "the backup plist does not parse"
x() { plutil -extract "$1" raw -o - "$WORK/plist" 2>/dev/null; }
[ "$(x Label)" = "$LABEL" ] && [ "$(x UserName)" = "$SVC" ] && [ "$(x GroupName)" = "$SVC" ] \
  && [ "$(x ProgramArguments.0)" = "$HOME_DIR/bin/node" ] && [ "$(x ProgramArguments.1)" = "$HOME_DIR/server/cli/backup.mjs" ] \
  && [ "$(x ProgramArguments.3)" = "$ENV" ] && [ "$(x ProgramArguments.5)" = "$HOME_DIR/data/$ENV" ] \
  && [ "$(x ProgramArguments.7)" = "$HOME_DIR/repos/$ENV" ] && [ "$(x ProgramArguments.9)" = "$B" ] && [ "$(x ProgramArguments.11)" = "$W" ] \
  && [ "$(x StartCalendarInterval.Hour)" = "$HOUR" ] && [ "$(x StartCalendarInterval.Minute)" = "$MINUTE" ] \
  && ! grep -q '@' "$WORK/plist" || fail "the plist made from the template is not the expected one"
[ ! -L "$PLIST" ] || fail "$PLIST is a link"
for job in $JOBS; do [ ! -L "/Library/LaunchDaemons/$job.plist" ] || fail "/Library/LaunchDaemons/$job.plist is a link"; done

# What was there, recorded before recovery is armed: the previous plist, and
# which jobs were loaded, so recovery starts the same ones again.
had_plist=
if [ -f "$PLIST" ]; then cp "$PLIST" "$WORK/old.plist"; had_plist=1; fi
loaded=
if ! dry; then
  for job in $JOBS; do
    if launchctl print "system/$job" >/dev/null 2>&1; then
      [ -f "/Library/LaunchDaemons/$job.plist" ] || fail "$job is loaded but /Library/LaunchDaemons/$job.plist is missing; it could not be started again"
      loaded="$loaded $job"
    fi
  done
fi

# 3. Stop every atelierd job and confirm nothing of the service user's runs.
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
# Starts the jobs that were loaded, in order, from their plists as they are.
start_loaded() {
  local job rc=0
  for job in $JOBS; do
    case " $loaded " in *" $job "*) launchctl bootstrap system "/Library/LaunchDaemons/$job.plist" || { echo "setup: $job did not start; sudo launchctl bootstrap system /Library/LaunchDaemons/$job.plist" >&2; rc=1; } ;; esac
  done
  return $rc
}
stopped=
snapshot=
restore() {
  [ -n "$stopped" ] || return 0
  # Recovery decides by its own checks, not by set -e, and writes only
  # under the install's rules: everything stopped, nothing of the service
  # user's running, its directories safe. Short of that it changes nothing
  # and says so.
  set +e
  echo "setup: putting the previous backup settings back" >&2
  if ! stop_all; then echo "setup: nothing was restored" >&2; return 1; fi
  if ! ( check_dirs ) 2>/dev/null; then echo "setup: a directory of $SVC is not safe to write; nothing was restored" >&2; return 1; fi
  if [ -n "$snapshot" ]; then
    local name
    for name in $NAMES; do
      if [ -f "$WORK/old/$name" ]; then install -o "$SVC" -g "$SVC" -m 600 "$WORK/old/$name" "$B/$name" || echo "setup: could not restore $B/$name" >&2
      elif [ -d "$B" ] && [ ! -L "$B/$name" ]; then rm -f "$B/$name" || echo "setup: could not remove $B/$name" >&2; fi
    done
  fi
  if [ -n "$had_plist" ]; then install -o root -g wheel -m 644 "$WORK/old.plist" "$PLIST" || echo "setup: could not restore $PLIST" >&2
  elif [ -f "$PLIST" ] && [ ! -L "$PLIST" ]; then rm -f "$PLIST"; fi
  start_loaded
}
trap 'status=$?; [ $status = 0 ] || restore; rm -rf "$WORK"; exit $status' EXIT
if ! dry; then
  stopped=1
  stop_all || fail "the $SVC jobs could not all be stopped"
fi

# 4. Install, the service user stopped. Its directories are checked again
#    now that nothing of it runs, and every target is refused if it is a link.
if ! dry; then
  check_dirs
  for d in "$B" "$W"; do [ ! -L "$d" ] || fail "$d is a link"; done
fi
run mkdir -p "$B" "$W"
run chown "$SVC:$SVC" "$B" "$W"
run chmod 700 "$B" "$W"
if ! dry; then
  safe_dir "$B"; safe_dir "$W"
  mkdir "$WORK/old"
  for name in $NAMES; do
    [ ! -L "$B/$name" ] || fail "$B/$name is a link"
    [ ! -f "$B/$name" ] || cp "$B/$name" "$WORK/old/$name"
  done
  snapshot=1
fi
for name in $NAMES; do
  if [ -f "$WORK/values/$name" ]; then run install -o "$SVC" -g "$SVC" -m 600 "$WORK/values/$name" "$B/$name"
  elif [ -e "$B/$name" ]; then run rm -f "$B/$name"; fi
done
for f in "$LOG" "$LOG.prev"; do [ ! -L "$f" ] || fail "$f is a link"; done
# This run's log starts empty, so the check below reads this run alone.
[ ! -e "$LOG" ] || run mv -f "$LOG" "$LOG.prev"
run install -o root -g wheel -m 644 "$WORK/plist" "$PLIST"

# 5. The jobs that ran start again, and this backup job loads; then one
#    backup runs now, bounded: the upload reported, or the failure shown.
if dry; then
  echo "+ (start again the atelierd jobs that were loaded)"
else
  start_loaded || fail "a job that was running did not start again"
fi
case " $loaded " in *" $LABEL "*) ;; *) run launchctl bootstrap system "$PLIST" ;; esac
run launchctl kickstart "system/$LABEL"
if ! dry; then
  ok=
  for _ in $(seq 1 300); do
    if grep -q "uploaded .* encrypted bytes to " "$LOG" 2>/dev/null && grep -q "kept .* days: deleted" "$LOG" 2>/dev/null; then ok=1; break; fi
    grep -q "backup of $ENV failed:" "$LOG" 2>/dev/null && break
    sleep 1
  done
  if [ -z "$ok" ]; then
    grep "backup of $ENV failed:" "$LOG" 2>/dev/null | tail -1 >&2 || true
    fail "the first backup did not report its upload in 300 s; see $LOG (sudo tail)"
  fi
  stopped=
  grep "uploaded .* encrypted bytes to " "$LOG" | tail -1
  echo "the $ENV backup runs nightly at $(printf '%02d:%02d' "$HOUR" "$MINUTE") as $SVC; the first one is in R2"
fi
