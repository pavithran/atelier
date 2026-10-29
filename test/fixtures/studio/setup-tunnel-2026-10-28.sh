#!/bin/bash
# Atelier 2.0 on the Studio: the Cloudflare Tunnel for staging and Access
# for its owner pages (design-branches-2026-10-28.md, sections 4.10 and
# 4.11; plan task 9). Run as root on the Studio, after setup-staging.sh, by
# the developer, who types the administrator password at sudo's prompt:
#
#   sudo bash setup-tunnel.sh CLOUDFLARED CREDENTIALS.json
#
# CLOUDFLARED       the cloudflared binary to install for the daemon
# CREDENTIALS.json  the tunnel's credentials file (`cloudflared tunnel create`)
#
# DRYRUN=1 prints what would change and needs no root.
#
# As in setup-staging.sh, the developer's sudo is the decision to trust these
# bytes once: they are copied into root-owned storage, checked there, and never
# run as root. What it makes:
# - /Users/atelierd/bin/cloudflared, root-owned, run by atelierd.
# - /Users/atelierd/secrets/tunnel/: the credentials and the tunnel's config,
#   atelierd's alone. The copy the developer gave is left for the developer
#   to remove: root deletes nothing in a path the developer's user controls.
# - /Users/atelierd/secrets/staging/CF_ACCESS_*: the Access settings the
#   staging server checks owner pages against (src/access.ts).
# - /Library/LaunchDaemons/zone.atelier.tunnel.plist: cloudflared as atelierd,
#   carrying next.atelier.zone to the staging server on the tailnet address.
# - The staging server's PUBLIC_ORIGIN becomes https://next.atelier.zone, and
#   it restarts to read the Access settings.
# DNS is not touched here: next.atelier.zone moves to the tunnel afterwards,
# from the developer's Mac.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
umask 077

CF_SRC=${1:?usage: setup-tunnel.sh CLOUDFLARED CREDENTIALS.json}
CREDS_SRC=${2:?usage: setup-tunnel.sh CLOUDFLARED CREDENTIALS.json}

SVC=atelierd
HOME_DIR=/Users/$SVC
TUNNEL=2293602a-6d93-433d-827d-f77084d2d9b2
HOSTNAME_STAGING=next.atelier.zone
ORIGIN=http://100.99.0.102:4101
STAGING_PLIST=/Library/LaunchDaemons/zone.atelier.server.staging.plist
STAGING_LABEL=zone.atelier.server.staging
PLIST=/Library/LaunchDaemons/zone.atelier.tunnel.plist
LABEL=zone.atelier.tunnel
ACCESS_ISS=https://pavi.cloudflareaccess.com
ACCESS_AUD=9c4c4e50f2b98fdbe60e3baf8c3729dd56f6810b7a6d16505edd2606fb4fa6ec
ACCESS_EMAIL=pavi@mac.com

fail() { echo "setup: $*" >&2; exit 1; }
dry() { [ "${DRYRUN:-}" = 1 ]; }
run() { if dry; then printf '+ %s\n' "$*"; else "$@"; fi; }

dry || [ "$(id -u)" = 0 ] || fail "run as root (sudo), or DRYRUN=1"
[ -f "$CF_SRC" ] || [ -L "$CF_SRC" ] || fail "no cloudflared at $CF_SRC"
[ -f "$CREDS_SRC" ] && [ ! -L "$CREDS_SRC" ] || fail "no credentials file at $CREDS_SRC"

safe_dir() {
  local d=$1 owner
  [ -d "$d" ] && [ ! -L "$d" ] || fail "$d is not a plain directory"
  owner=$(stat -f %Su "$d")
  [ "$owner" = root ] || [ "$owner" = "$SVC" ] || fail "$d is owned by $owner"
  [ $(( 0$(stat -f %Lp "$d") & 022 )) = 0 ] || fail "$d is writable by a group or others"
  ! ls -lde "$d" | sed -n '2,$p' | grep -q . || fail "$d carries an ACL"
}
safe_dir /Library/LaunchDaemons
dry || { dscl . -read /Users/$SVC >/dev/null 2>&1 || fail "$SVC does not exist; run setup-staging.sh first"; }
dry || { safe_dir "$HOME_DIR"; safe_dir "$HOME_DIR/bin"; safe_dir "$HOME_DIR/secrets"; safe_dir "$HOME_DIR/secrets/staging"; }
if ! dry && { [ ! -f "$STAGING_PLIST" ] || [ -L "$STAGING_PLIST" ]; }; then fail "no staging LaunchDaemon; run setup-staging.sh first"; fi

WORK=$(mktemp -d /var/tmp/atelier-tunnel.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

# 1. Inputs into root-owned storage, then checked there.
cp -L "$CF_SRC" "$WORK/cloudflared"
chmod 755 "$WORK/cloudflared"
cp "$CREDS_SRC" "$WORK/creds.json"
otool -L "$WORK/cloudflared" > "$WORK/libs" || fail "cloudflared is not a Mach-O binary"
sed 1d "$WORK/libs" | awk '{print $1}' > "$WORK/libs.list"
if grep -vE '^(/System/Library/|/usr/lib/)' "$WORK/libs.list" >/dev/null; then fail "cloudflared links a library outside the system ones"; fi
for key in AccountTag TunnelSecret TunnelID; do
  plutil -extract "$key" raw -o - "$WORK/creds.json" >/dev/null 2>&1 || fail "the credentials file has no $key"
done
[ "$(plutil -extract TunnelID raw -o - "$WORK/creds.json")" = "$TUNNEL" ] || fail "the credentials are not for tunnel $TUNNEL"

# 2. Everything is prepared and checked here before any service stops.
T="$HOME_DIR/secrets/tunnel"
S="$HOME_DIR/secrets/staging"
cat > "$WORK/config.yml" <<YML
tunnel: $TUNNEL
credentials-file: $T/$TUNNEL.json
no-autoupdate: true
ingress:
  - hostname: $HOSTNAME_STAGING
    service: $ORIGIN
  - service: http_status:404
YML
for pair in "CF_ACCESS_ISS=$ACCESS_ISS" "CF_ACCESS_AUD=$ACCESS_AUD" "CF_ACCESS_OWNER_EMAIL=$ACCESS_EMAIL"; do
  printf '%s\n' "${pair#*=}" > "$WORK/${pair%%=*}"
done
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
    <string>$HOME_DIR/bin/cloudflared</string>
    <string>tunnel</string>
    <string>--config</string><string>$T/config.yml</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME_DIR</string>
  </dict>
  <key>WorkingDirectory</key><string>$HOME_DIR</string>
  <key>Umask</key><integer>63</integer>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME_DIR/log/tunnel.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/log/tunnel.log</string>
</dict>
</plist>
PLIST
plutil -lint "$WORK/plist" >/dev/null || fail "the tunnel plist does not parse"
if dry; then
  echo "+ (copy $STAGING_PLIST, set PUBLIC_ORIGIN to https://$HOSTNAME_STAGING, check it parses)"
else
  cp "$STAGING_PLIST" "$WORK/staging.old.plist"
  cp "$STAGING_PLIST" "$WORK/staging.plist"
  plutil -replace EnvironmentVariables.PUBLIC_ORIGIN -string "https://$HOSTNAME_STAGING" "$WORK/staging.plist"
  plutil -lint "$WORK/staging.plist" >/dev/null || fail "the edited staging plist does not parse"
fi
[ ! -L "$PLIST" ] || fail "$PLIST is a link"

# 3. Stop both services, and confirm nothing of the service user's runs
#    while root writes in its directories. A failure from here on puts the
#    previous staging LaunchDaemon back and starts it.
stopped=
snapshot=
restore() {
  [ -n "$stopped" ] || return 0
  # Recovery decides by its own checks, not by set -e.
  set +e
  echo "setup: putting the previous staging server back" >&2
  # Recovery writes only under the same rules as the install: both jobs
  # unloaded, nothing of the service user's running, its directories safe.
  # Short of that it changes nothing and says so.
  local job
  for job in "$LABEL" "$STAGING_LABEL"; do
    launchctl print "system/$job" >/dev/null 2>&1 && launchctl bootout "system/$job" 2>/dev/null
    for _ in $(seq 1 20); do launchctl print "system/$job" >/dev/null 2>&1 || break; sleep 0.5; done
    if launchctl print "system/$job" >/dev/null 2>&1; then echo "setup: $job would not stop; nothing was restored" >&2; return 1; fi
  done
  for _ in $(seq 1 20); do pgrep -u "$SVC" >/dev/null || break; sleep 0.5; done
  if pgrep -u "$SVC" >/dev/null; then echo "setup: a process of $SVC is running; nothing was restored" >&2; return 1; fi
  if ! ( safe_dir "$HOME_DIR" && safe_dir "$HOME_DIR/secrets" && safe_dir "$S" ) 2>/dev/null; then
    echo "setup: $S is not safe to write; nothing was restored" >&2; return 1
  fi
  # The Access settings, only when this run had recorded them all before
  # writing: put back as they were, or removed where there were none.
  if [ -n "$snapshot" ]; then
    local name
    for name in CF_ACCESS_ISS CF_ACCESS_AUD CF_ACCESS_OWNER_EMAIL; do
      if [ -f "$WORK/old.$name" ]; then install -o "$SVC" -g "$SVC" -m 600 "$WORK/old.$name" "$S/$name" || echo "setup: could not restore $S/$name" >&2
      elif [ -f "$WORK/none.$name" ] && [ ! -L "$S/$name" ]; then rm -f "$S/$name" || echo "setup: could not remove $S/$name" >&2; fi
    done
  fi
  install -o root -g wheel -m 644 "$WORK/staging.old.plist" "$STAGING_PLIST" || echo "setup: could not restore $STAGING_PLIST" >&2
  launchctl bootstrap system "$STAGING_PLIST" || echo "setup: the previous staging server did not start; sudo launchctl bootstrap system $STAGING_PLIST" >&2
}
trap 'status=$?; [ $status = 0 ] || restore; rm -rf "$WORK"; exit $status' EXIT
stop_job() {
  launchctl print "system/$1" >/dev/null 2>&1 || return 0
  launchctl bootout "system/$1" || fail "$1 would not stop"
  for _ in $(seq 1 20); do launchctl print "system/$1" >/dev/null 2>&1 || return 0; sleep 0.5; done
  fail "$1 is still loaded"
}
if ! dry; then
  stopped=1
  stop_job "$LABEL"
  stop_job "$STAGING_LABEL"
  for _ in $(seq 1 20); do pgrep -u "$SVC" >/dev/null || break; sleep 0.5; done
  ! pgrep -u "$SVC" >/dev/null || fail "a process of $SVC is still running"
fi

# 4. Install, the service user stopped. Its directories are checked again
#    now that nothing of it runs, and every target is refused if it is a link.
if ! dry; then
  safe_dir "$HOME_DIR"; safe_dir "$HOME_DIR/bin"; safe_dir "$HOME_DIR/secrets"; safe_dir "$S"; safe_dir "$HOME_DIR/log"
  [ ! -e "$T" ] || safe_dir "$T"
  # What the Access settings were, so a failure puts them back; recovery
  # uses this only once all three are recorded.
  for name in CF_ACCESS_ISS CF_ACCESS_AUD CF_ACCESS_OWNER_EMAIL; do
    [ ! -L "$S/$name" ] || fail "$S/$name is a link"
    if [ -f "$S/$name" ]; then cp "$S/$name" "$WORK/old.$name"; else : > "$WORK/none.$name"; fi
  done
  snapshot=1
fi
[ ! -L "$T" ] || fail "$T is a link"
run install -o root -g "$SVC" -m 750 "$WORK/cloudflared" "$HOME_DIR/bin/cloudflared.new"
run mv -f "$HOME_DIR/bin/cloudflared.new" "$HOME_DIR/bin/cloudflared"
run mkdir -p "$T"
run chown "$SVC:$SVC" "$T"
run chmod 700 "$T"
dry || safe_dir "$T"
for f in "$T/$TUNNEL.json" "$T/config.yml" "$S/CF_ACCESS_ISS" "$S/CF_ACCESS_AUD" "$S/CF_ACCESS_OWNER_EMAIL" "$HOME_DIR/log/tunnel.log" "$HOME_DIR/log/tunnel.log.prev"; do
  [ ! -L "$f" ] || fail "$f is a link"
done
run install -o "$SVC" -g "$SVC" -m 600 "$WORK/creds.json" "$T/$TUNNEL.json"
run install -o "$SVC" -g "$SVC" -m 600 "$WORK/config.yml" "$T/config.yml"
for name in CF_ACCESS_ISS CF_ACCESS_AUD CF_ACCESS_OWNER_EMAIL; do
  run install -o "$SVC" -g "$SVC" -m 600 "$WORK/$name" "$S/$name"
done
# This run's tunnel log starts empty, so readiness reads this run alone.
[ ! -e "$HOME_DIR/log/tunnel.log" ] || run mv -f "$HOME_DIR/log/tunnel.log" "$HOME_DIR/log/tunnel.log.prev"
run install -o root -g wheel -m 644 "$WORK/plist" "$PLIST"
dry || install -o root -g wheel -m 644 "$WORK/staging.plist" "$STAGING_PLIST"

# 5. Staging first, then the tunnel in front of it.
run launchctl bootstrap system "$STAGING_PLIST"
run launchctl bootstrap system "$PLIST"

# 6. Both answer: staging with the new origin, the tunnel registered in
#    this run's log.
if ! dry; then
  ok=
  for _ in $(seq 1 30); do
    if curl -fsS --connect-timeout 1 --max-time 2 "$ORIGIN/api/version" >/dev/null 2>&1 \
      && launchctl print system/$STAGING_LABEL 2>/dev/null | grep -q "PUBLIC_ORIGIN => https://$HOSTNAME_STAGING" \
      && grep -q "Registered tunnel connection" "$HOME_DIR/log/tunnel.log" 2>/dev/null; then ok=1; break; fi
    sleep 1
  done
  [ -n "$ok" ] || fail "staging or the tunnel did not come up in 30 s; see $HOME_DIR/log/staging.log and tunnel.log (sudo tail)"
  stopped=
  echo "the tunnel is registered and staging answers at $ORIGIN with origin https://$HOSTNAME_STAGING; next, point $HOSTNAME_STAGING at the tunnel"
fi
