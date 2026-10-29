#!/bin/bash
# Atelier 2.0 on the Studio: the one-time setup of the atelierd user and the
# staging server (design-branches-2026-10-28.md, sections 4.1 and 4.11; plan
# task 9). Run as root on the Studio, by the developer, who types the
# administrator password at sudo's prompt:
#
#   sudo bash setup-staging.sh RELEASE.tar NODE OWNER_TOKEN_COPY
#
# RELEASE.tar       the server: `git archive` of the 2.0 branch plus node_modules/jose
# NODE              the node binary to install for the daemon
# OWNER_TOKEN_COPY  where the developer's copy of the staging owner token goes
#
# DRYRUN=1 prints what would change and needs no root.
#
# Trust. The release and the node binary come from the developer's own files.
# Running this script with sudo is the developer's decision to trust those
# bytes once: they are copied into root-owned storage first, checked there,
# and never run as root. From then on nothing the developer's user (and so no
# agent) can write is used by the daemon.
#
# What it makes:
# - atelierd: a hidden service user with no login, no password and no admin
#   rights, checked whole on every run.
# - /Users/atelierd, owned by atelierd, mode 700, with data/, repos/,
#   secrets/ and log/ (atelierd's), and bin/ and server/ (root's, group
#   atelierd, read and execute only): the daemon runs code it cannot change,
#   and the developer's user can neither read nor change any of it. The only
#   directories above are /Users (root's, checked) and that home.
# - /Library/LaunchDaemons/zone.atelier.server.staging.plist: the staging
#   server on the tailnet address, port 4101, as atelierd.
# Run again, it changes only what differs; it never deletes data or
# repositories. The tunnel and production come later, with their own go.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
umask 077

RELEASE=${1:?usage: setup-staging.sh RELEASE.tar NODE OWNER_TOKEN_COPY}
NODE_SRC=${2:?usage: setup-staging.sh RELEASE.tar NODE OWNER_TOKEN_COPY}
TOKEN_COPY=${3:?usage: setup-staging.sh RELEASE.tar NODE OWNER_TOKEN_COPY}

SVC=atelierd
HOME_DIR=/Users/$SVC
PLIST=/Library/LaunchDaemons/zone.atelier.server.staging.plist
LABEL=zone.atelier.server.staging
BIND=${ATELIER_BIND:-100.99.0.102}
PORT=4101
DEV=${SUDO_USER:-}

fail() { echo "setup: $*" >&2; exit 1; }
dry() { [ "${DRYRUN:-}" = 1 ]; }
run() { if dry; then printf '+ %s\n' "$*"; else "$@"; fi; }

dry || [ "$(id -u)" = 0 ] || fail "run as root (sudo), or DRYRUN=1"
valid_bind() {
  [ "$1" = 127.0.0.1 ] && return 0
  [[ "$1" =~ ^100\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local b=${BASH_REMATCH[1]} c=${BASH_REMATCH[2]} d=${BASH_REMATCH[3]}
  [ "$b" -ge 64 ] && [ "$b" -le 127 ] && [ "$c" -le 255 ] && [ "$d" -le 255 ]
}
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

WORK=$(mktemp -d /var/tmp/atelier-setup.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

# 1. Copy the inputs into root-owned storage before looking at them.
cp "$RELEASE" "$WORK/server.tar"
cp -L "$NODE_SRC" "$WORK/node"
chmod 755 "$WORK/node"
# Node may load system libraries alone: anything else could be replaced later.
otool -L "$WORK/node" | sed 1d | awk '{print $1}' | while read -r lib; do
  case "$lib" in /System/Library/*|/usr/lib/*) ;; *) fail "node links $lib, outside the system libraries" ;; esac
done
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

# 3. Stop the daemon before its code changes.
if ! dry && launchctl print system/$LABEL >/dev/null 2>&1; then
  launchctl bootout system/$LABEL || fail "the running daemon would not stop"
  for _ in $(seq 1 20); do launchctl print system/$LABEL >/dev/null 2>&1 || break; sleep 0.5; done
  ! launchctl print system/$LABEL >/dev/null 2>&1 || fail "the daemon is still loaded"
fi
# Nothing of the service user's may be running while its files change,
# whether or not launchd knows of it.
if ! dry && dscl . -read /Users/$SVC >/dev/null 2>&1 && pgrep -u "$SVC" >/dev/null; then fail "a process of $SVC is running; stop it first"; fi
if ! dry && lsof -nP -iTCP@"$BIND":"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then fail "something already listens on $BIND:$PORT"; fi

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
for d in bin server; do [ ! -L "$HOME_DIR/$d" ] || fail "$HOME_DIR/$d is a link"; done
run rm -rf "$HOME_DIR/bin.new" "$HOME_DIR/server.new"
run mkdir "$HOME_DIR/bin.new"
run install -o root -g "$SVC" -m 750 "$WORK/node" "$HOME_DIR/bin.new/node"
run cp -R "$WORK/server" "$HOME_DIR/server.new"
run chown -R root:"$SVC" "$HOME_DIR/bin.new" "$HOME_DIR/server.new"
run chmod -R u=rwX,g=rX,o= "$HOME_DIR/server.new"
run chmod 750 "$HOME_DIR/bin.new" "$HOME_DIR/server.new/hooks/pre-receive"
# The staged node is checked, as the service user, before anything moves.
if ! dry; then
  sudo -u "$SVC" "$HOME_DIR/bin.new/node" -e 'const [a]=process.versions.node.split(".").map(Number); if (a<26) process.exit(1)' || fail "node 26 or later is needed; nothing was replaced"
fi
# bin.old and server.old are the last code that answered. Left by an
# attempt that failed, they are kept, and the failed code is dropped;
# otherwise the current code becomes them.
if [ -e "$HOME_DIR/bin.old" ] || [ -e "$HOME_DIR/server.old" ]; then
  run rm -rf "$HOME_DIR/bin" "$HOME_DIR/server"
else
  [ ! -e "$HOME_DIR/bin" ] || run mv "$HOME_DIR/bin" "$HOME_DIR/bin.old"
  [ ! -e "$HOME_DIR/server" ] || run mv "$HOME_DIR/server" "$HOME_DIR/server.old"
fi
run mv "$HOME_DIR/bin.new" "$HOME_DIR/bin"
run mv "$HOME_DIR/server.new" "$HOME_DIR/server"

# 6. The staging owner token: made once, kept in secrets/, never printed,
#    with one copy written by the developer's own user.
SECRET="$HOME_DIR/secrets/staging/ATELIER_TOKEN"
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
  sudo -u "$DEV" sh -c 'umask 077; d=$(dirname "$1"); mkdir -p "$d" && t=$(mktemp "$d/.staging-token.XXXXXX") && chmod 600 "$t" && cat > "$t" && mv -f "$t" "$1"' sh "$TOKEN_COPY" < "$SECRET" || fail "the token copy could not be written"
fi

# 7. The LaunchDaemon.
cat > "$WORK/plist" <<PLIST
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
    <string>$HOME_DIR/server/cli/serve.mjs</string>
    <string>--env</string><string>staging</string>
    <string>--data</string><string>$HOME_DIR/data/staging</string>
    <string>--repos</string><string>$HOME_DIR/repos/staging</string>
    <string>--secrets</string><string>$HOME_DIR/secrets/staging</string>
    <string>--host</string><string>$BIND</string>
    <string>--port</string><string>$PORT</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME_DIR/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME_DIR</string>
    <key>PUBLIC_ORIGIN</key><string>http://$BIND:$PORT</string>
  </dict>
  <key>WorkingDirectory</key><string>$HOME_DIR</string>
  <key>Umask</key><integer>63</integer>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME_DIR/log/staging.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/log/staging.log</string>
</dict>
</plist>
PLIST
plutil -lint "$WORK/plist" >/dev/null || fail "the plist does not parse"
[ ! -L "$PLIST" ] || fail "$PLIST is a link"
run install -o root -g wheel -m 644 "$WORK/plist" "$PLIST"
run launchctl bootstrap system "$PLIST"

# 8. It answers.
if ! dry; then
  for _ in $(seq 1 30); do
    if lsof -nP -a -u "$SVC" -iTCP@"$BIND":"$PORT" -sTCP:LISTEN >/dev/null 2>&1 \
      && curl -fsS --connect-timeout 1 --max-time 2 "http://$BIND:$PORT/api/version" >/dev/null 2>&1; then
      rm -rf "$HOME_DIR/bin.old" "$HOME_DIR/server.old"
      echo "staging answers at http://$BIND:$PORT, running as $SVC; the owner token is at $TOKEN_COPY"
      exit 0
    fi
    sleep 1
  done
  fail "staging did not answer in 30 s; the previous code, if any, is kept as bin.old and server.old; see $HOME_DIR/log/staging.log (sudo tail)"
fi
