#!/bin/bash -p
# Privileged bash ignores BASH_ENV, imported functions and shell options.
# Only SUDO_USER is retained by setup to write the developer's token copy.
if builtin test "$EUID" = 0; then
  for inherited in $(builtin compgen -e); do
    case "$inherited" in SUDO_USER) continue ;; esac
    builtin export -n "$inherited"
    builtin unset "$inherited" 2>/dev/null || :
  done
  export PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/root LC_ALL=C
fi
unset DEVELOPER_DIR
umask 077
cd /
# Atelier 2.0 on the Studio: the one-time setup of the atelierd user and one
# server, staging or production (design-branches-2026-10-28.md, sections 4.1
# and 4.11; plan task 9). Run as root on the Studio, by the developer, who
# types the administrator password at sudo's prompt:
#
#   sudo /bin/bash -p setup-server.sh --env staging|production RELEASE.tar NODE OWNER_TOKEN_COPY
#
# RELEASE.tar       the server: `git archive` of the 2.0 branch plus node_modules/jose
# NODE              the node binary to install for the daemon
# OWNER_TOKEN_COPY  where the developer's copy of the environment's owner token goes
#
# The two environments differ only here:
#               staging                       production
#   daemon      zone.atelier.server.staging   zone.atelier.server
#   port        4101                          4100
#   code        server/                       server-production/
#   data        data/staging, repos/staging,  data/production, repos/production,
#               secrets/staging               secrets/production
#   log         log/staging.log               log/production.log
# Both share the user, the home and bin/node. Staging was set up first, on
# 2026-10-28, as setup-staging.sh, which --env staging repeats exactly.
# Production is set up at the cut-over.
#
# DRYRUN=1 prints what would change and needs no root.
#
# Trust. The release and the node binary come from the developer's own files.
# Running this script with sudo is the developer's decision to trust the
# server and node bytes once: copied into root-owned storage and checked there,
# and never run as root. From then on nothing the developer's user (and so no
# agent) can write is used by the daemon. The privileged installer is a
# separate input: only the reviewed sibling in a root-owned source tree
# is installed; the archive cannot supply privileged code.
#
# What it makes:
# - atelierd: a hidden service user with no login, no password and no admin
#   rights, checked whole on every run.
# - /Users/atelierd, owned by atelierd, mode 700, with data/, repos/,
#   secrets/ and log/ (atelierd's), and bin/ and server/ (root's, group
#   atelierd, read and execute only): the daemon runs code it cannot change,
#   and the developer's user can neither read nor change any of it. The only
#   directories above are /Users (root's, checked) and that home.
# - /Library/LaunchDaemons/zone.atelier.server.staging.plist (or
#   zone.atelier.server.plist): the server on the tailnet address, as atelierd.
# Run again, it changes only what differs; it never deletes data or
# repositories. The tunnel comes later, with its own go (setup-tunnel.sh).
# Later releases are installed by atelier ship (install-server.sh).
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
umask 077

USAGE="usage: setup-server.sh --env staging|production RELEASE.tar NODE OWNER_TOKEN_COPY"
fail() { echo "setup: $*" >&2; exit 1; }
[ "${1:-}" = --env ] && [ $# = 5 ] || fail "$USAGE"
ENV=$2
RELEASE=$3
NODE_SRC=$4
TOKEN_COPY=$5

SVC=atelierd
HOME_DIR=/Users/$SVC
case "$ENV" in
  staging) LABEL=zone.atelier.server.staging; PORT=4101; SERVER=server ;;
  production) LABEL=zone.atelier.server; PORT=4100; SERVER=server-production ;;
  *) fail "$USAGE" ;;
esac
PLIST=/Library/LaunchDaemons/$LABEL.plist
BIND=${ATELIER_BIND:-100.99.0.102}
DEV=${SUDO_USER:-}

dry() { [ "${DRYRUN:-}" = 1 ]; }
# The LaunchDaemon's plist, written to $1.
write_plist() {
  cat > "$1" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>UserName</key><string>$SVC</string>
  <key>GroupName</key><string>$SVC</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME_DIR/bin/node</string>
    <string>$HOME_DIR/$SERVER/cli/serve.mjs</string>
    <string>--env</string><string>$ENV</string>
    <string>--data</string><string>$HOME_DIR/data/$ENV</string>
    <string>--repos</string><string>$HOME_DIR/repos/$ENV</string>
    <string>--secrets</string><string>$HOME_DIR/secrets/$ENV</string>
    <string>--host</string><string>$BIND</string>
    <string>--port</string><string>$PORT</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME_DIR/bin:/Library/Developer/CommandLineTools/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME_DIR</string>
    <key>PUBLIC_ORIGIN</key><string>http://$BIND:$PORT</string>
  </dict>
  <key>WorkingDirectory</key><string>$HOME_DIR</string>
  <key>Umask</key><integer>63</integer>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME_DIR/log/$ENV.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/log/$ENV.log</string>
</dict>
</plist>
PLIST
}

# Every atelierd job. Nothing of the service user's runs while root writes
# in its home: each loaded job is stopped first, and started again after,
# or on a failure.
JOBS="zone.atelier.server.staging zone.atelier.server zone.atelier.tunnel zone.atelier.backup.staging zone.atelier.backup.production"
DAEMONS=/Library/LaunchDaemons
loaded=
stopped=
swapped=
stop_all() {
  local job
  for job in $JOBS; do
    launchctl print "system/$job" >/dev/null 2>&1 || continue
    launchctl bootout "system/$job" 2>/dev/null || return 1
    for _ in $(seq 1 20); do launchctl print "system/$job" >/dev/null 2>&1 || break; sleep 0.5; done
    if launchctl print "system/$job" >/dev/null 2>&1; then echo "setup: $job would not stop" >&2; return 1; fi
  done
  for _ in $(seq 1 60); do pgrep -u "$SVC" >/dev/null 2>&1 || break; sleep 0.5; done
  if pgrep -u "$SVC" >/dev/null 2>&1; then echo "setup: a process of $SVC is still running" >&2; return 1; fi
}
# Starts the jobs that were loaded, but this environment's server, which
# the install starts itself.
start_others() {
  local job rc=0
  for job in $JOBS; do
    [ "$job" != "$LABEL" ] || continue
    case " $loaded " in *" $job "*) launchctl bootstrap system "$DAEMONS/$job.plist" || { echo "setup: $job did not start; sudo launchctl bootstrap system $DAEMONS/$job.plist" >&2; rc=1; } ;; esac
  done
  return $rc
}
# After a failure once the jobs were stopped: the code and plist this run
# replaced go back, and every job that ran starts again. It decides by its
# own checks, not by set -e.
CURL=/usr/bin/curl
health() {
  local attempt
  for attempt in $(seq 1 30); do
    if lsof -nP -a -u "$SVC" -iTCP@"$BIND":"$PORT" -sTCP:LISTEN >/dev/null 2>&1 \
      && "$CURL" -q -fsS --connect-timeout 1 --max-time 2 "http://$BIND:$PORT/api/version" > "$WORK/version.json" 2>/dev/null \
      && plutil -convert xml1 -o /dev/null "$WORK/version.json" >/dev/null 2>&1; then
      if [ ! -f "$HOME_DIR/$SERVER/COMMIT" ] || [ "$(plutil -extract commit raw -o - "$WORK/version.json" 2>/dev/null)" = "$(cat "$HOME_DIR/$SERVER/COMMIT")" ]; then return 0; fi
    fi
    sleep 1
  done
  return 1
}

recover() {
  [ -n "$stopped" ] || return 0
  set +e
  echo "setup: putting back what ran before" >&2
  if ! stop_all; then echo "setup: recovery bootout failed; code left in place" >&2; return 1; fi
  if [ -n "$swapped" ]; then
    if [ -d "$HOME_DIR/$SERVER.old" ]; then rm -rf "$HOME_DIR/$SERVER" && mv "$HOME_DIR/$SERVER.old" "$HOME_DIR/$SERVER" || { echo "setup: could not put $SERVER.old back" >&2; return 1; }; fi
    if [ -f "$HOME_DIR/bin/node.old" ]; then mv -f "$HOME_DIR/bin/node.old" "$HOME_DIR/bin/node" || { echo "setup: could not put bin/node.old back" >&2; return 1; }; fi
  fi
  if [ -n "${WORK:-}" ] && [ -f "$WORK/old.plist" ]; then install -o root -g wheel -m 644 "$WORK/old.plist" "$PLIST" || { echo "setup: could not put $PLIST back" >&2; return 1; }; fi
  case " $loaded " in *" $LABEL "*) launchctl bootstrap system "$PLIST" && health || { echo "setup: recovered $LABEL did not start or answer /api/version" >&2; return 1; } ;; esac
  start_others
}

# Privileged code comes only from the reviewed pair in root's custody.
# Check the lexical path component by component, before resolving anything:
# resolving first would hide a symlink in a parent.
trusted_source() {
  local path=$1 part current= rest
  case "$path" in /*) ;; *) path="$PWD/$path" ;; esac
  rest=${path#/}
  trusted_entry / || return 1
  while [ -n "$rest" ]; do
    part=${rest%%/*}
    if [ "$rest" = "$part" ]; then rest=; else rest=${rest#*/}; fi
    case "$part" in ''|.) continue ;; ..) echo "setup: source path contains .." >&2; return 1 ;; esac
    current="$current/$part"
    trusted_entry "$current" || return 1
  done
  [ -f "$path" ] || { echo "setup: $path is not a source file" >&2; return 1; }
}
trusted_entry() {
  local path=$1 listing
  [ ! -L "$path" ] && { [ -d "$path" ] || [ -f "$path" ]; } || { echo "setup: $path is not a plain source" >&2; return 1; }
  [ "$(stat -f %Su "$path")" = root ] || { echo "setup: $path is not root-owned" >&2; return 1; }
  [ $(( 0$(stat -f %Lp "$path") & 022 )) = 0 ] || { echo "setup: $path is group/world-writable" >&2; return 1; }
  listing=$(ls -lde "$path") || return 1
  [ -z "$(printf '%s\n' "$listing" | sed -n '2,$p')" ] || { echo "setup: $path carries an ACL" >&2; return 1; }
}
# Never use Apple's xcode-select dispatch shims as root or atelierd.
GIT=/Library/Developer/CommandLineTools/usr/bin/git
OTOOL=/Library/Developer/CommandLineTools/usr/bin/llvm-otool
check_tools() {
  local tool
  for tool in "$GIT" "$OTOOL"; do
    [ -x "$tool" ] || fail "missing $tool; PAVI can install Command Line Tools with: xcode-select --install"
    trusted_source "$tool" || fail "unsafe tool $tool; repair its ownership/permissions before continuing"
  done
}

check_node() {
  local binary=$1 description lib count=0 line
  description=$(/usr/bin/file -b "$binary") || fail "cannot identify node"
  [[ "$description" = *Mach-O*executable* ]] || fail "node must be a Mach-O executable"
  "$OTOOL" -L "$binary" > "$WORK/node-libs" 2> "$WORK/node-errors" || fail "cannot read node libraries"
  [ ! -s "$WORK/node-errors" ] || fail "otool reported an error reading node libraries"
  while IFS= read -r line; do
    case "$line" in "$binary:"|"$binary (architecture "*"):") continue ;; esac
    [[ "$line" =~ ^[[:space:]]+(/[^[:space:]]+)[[:space:]]+\(compatibility\ version ]] || fail "otool reported an invalid node library: $line"
    lib=${BASH_REMATCH[1]}
    case "$lib" in /System/Library/*|/usr/lib/*) ;; *) fail "node links $lib, outside the system libraries" ;; esac
    case "$lib" in */../*|*/./*) fail "node library path is not canonical: $lib" ;; esac
    count=$((count+1))
  done < "$WORK/node-libs"
  [ "$count" -gt 0 ] || fail "node has an empty library list"
}

LOCK_DIR=/Library/Atelier/lock
acquire_lock() {
  local d lock_pid
  for d in / /Library /Library/Atelier "$LOCK_DIR"; do trusted_entry "$d" || fail "unsafe lock directory $d"; done
  [ -d "$LOCK_DIR" ] || fail "lock directory is not a directory: $LOCK_DIR"
  LOCK=$LOCK_DIR/install.lock
  [ ! -L "$LOCK" ] || fail "$LOCK is a link"
  if [ -e "$LOCK" ]; then
    [ -f "$LOCK" ] && [ "$(stat -f %Su "$LOCK")" = root ] || fail "unsafe lock $LOCK"
  fi
  if ! /usr/bin/shlock -p "$$" -f "$LOCK"; then
    lock_pid=$(cat "$LOCK" 2>/dev/null) || lock_pid=
    if [[ "$lock_pid" =~ ^[1-9][0-9]*$ ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
      sleep 1
      /usr/bin/shlock -p "$$" -f "$LOCK" || fail "another installer is running (lock: $LOCK)"
    else fail "another installer is running (lock: $LOCK)"
    fi
  fi
}

source_help() {
  echo "setup: review both scripts, then copy them into root's directory with:" >&2
  echo 'sudo /usr/bin/install -o root -g wheel -m 700 scripts/studio/setup-server.sh scripts/studio/install-server.sh /private/var/root/' >&2
  echo "setup: then run sudo /bin/bash -p /private/var/root/setup-server.sh --env $ENV RELEASE.tar NODE OWNER_TOKEN_COPY" >&2
}
SOURCE=${BASH_SOURCE[0]}
case "$SOURCE" in /*) ;; *) SOURCE="$PWD/$SOURCE" ;; esac
SOURCE_DIR=${SOURCE%/*}
INSTALLER_SOURCE=$SOURCE_DIR/install-server.sh

backup_code() {
  [ ! -e "$HOME_DIR/bin/node.old" ] && [ ! -L "$HOME_DIR/bin/node.old" ] && [ ! -e "$HOME_DIR/$SERVER.old" ] && [ ! -L "$HOME_DIR/$SERVER.old" ] || fail "saved code remains; repair the previous setup before retrying"
  dry || swapped=1
  [ ! -e "$HOME_DIR/bin/node" ] || run mv "$HOME_DIR/bin/node" "$HOME_DIR/bin/node.old"
  [ ! -e "$HOME_DIR/$SERVER" ] || run mv "$HOME_DIR/$SERVER" "$HOME_DIR/$SERVER.old"
}

# A test reads these functions alone (SETUP_SERVER_LIB=1), with no other effect.
if [ "${SETUP_SERVER_LIB:-}" = 1 ]; then return 0 2>/dev/null || exit 0; fi
run() { if dry; then printf '+ %s\n' "$*"; else "$@"; fi; }

dry || [ "$EUID" = 0 ] || fail "run as root (sudo), or DRYRUN=1"
valid_bind() {
  [ "$1" = 127.0.0.1 ] && return 0
  [[ "$1" =~ ^100\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local b=${BASH_REMATCH[1]} c=${BASH_REMATCH[2]} d=${BASH_REMATCH[3]}
  [ "$b" -ge 64 ] && [ "$b" -le 127 ] && [ "$c" -le 255 ] && [ "$d" -le 255 ]
}
if ! dry; then
  check_tools
  if ! trusted_source "$SOURCE" || ! trusted_source "$INSTALLER_SOURCE"; then source_help; exit 1; fi
fi
valid_bind "$BIND" || fail "ATELIER_BIND must be a tailnet (100.64.0.0/10) or loopback address, not $BIND"
if ! dry && { [ -z "$DEV" ] || [ "$DEV" = root ]; }; then fail "run through sudo from the developer's account, so the token copy is written as that user"; fi
[ -f "$RELEASE" ] && [ ! -L "$RELEASE" ] || fail "no release file at $RELEASE"
[ -e "$NODE_SRC" ] || fail "no node at $NODE_SRC"

# A directory is safe to hold the daemon's files when it is a real
# directory, owned by root or the service user, writable by no group or
# other, and carries no ACL.
safe_dir() {
  local d=$1 owner
  [ -d "$d" ] && [ ! -L "$d" ] || fail "$d is not a plain directory"
  owner=$(stat -f %Su "$d")
  [ "$owner" = root ] || [ "$owner" = "$SVC" ] || fail "$d is owned by $owner"
  [ $(( 0$(stat -f %Lp "$d") & 022 )) = 0 ] || fail "$d is writable by a group or others"
  ! ls -lde "$d" | sed -n '2,$p' | grep -q . || fail "$d carries an ACL"
}
safe_dir /Users
safe_dir /Library/LaunchDaemons

LOCK=
if ! dry; then
  trusted_entry / && trusted_entry /Library || fail "unsafe /Library"
  for d in /Library/Atelier "$LOCK_DIR"; do
    if [ ! -e "$d" ] && [ ! -L "$d" ]; then mkdir -m 755 "$d"; fi
    trusted_entry "$d" || fail "unsafe lock directory $d"
  done
  acquire_lock
fi
trap '[ -z "$LOCK" ] || rm -f "$LOCK"' EXIT
WORK=$(mktemp -d /var/tmp/atelier-setup.XXXXXX)
trap 'rm -rf "$WORK"; [ -z "$LOCK" ] || rm -f "$LOCK"' EXIT

# 1. Copy the inputs into root-owned storage before looking at them.
cp "$RELEASE" "$WORK/server.tar"
cp -L "$NODE_SRC" "$WORK/node"
chmod 755 "$WORK/node"
# Node may load system libraries alone: anything else could be replaced later.
check_node "$WORK/node"
# The release holds plain files and directories: no links, no devices.
# Listed to files first: a grep -q in a pipe can end the pipe early and,
# under pipefail, read as no match.
tar -tvf "$WORK/server.tar" > "$WORK/list-long" || fail "the release cannot be listed"
tar -tf "$WORK/server.tar" > "$WORK/list" || fail "the release cannot be listed"
[ -s "$WORK/list" ] || fail "the release is empty"
if awk '{t=substr($1,1,1); if (t!="-" && t!="d") bad=1} END {exit bad?0:1}' "$WORK/list-long"; then fail "the release holds something other than files and directories"; fi
if grep -E '(^/|(^|/)\.\.(/|$))' "$WORK/list" >/dev/null; then fail "the release names a path outside itself"; fi
mkdir "$WORK/server"
tar -xf "$WORK/server.tar" -C "$WORK/server"
[ -f "$WORK/server/cli/serve.mjs" ] && [ -f "$WORK/server/hooks/pre-receive" ] && [ -d "$WORK/server/node_modules/jose" ] || fail "the release lacks cli/serve.mjs, hooks/pre-receive or node_modules/jose"

# 2. The service user and its group, in the 400s like other daemons. An
#    existing record is checked whole, never trusted.
if dscl . -read /Users/$SVC >/dev/null 2>&1 || dscl . -read /Groups/$SVC >/dev/null 2>&1; then
  uid=$(dscl . -read /Users/$SVC UniqueID 2>/dev/null | awk '{print $2}')
  gid=$(dscl . -read /Users/$SVC PrimaryGroupID 2>/dev/null | awk '{print $2}')
  ggid=$(dscl . -read /Groups/$SVC PrimaryGroupID 2>/dev/null | awk '{print $2}')
  shell=$(dscl . -read /Users/$SVC UserShell 2>/dev/null | awk '{print $2}')
  home=$(dscl . -read /Users/$SVC NFSHomeDirectory 2>/dev/null | awk '{print $2}')
  [[ "$uid" =~ ^4[0-9][0-9]$ ]] && [ "$gid" = "$uid" ] && [ "$ggid" = "$uid" ] && [ "$shell" = /usr/bin/false ] && [ "$home" = "$HOME_DIR" ] \
    || fail "an $SVC record exists but is not the one this script makes (uid $uid, gid $gid/$ggid, shell $shell, home $home); remove it by hand and run again"
  [ "$(dscl . -list /Users UniqueID | awk -v u="$uid" '$2==u' | wc -l | tr -d ' ')" = 1 ] || fail "uid $uid is shared"
  [ "$(dscl . -list /Groups PrimaryGroupID | awk -v g="$uid" '$2==g' | wc -l | tr -d ' ')" = 1 ] || fail "gid $uid is shared"
  [ "$(dscl . -read /Users/$SVC Password 2>/dev/null | awk '{print $2}')" = '*' ] || fail "$SVC has a password"
  ! dscl . -read /Users/$SVC AuthenticationAuthority >/dev/null 2>&1 || fail "$SVC can authenticate"
else
  ID=450
  while dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$ID" || dscl . -list /Groups PrimaryGroupID | awk '{print $2}' | grep -qx "$ID"; do ID=$((ID+1)); done
  [ "$ID" -lt 500 ] || fail "no free id below 500"
  run dscl . -create /Groups/$SVC
  run dscl . -create /Groups/$SVC PrimaryGroupID "$ID"
  run dscl . -create /Groups/$SVC RealName "Atelier daemon"
  run dscl . -create /Groups/$SVC Password '*'
  run dscl . -create /Users/$SVC
  run dscl . -create /Users/$SVC UniqueID "$ID"
  run dscl . -create /Users/$SVC PrimaryGroupID "$ID"
  run dscl . -create /Users/$SVC RealName "Atelier daemon"
  run dscl . -create /Users/$SVC NFSHomeDirectory "$HOME_DIR"
  run dscl . -create /Users/$SVC UserShell /usr/bin/false
  run dscl . -create /Users/$SVC Password '*'
  run dscl . -create /Users/$SVC IsHidden 1
fi
if ! dry; then
  for g in admin wheel staff; do
    out=$(dsmemberutil checkmembership -U "$SVC" -G "$g" 2>&1) || fail "cannot check $SVC's membership of $g: $out"
    [ "$out" = "user is not a member of the group" ] || fail "$SVC is a member of $g ($out)"
  done
  out=$(dsmemberutil checkmembership -U "$DEV" -G "$SVC" 2>&1) || fail "cannot check $DEV's membership of $SVC: $out"
  [ "$out" = "user is not a member of the group" ] || fail "$DEV is a member of the $SVC group ($out)"
fi

[ ! -e "$HOME_DIR/bin/node.old" ] && [ ! -L "$HOME_DIR/bin/node.old" ] && [ ! -e "$HOME_DIR/$SERVER.old" ] && [ ! -L "$HOME_DIR/$SERVER.old" ] || fail "saved code remains; repair the previous setup before retrying"

# 3. Every atelierd job stops (the other environment's server, the tunnel,
#    the backups) and nothing of the service user's may run, whether or not
#    launchd knows of it. What was loaded is recorded first, with this
#    environment's plist, so a failure from here on puts them back.
for job in $JOBS; do [ ! -L "$DAEMONS/$job.plist" ] || fail "$DAEMONS/$job.plist is a link"; done
if [ -f "$PLIST" ]; then cp "$PLIST" "$WORK/old.plist"; fi
if dry; then
  echo "+ (stop every loaded job of $JOBS; start them again afterwards, or on a failure)"
else
  for job in $JOBS; do
    if launchctl print "system/$job" >/dev/null 2>&1; then
      [ -f "$DAEMONS/$job.plist" ] || fail "$job is loaded but $DAEMONS/$job.plist is missing; it could not be started again"
      loaded="$loaded $job"
    fi
  done
fi
finish_setup() {
  local status=$?
  trap - EXIT INT TERM
  if [ "$status" != 0 ] && ! recover; then
    echo "setup: recovery failed; saved inputs and plist kept at $WORK" >&2
  else rm -rf "$WORK"
  fi
  [ -z "$LOCK" ] || rm -f "$LOCK"
  exit "$status"
}
trap finish_setup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ! dry; then
  stopped=1
  stop_all || fail "the $SVC jobs could not all be stopped"
  if lsof -nP -iTCP@"$BIND":"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then fail "something already listens on $BIND:$PORT"; fi
fi

# 4. Directories. An existing home must be a plain directory, never a link.
[ ! -L "$HOME_DIR" ] || fail "$HOME_DIR is a link"
# The home is root's, group atelierd, 750: the daemon enters it but cannot
# rename what is in it, so it cannot swap its own code; the developer's
# user, not in the group, cannot enter it at all.
run mkdir -p "$HOME_DIR"
run chown "root:$SVC" "$HOME_DIR"
run chmod 750 "$HOME_DIR"
dry || safe_dir "$HOME_DIR"
for d in data data/staging data/production repos repos/staging repos/production secrets secrets/staging secrets/production log; do
  [ ! -L "$HOME_DIR/$d" ] || fail "$HOME_DIR/$d is a link"
  run mkdir -p "$HOME_DIR/$d"
  run chown "$SVC:$SVC" "$HOME_DIR/$d"
  run chmod 700 "$HOME_DIR/$d"
done
dry || chmod -RN "$HOME_DIR"

# 5. Node and the server, root-owned, readable and runnable by the group.
#    bin/ is shared: node goes in beside what is there (cloudflared), which
#    stays as it is.
for d in bin bin/node bin/node.new bin/node.old "$SERVER"; do [ ! -L "$HOME_DIR/$d" ] || fail "$HOME_DIR/$d is a link"; done
run rm -rf "$HOME_DIR/$SERVER.new"
run mkdir -p "$HOME_DIR/bin"
run chown "root:$SVC" "$HOME_DIR/bin"
run chmod 750 "$HOME_DIR/bin"
dry || safe_dir "$HOME_DIR/bin"
run install -o root -g "$SVC" -m 750 "$WORK/node" "$HOME_DIR/bin/node.new"
run cp -R "$WORK/server" "$HOME_DIR/$SERVER.new"
run chown -R root:"$SVC" "$HOME_DIR/$SERVER.new"
run chmod -R u=rwX,g=rX,o= "$HOME_DIR/$SERVER.new"
run chmod 750 "$HOME_DIR/$SERVER.new/hooks/pre-receive"
# The staged node is checked, as the service user, before anything moves.
if ! dry; then
  sudo -u "$SVC" /usr/bin/env -i HOME="$HOME_DIR" PATH=/Library/Developer/CommandLineTools/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin LC_ALL=C "$HOME_DIR/bin/node.new" -e 'const [a]=process.versions.node.split(".").map(Number); if (a<26) process.exit(1)' || fail "node 26 or later is needed; nothing was replaced"
fi
# Refuse unresolved recovery before replacing any current code. node.old is
# shared; it cannot establish which environment's server needs restoring.

backup_code
run mv -f "$HOME_DIR/bin/node.new" "$HOME_DIR/bin/node"
run mv "$HOME_DIR/$SERVER.new" "$HOME_DIR/$SERVER"

# The installer atelier ship runs, root's, outside every release, at a path
# only root can write. Only this script installs or replaces it.
INSTALLER_DIR=/Library/Atelier
safe_dir /Library
[ ! -L "$INSTALLER_DIR" ] && [ ! -L "$INSTALLER_DIR/install-server.sh" ] && [ ! -L "$INSTALLER_DIR/install-server.sh.new" ] || fail "$INSTALLER_DIR or the installer in it is a link"
run mkdir -p "$INSTALLER_DIR"
run chown root:wheel "$INSTALLER_DIR"
run chmod 755 "$INSTALLER_DIR"
dry || safe_dir "$INSTALLER_DIR"
run install -o root -g wheel -m 755 "$INSTALLER_SOURCE" "$INSTALLER_DIR/install-server.sh.new"
run mv -f "$INSTALLER_DIR/install-server.sh.new" "$INSTALLER_DIR/install-server.sh"

# 6. The environment's owner token: made once, kept in secrets/, never
#    printed, with one copy written by the developer's own user.
SECRET="$HOME_DIR/secrets/$ENV/ATELIER_TOKEN"
if dry; then
  echo "+ (make $SECRET if missing; copy it to $TOKEN_COPY as $DEV, mode 600)"
else
  if [ ! -s "$SECRET" ]; then
    hex=$(openssl rand -hex 32) || fail "openssl rand failed"
    [[ "$hex" =~ ^[0-9a-f]{64}$ ]] || fail "openssl rand gave no 64-character hex"
    printf 'atl_%s\n' "$hex" > "$WORK/token"
    install -o "$SVC" -g "$SVC" -m 600 "$WORK/token" "$SECRET.new"
    mv -f "$SECRET.new" "$SECRET"
    unset hex
  fi
  # The kept secret must be a plain file of the service user's, mode 600,
  # holding exactly one token line.
  [ -f "$SECRET" ] && [ ! -L "$SECRET" ] || fail "$SECRET is not a plain file"
  [ "$(stat -f '%Su %Lp' "$SECRET")" = "$SVC 600" ] || fail "$SECRET is not $SVC's with mode 600"
  # Checked on the raw bytes: 69 of them, none but the token's letters and
  # one newline, forming the one line the pattern names.
  [ "$(stat -f %z "$SECRET")" = 69 ] \
    && [ "$(LC_ALL=C tr -d 'atl_0-9a-f\n' < "$SECRET" | wc -c | tr -d ' ')" = 0 ] \
    && [ "$(LC_ALL=C grep -cxE 'atl_[0-9a-f]{64}' "$SECRET")" = 1 ] || fail "$SECRET does not hold exactly one token"
  # The developer's copy is written by the developer's own user, through a
  # fresh temporary file of mode 600 renamed into place.
  sudo -u "$DEV" /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/sh -c 'umask 077; d=$(dirname "$1"); mkdir -p "$d" && t=$(mktemp "$d/.$2-token.XXXXXX") && chmod 600 "$t" && cat > "$t" && mv -f "$t" "$1"' sh "$TOKEN_COPY" "$ENV" < "$SECRET" || fail "the token copy could not be written"
fi

# 7. The LaunchDaemon.
write_plist "$WORK/plist"
plutil -lint "$WORK/plist" >/dev/null || fail "the plist does not parse"
[ ! -L "$PLIST" ] || fail "$PLIST is a link"
run install -o root -g wheel -m 644 "$WORK/plist" "$PLIST"
run launchctl bootstrap system "$PLIST"

# 8. It answers.
if ! dry; then
  if health; then
    stopped=
    rm -rf "$HOME_DIR/bin/node.old" "$HOME_DIR/$SERVER.old"
    start_others || fail "start the jobs named above by hand"
    echo "$ENV answers at http://$BIND:$PORT, running as $SVC; the owner token is at $TOKEN_COPY"
    exit 0
  fi
  fail "$ENV did not answer in 30 s; see $HOME_DIR/log/$ENV.log (sudo tail)"
fi
