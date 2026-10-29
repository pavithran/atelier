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
# BACKUP.pub  the X25519 public key the backups are encrypted to; the
#             private key stays with the developer and never comes here
#
# DRYRUN=1 prints what would change and needs no root.
#
# As in setup-staging.sh and setup-tunnel.sh, the developer's sudo is the
# decision to trust these bytes once: they are copied into root-owned
# storage, checked there, and never run as root. What it makes:
# - /Users/atelierd/secrets/backup/: the R2 settings and the public key,
#   one file each, atelierd's alone (700, files 600). A directory apart from
#   secrets/ENV, so the server never reads the R2 credentials.
# - /Users/atelierd/backup-work/: atelierd's, 700, where a backup is packed
#   and encrypted before upload, and emptied after.
# - /Library/LaunchDaemons/zone.atelier.backup.ENV.plist, from
#   zone.atelier.backup.plist.template beside this script: node
#   server/cli/backup.mjs as atelierd, production at 03:00 local, staging at
#   03:30, so the two never run together.
# Then it runs the backup once, as atelierd through launchd, and waits for
# it to report the upload, so a wrong credential shows tonight and not at
# the first restore. No secret value is printed; the copies the developer
# gave are left for the developer to remove: root deletes nothing in a path
# the developer's user controls.
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
[ -f "$PUB_SRC" ] && [ ! -L "$PUB_SRC" ] || fail "no public key file at $PUB_SRC"
[ -f "$TEMPLATE" ] && [ ! -L "$TEMPLATE" ] || fail "no plist template at $TEMPLATE"

safe_dir() {
  local d=$1 owner
  [ -d "$d" ] && [ ! -L "$d" ] || fail "$d is not a plain directory"
  owner=$(stat -f %Su "$d")
  [ "$owner" = root ] || [ "$owner" = "$SVC" ] || fail "$d is owned by $owner"
  [ $(( 0$(stat -f %Lp "$d") & 022 )) = 0 ] || fail "$d is writable by a group or others"
  ! ls -lde "$d" | sed -n '2,$p' | grep -q . || fail "$d carries an ACL"
}
safe_dir /Library/LaunchDaemons
if ! dry; then
  dscl . -read /Users/$SVC >/dev/null 2>&1 || fail "$SVC does not exist; run setup-staging.sh first"
  safe_dir "$HOME_DIR"; safe_dir "$HOME_DIR/bin"; safe_dir "$HOME_DIR/server"; safe_dir "$HOME_DIR/secrets"; safe_dir "$HOME_DIR/log"
  safe_dir "$HOME_DIR/data/$ENV"; safe_dir "$HOME_DIR/repos/$ENV"
  [ -f "$HOME_DIR/server/cli/backup.mjs" ] && [ -f "$HOME_DIR/server/src/backup/backup.mjs" ] \
    || fail "the installed server has no cli/backup.mjs; install a release holding task 12 with setup-staging.sh first"
  [ "$(stat -f %Su "$HOME_DIR/server/cli/backup.mjs")" = root ] || fail "the installed server is not root's"
fi

WORK=$(mktemp -d /var/tmp/atelier-backup-setup.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

# 1. Inputs into root-owned storage, then checked there. Values are never
#    echoed: a failure names the setting, not what it held.
cp "$R2_SRC" "$WORK/r2.env"
cp "$PUB_SRC" "$WORK/BACKUP_PUBLIC_KEY"
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
if [ -e "$WORK/values/R2_PREFIX" ]; then LC_ALL=C grep -qxE '[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*/' "$WORK/values/R2_PREFIX" || fail "R2_PREFIX is not a path ending in /"; fi
# The public key: a PEM X25519 public key, and nothing private.
! LC_ALL=C grep -q 'PRIVATE KEY' "$WORK/BACKUP_PUBLIC_KEY" || fail "$PUB_SRC holds a private key; the private key never comes to the Studio. Give the .pub file"
# The system's LibreSSL knows no X25519, so the PEM is checked by its shape:
# an X25519 public key's DER is a fixed 12-byte prefix and 32 bytes, which in
# base64 is MCowBQYDK2VuAyEA, 43 more characters and one "=".
[ "$(sed -n '1p' "$WORK/BACKUP_PUBLIC_KEY")" = "-----BEGIN PUBLIC KEY-----" ] \
  && [ "$(sed -n '3p' "$WORK/BACKUP_PUBLIC_KEY")" = "-----END PUBLIC KEY-----" ] \
  && [ "$(wc -l < "$WORK/BACKUP_PUBLIC_KEY" | tr -d ' ')" = 3 ] \
  && sed -n '2p' "$WORK/BACKUP_PUBLIC_KEY" | LC_ALL=C grep -qxE 'MCowBQYDK2VuAyEA[A-Za-z0-9+/]{43}=' \
  || fail "$PUB_SRC is not an X25519 public key in PEM (node cli/backup.mjs keygen makes one)"
mv "$WORK/BACKUP_PUBLIC_KEY" "$WORK/values/BACKUP_PUBLIC_KEY"

# 2. The plist, from the template, checked field by field.
sed -e "s|@ENV@|$ENV|g" -e "s|@HOME@|$HOME_DIR|g" -e "s|@HOUR@|$HOUR|g" -e "s|@MINUTE@|$MINUTE|g" "$WORK/template" > "$WORK/plist"
plutil -lint "$WORK/plist" >/dev/null || fail "the backup plist does not parse"
x() { plutil -extract "$1" raw -o - "$WORK/plist" 2>/dev/null; }
[ "$(x Label)" = "$LABEL" ] && [ "$(x UserName)" = "$SVC" ] && [ "$(x GroupName)" = "$SVC" ] \
  && [ "$(x ProgramArguments.0)" = "$HOME_DIR/bin/node" ] && [ "$(x ProgramArguments.1)" = "$HOME_DIR/server/cli/backup.mjs" ] \
  && [ "$(x ProgramArguments.3)" = "$ENV" ] && [ "$(x ProgramArguments.5)" = "$HOME_DIR/data/$ENV" ] && [ "$(x ProgramArguments.7)" = "$HOME_DIR/repos/$ENV" ] && [ "$(x ProgramArguments.9)" = "$B" ] \
  && [ "$(x StartCalendarInterval.Hour)" = "$HOUR" ] && [ "$(x StartCalendarInterval.Minute)" = "$MINUTE" ] \
  && ! grep -q '@' "$WORK/plist" || fail "the plist made from the template is not the expected one"
[ ! -L "$PLIST" ] || fail "$PLIST is a link"

# 3. The backup job is stopped, and no backup of the service user's runs,
#    while root writes. What was there is kept, so a failure puts it back.
stopped=
snapshot=
was_loaded=
restore() {
  [ -n "$stopped" ] || return 0
  set +e
  echo "setup: putting the previous backup settings back" >&2
  launchctl print "system/$LABEL" >/dev/null 2>&1 && launchctl bootout "system/$LABEL" 2>/dev/null
  for _ in $(seq 1 20); do launchctl print "system/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
  if launchctl print "system/$LABEL" >/dev/null 2>&1; then echo "setup: $LABEL would not stop; nothing was restored" >&2; return 1; fi
  if pgrep -u "$SVC" -f "cli/backup.mjs" >/dev/null; then echo "setup: a backup of $SVC is running; nothing was restored" >&2; return 1; fi
  if ! ( safe_dir "$HOME_DIR" && safe_dir "$HOME_DIR/secrets" && safe_dir "$B" ) 2>/dev/null; then echo "setup: $B is not safe to write; nothing was restored" >&2; return 1; fi
  if [ -n "$snapshot" ]; then
    local name
    for name in $NAMES; do
      if [ -f "$WORK/old/$name" ]; then install -o "$SVC" -g "$SVC" -m 600 "$WORK/old/$name" "$B/$name" || echo "setup: could not restore $B/$name" >&2
      elif [ ! -L "$B/$name" ]; then rm -f "$B/$name" || echo "setup: could not remove $B/$name" >&2; fi
    done
  fi
  if [ -f "$WORK/old.plist" ]; then
    install -o root -g wheel -m 644 "$WORK/old.plist" "$PLIST" || echo "setup: could not restore $PLIST" >&2
    [ -z "$was_loaded" ] || launchctl bootstrap system "$PLIST" || echo "setup: the previous backup job did not load; sudo launchctl bootstrap system $PLIST" >&2
  else
    [ ! -f "$PLIST" ] || [ -L "$PLIST" ] || rm -f "$PLIST"
  fi
}
trap 'status=$?; [ $status = 0 ] || restore; rm -rf "$WORK"; exit $status' EXIT
if ! dry; then
  stopped=1
  if launchctl print "system/$LABEL" >/dev/null 2>&1; then
    was_loaded=1
    launchctl bootout "system/$LABEL" || fail "$LABEL would not stop"
    for _ in $(seq 1 20); do launchctl print "system/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
    ! launchctl print "system/$LABEL" >/dev/null 2>&1 || fail "$LABEL is still loaded"
  fi
  for _ in $(seq 1 60); do pgrep -u "$SVC" -f "cli/backup.mjs" >/dev/null || break; sleep 1; done
  ! pgrep -u "$SVC" -f "cli/backup.mjs" >/dev/null || fail "a backup of $SVC is still running; try again when it ends"
  [ ! -f "$PLIST" ] || cp "$PLIST" "$WORK/old.plist"
fi

# 4. Install. Directories are checked again now, and every target is
#    refused if it is a link.
for d in "$B" "$W"; do [ ! -L "$d" ] || fail "$d is a link"; done
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
run launchctl bootstrap system "$PLIST"

# 5. One backup now, as atelierd through launchd, bounded: the upload
#    reported, or the failure line shown.
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
