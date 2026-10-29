#!/bin/bash
# Atelier 2.0 on the Studio: install a release of the server, or roll back to
# the one before (design-branches-2026-10-28.md, section 4.1; plan task 9).
# `atelier ship` runs it under sudo, from the release already installed:
#
#   sudo /bin/bash /Users/atelierd/SERVER/scripts/studio/install-server.sh \
#     --env staging|production --release RELEASE.tar --sha256 HEX --commit SHA
#   sudo /bin/bash /Users/atelierd/SERVER/scripts/studio/install-server.sh \
#     --env staging|production --rollback
#
# SERVER is server for staging and server-production for production. The
# developer types the administrator password at sudo's own prompt; nothing
# here reads or passes one.
#
# RELEASE.tar  the release atelier ship built from the commit it verified
#              (scripts/ship-studio.mjs): `git archive` of that commit plus
#              the runtime packages, in a directory the developer can write
# HEX          the release's SHA-256, as ship computed it before handing the
#              file over: the bytes installed are the bytes ship built
# SHA          that commit, written into the release as COMMIT, which the
#              server reports at /api/version
#
# Trust. This script is root's: it runs from the release already installed,
# which only root can write. The new release is data to it: copied into
# root-owned storage first, checked there, and never run as root. The
# daemon reads it, root-owned and read-only, as setup-server.sh made it.
#
# What it does:
# 1. Copies the release in, checks its hash and that it holds only files and
#    directories inside itself, and writes COMMIT into it.
# 2. Stages it as SERVER.new, root's, group atelierd, read-only to the group.
# 3. Stops the environment's LaunchDaemon, moves the current release to
#    SERVER.prev (the last one is kept for rollback), and the new one in.
# 4. Starts the daemon and waits, at most 60 s, for /api/version to report SHA.
# 5. If it does not, puts SERVER.prev back, starts it, and says so; the release
#    that failed is kept as SERVER.failed until the next install.
# --rollback swaps SERVER and SERVER.prev the same way, so a rollback can
# itself be rolled back.
#
# Run as root only. A test, not root, may point it at a scratch home with
# ATELIER_INSTALL_TEST_HOME, where it runs the launchctl, lsof and curl it
# finds on PATH, changes no owners, and waits ATELIER_INSTALL_TEST_WAIT
# seconds where it would wait 60; as root neither variable is read.
set -euo pipefail
umask 077

SVC=atelierd
if [ "$(id -u)" = 0 ]; then
  export PATH=/usr/bin:/bin:/usr/sbin:/sbin
  HOME_DIR=/Users/$SVC
  DAEMONS=/Library/LaunchDaemons
  OWNER=root
  TEST=
  WAIT=60
elif [ -n "${ATELIER_INSTALL_TEST_HOME:-}" ]; then
  HOME_DIR=$ATELIER_INSTALL_TEST_HOME
  DAEMONS=$HOME_DIR/LaunchDaemons
  SVC=$(id -un)
  OWNER=$SVC
  TEST=1
  WAIT=${ATELIER_INSTALL_TEST_WAIT:-60}
  [[ "$WAIT" =~ ^[0-9]{1,3}$ ]] || { echo "install: ATELIER_INSTALL_TEST_WAIT is a number of seconds" >&2; exit 1; }
else
  echo "install: run as root (sudo)" >&2
  exit 1
fi

USAGE="usage: install-server.sh --env staging|production --release RELEASE.tar --sha256 HEX --commit SHA
       install-server.sh --env staging|production --rollback"
fail() { echo "install: $*" >&2; exit 1; }

ENV= RELEASE= SHA256= COMMIT= ROLLBACK=
while [ $# -gt 0 ]; do
  case "$1" in
    --rollback) ROLLBACK=1; shift ;;
    --env|--release|--sha256|--commit)
      [ $# -ge 2 ] || fail "$USAGE"
      case "$1" in --env) ENV=$2 ;; --release) RELEASE=$2 ;; --sha256) SHA256=$2 ;; --commit) COMMIT=$2 ;; esac
      shift 2 ;;
    *) fail "$USAGE" ;;
  esac
done
case "$ENV" in
  staging) LABEL=zone.atelier.server.staging; SERVER=server ;;
  production) LABEL=zone.atelier.server; SERVER=server-production ;;
  *) fail "$USAGE" ;;
esac
if [ -n "$ROLLBACK" ]; then
  [ -z "$RELEASE$SHA256$COMMIT" ] || fail "$USAGE"
else
  [[ "$COMMIT" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || fail "--commit must be a full commit id"
  [[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "--sha256 must be 64 hexadecimal digits"
  [ -f "$RELEASE" ] && [ ! -L "$RELEASE" ] || fail "no release file at $RELEASE"
fi
PLIST=$DAEMONS/$LABEL.plist
S=$HOME_DIR/$SERVER

# A directory is safe to hold the daemon's files when it is a real
# directory, owned by root or the service user, writable by no group or
# other, and carries no ACL (as in setup-server.sh).
safe_dir() {
  local d=$1 owner
  [ -d "$d" ] && [ ! -L "$d" ] || fail "$d is not a plain directory"
  owner=$(stat -f %Su "$d")
  [ "$owner" = "$OWNER" ] || [ "$owner" = "$SVC" ] || fail "$d is owned by $owner"
  [ $(( 0$(stat -f %Lp "$d") & 022 )) = 0 ] || fail "$d is writable by a group or others"
  ! ls -lde "$d" | sed -n '2,$p' | grep -q . || fail "$d carries an ACL"
}
[ -n "$TEST" ] || safe_dir /Users
safe_dir "$DAEMONS"
safe_dir "$HOME_DIR"
[ -f "$PLIST" ] && [ ! -L "$PLIST" ] || fail "no $LABEL LaunchDaemon at $PLIST; run setup-server.sh --env $ENV first"
[ "$(stat -f %Su "$PLIST")" = "$OWNER" ] || fail "$PLIST is not $OWNER's"
for d in "$S" "$S.prev" "$S.new" "$S.failed" "$S.swap"; do [ ! -L "$d" ] || fail "$d is a link"; done
[ ! -e "$S" ] || safe_dir "$S"
[ ! -e "$S.prev" ] || safe_dir "$S.prev"

# The address, port and code the daemon runs, read from its own plist: it
# must run this environment's serve.mjs from $S.
arg_after() {
  local i=0 prev= v
  while v=$(plutil -extract "ProgramArguments.$i" raw -o - "$PLIST" 2>/dev/null); do
    if [ "$prev" = "$1" ]; then printf '%s\n' "$v"; return 0; fi
    prev=$v; i=$((i+1))
  done
  return 1
}
[ "$(plutil -extract ProgramArguments.1 raw -o - "$PLIST" 2>/dev/null)" = "$S/cli/serve.mjs" ] || fail "$PLIST does not run $S/cli/serve.mjs"
[ "$(arg_after --env)" = "$ENV" ] || fail "$PLIST does not run --env $ENV"
BIND=$(arg_after --host) || fail "$PLIST names no --host"
PORT=$(arg_after --port) || fail "$PLIST names no --port"
valid_bind() {
  [ "$1" = 127.0.0.1 ] && return 0
  [[ "$1" =~ ^100\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local b=${BASH_REMATCH[1]} c=${BASH_REMATCH[2]} d=${BASH_REMATCH[3]}
  [ "$b" -ge 64 ] && [ "$b" -le 127 ] && [ "$c" -le 255 ] && [ "$d" -le 255 ]
}
valid_bind "$BIND" || fail "$PLIST binds $BIND, not a tailnet or loopback address"
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || fail "$PLIST names port $PORT"

WORK=$(mktemp -d /var/tmp/atelier-install.XXXXXX)
stopped=
swapped=
trap 'rm -rf "$WORK"' EXIT

commit_of() { local c; c=$(cat "$1/COMMIT" 2>/dev/null) && [[ "$c" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] && printf '%s\n' "$c"; }
loaded() { launchctl print "system/$LABEL" >/dev/null 2>&1; }
listening() { lsof -nP -iTCP@"$BIND":"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }

# Stops the daemon, and waits until nothing listens on its port.
stop_daemon() {
  if loaded; then launchctl bootout "system/$LABEL" || return 1; fi
  for _ in $(seq 1 20); do loaded || break; sleep 0.5; done
  ! loaded || return 1
  for _ in $(seq 1 20); do listening || return 0; sleep 0.5; done
  return 1
}

# Waits, at most $2 seconds, for the service user to listen on the port and
# /api/version to report commit $1 (any answer, when $1 is empty).
answers() {
  local want=$1 got
  for _ in $(seq 1 "$2"); do
    if lsof -nP -a -u "$SVC" -iTCP@"$BIND":"$PORT" -sTCP:LISTEN >/dev/null 2>&1 \
      && curl -fsS --connect-timeout 1 --max-time 2 "http://$BIND:$PORT/api/version" > "$WORK/version.json" 2>/dev/null; then
      [ -z "$want" ] && return 0
      got=$(plutil -extract commit raw -o - "$WORK/version.json" 2>/dev/null) || got=
      [ "$got" = "$want" ] && return 0
    fi
    sleep 1
  done
  return 1
}

# Puts back what was answering before, after a failure past the swap.
# Recovery decides by its own checks, not by set -e.
restore() {
  set +e
  if [ -n "$stopped" ] && [ -z "$swapped" ]; then
    # Stopped, and nothing moved: start what was there.
    echo "install: starting $ENV again on the release it ran" >&2
    launchctl bootstrap system "$PLIST" || echo "install: $LABEL did not start; sudo launchctl bootstrap system $PLIST" >&2
    return 1
  fi
  [ -n "$swapped" ] || return 0
  if ! stop_daemon; then echo "install: $LABEL would not stop; nothing was put back; see $HOME_DIR/log/$ENV.log (sudo tail)" >&2; return 1; fi
  if [ -n "$ROLLBACK" ]; then
    echo "install: the rollback failed; putting back the release it replaced" >&2
    if [ -d "$S.swap" ] && [ ! -e "$S" ]; then mv "$S.swap" "$S"
    elif [ -d "$S.swap" ]; then mv "$S" "$S.prev" && mv "$S.swap" "$S"
    else mv "$S" "$S.swap" && mv "$S.prev" "$S" && mv "$S.swap" "$S.prev"
    fi || { echo "install: the releases could not be swapped back; $ENV is stopped; see $HOME_DIR" >&2; return 1; }
  elif [ -d "$S.prev" ]; then
    echo "install: putting the previous release back" >&2
    rm -rf "$S.failed"
    mv "$S" "$S.failed" && mv "$S.prev" "$S" || { echo "install: the previous release could not be moved back; $ENV is stopped; see $HOME_DIR" >&2; return 1; }
  else
    echo "install: there is no previous release to put back; starting what is in $S" >&2
  fi
  launchctl bootstrap system "$PLIST" || { echo "install: $LABEL did not start; sudo launchctl bootstrap system $PLIST" >&2; return 1; }
  local back
  back=$(commit_of "$S") || back=
  if answers "$back" "$WAIT"; then
    if [ -n "$ROLLBACK" ]; then echo "install: $ENV answers again at commit ${back:-unknown}, the release that ran before the rollback" >&2
    else echo "install: $ENV answers again at commit ${back:-unknown}, the release that ran before; the release that failed is kept as $S.failed" >&2; fi
  else
    echo "install: the release that ran before is back in place but does not answer; see $HOME_DIR/log/$ENV.log (sudo tail)" >&2
    return 1
  fi
}
trap 'status=$?; [ $status = 0 ] || [ -z "$stopped" ] || restore; rm -rf "$WORK"; exit $status' EXIT

if [ -n "$ROLLBACK" ]; then
  [ -d "$S.prev" ] || fail "there is no previous release to roll back to ($S.prev)"
  [ -d "$S" ] || fail "there is no current release ($S)"
  want=$(commit_of "$S.prev") || want=
  from=$(commit_of "$S") || from=
  stopped=1
  stop_daemon || fail "$LABEL would not stop, or something still listens on $BIND:$PORT; nothing was changed"
  swapped=1
  mv "$S" "$S.swap"
  mv "$S.prev" "$S"
  mv "$S.swap" "$S.prev"
  launchctl bootstrap system "$PLIST" || fail "$LABEL did not start"
  answers "$want" "$WAIT" || fail "the previous release did not answer${want:+ with commit $want} in $WAIT s"
  swapped=
  echo "rolled $ENV back to commit ${want:-unknown}; the release it replaced (${from:-unknown}) is kept as $S.prev"
  exit 0
fi

# 1. The release into root-owned storage, then checked there.
cp "$RELEASE" "$WORK/server.tar"
got=$(shasum -a 256 "$WORK/server.tar" | awk '{print $1}')
[ "$got" = "$SHA256" ] || fail "the release's SHA-256 is $got, not $SHA256 as ship built it; nothing was changed"
# Listed to files first: a grep -q in a pipe can end the pipe early and,
# under pipefail, read as no match.
tar -tvf "$WORK/server.tar" > "$WORK/list-long" || fail "the release cannot be listed"
tar -tf "$WORK/server.tar" > "$WORK/list" || fail "the release cannot be listed"
[ -s "$WORK/list" ] || fail "the release is empty"
if awk '{t=substr($1,1,1); if (t!="-" && t!="d") bad=1} END {exit bad?0:1}' "$WORK/list-long"; then fail "the release holds something other than files and directories"; fi
if grep -E '(^/|(^|/)\.\.(/|$))' "$WORK/list" >/dev/null; then fail "the release names a path outside itself"; fi
mkdir "$WORK/server"
tar -xof "$WORK/server.tar" -C "$WORK/server"
for f in cli/serve.mjs hooks/pre-receive scripts/studio/install-server.sh; do [ -f "$WORK/server/$f" ] || fail "the release lacks $f"; done
[ -d "$WORK/server/node_modules/jose" ] || fail "the release lacks node_modules/jose"
rm -rf "$WORK/server/COMMIT"
printf '%s\n' "$COMMIT" > "$WORK/server/COMMIT"

# 2. Staged beside the current release, root's and read-only to the daemon.
rm -rf "$S.new" "$S.failed"
cp -R "$WORK/server" "$S.new"
[ -n "$TEST" ] || chown -R root:"$SVC" "$S.new"
chmod -R u=rwX,g=rX,o= "$S.new"
chmod 750 "$S.new/hooks/pre-receive"
chmod -RN "$S.new"
prev=$(commit_of "$S") || prev=

# 3. The daemon stopped, the current release becomes the previous one.
stopped=1
stop_daemon || fail "$LABEL would not stop, or something still listens on $BIND:$PORT; the new release is staged as $S.new and nothing else changed"
swapped=1
if [ -e "$S" ]; then
  rm -rf "$S.prev"
  mv "$S" "$S.prev"
fi
mv "$S.new" "$S"

# 4. It answers with the commit shipped.
launchctl bootstrap system "$PLIST" || fail "$LABEL did not start"
answers "$COMMIT" "$WAIT" || fail "$ENV did not report commit $COMMIT at http://$BIND:$PORT/api/version in $WAIT s"
swapped=
echo "$ENV runs commit $COMMIT at http://$BIND:$PORT; the previous release (${prev:-none}) is kept as $S.prev for rollback"
