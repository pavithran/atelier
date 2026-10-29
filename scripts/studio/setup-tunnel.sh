#!/bin/bash
# Atelier 2.0 on the Studio: the Cloudflare Tunnel and Access for the owner
# pages (design-branches-2026-10-28.md, sections 4.10 and 4.11; plan task 9).
# Run as root on the Studio, by the developer, who types the administrator
# password at sudo's prompt. Two steps, each run once:
#
#   sudo bash setup-tunnel.sh CLOUDFLARED CREDENTIALS.json
#       staging, after setup-server.sh --env staging (run on 2026-10-28)
#   sudo bash setup-tunnel.sh --production CLOUDFLARED CREDENTIALS.json ACCESS_AUD [--route-dns ORIGIN_CERT]
#       production, at the cut-over only, after setup-server.sh --env production
#
# CLOUDFLARED       the cloudflared binary to install for the daemon
# CREDENTIALS.json  the tunnel's credentials file (`cloudflared tunnel create`)
# ACCESS_AUD        the audience tag of the "atelier owner" Access application,
#                   which guards atelier.zone's owner pages
# ORIGIN_CERT       a cloudflared origin certificate for the atelier.zone zone.
#                   Only with --route-dns does this script touch DNS: after
#                   everything else answers, it runs the developer's own
#                   cloudflared, as the developer, to point atelier.zone at the
#                   tunnel (`tunnel route dns --overwrite-dns`). Without it,
#                   atelier.zone's DNS is left as it is. Detach atelier.zone
#                   from the 1.0 Worker's custom domain first.
#
# The production step adds atelier.zone to the tunnel beside
# next.atelier.zone, writes production's Access settings, and gives
# production the PUBLIC_ORIGIN https://atelier.zone. Like the staging step,
# it stops every atelierd job while it writes, staging's server included,
# and starts again those that ran. Run again later, the staging step keeps
# atelier.zone in the tunnel once production has it.
#
# DRYRUN=1 prints what would change and needs no root.
#
# As in setup-server.sh, the developer's sudo is the decision to trust these
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
# DNS is not touched by the staging step: next.atelier.zone moved to the
# tunnel afterwards, from the developer's Mac.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
umask 077

USAGE="usage: setup-tunnel.sh CLOUDFLARED CREDENTIALS.json
       setup-tunnel.sh --production CLOUDFLARED CREDENTIALS.json ACCESS_AUD [--route-dns ORIGIN_CERT]"
MODE=staging
if [ "${1:-}" = --production ]; then MODE=production; shift; fi
CF_SRC=${1:?$USAGE}
CREDS_SRC=${2:?$USAGE}
DNS_CERT=
if [ "$MODE" = production ]; then
  PROD_AUD=${3:?$USAGE}
  if [ $# = 5 ] && [ "$4" = --route-dns ]; then DNS_CERT=$5; elif [ $# != 3 ]; then echo "$USAGE" >&2; exit 1; fi
fi

SVC=atelierd
HOME_DIR=/Users/$SVC
TUNNEL=2293602a-6d93-433d-827d-f77084d2d9b2
HOSTNAME_STAGING=next.atelier.zone
ORIGIN_STAGING=http://100.99.0.102:4101
STAGING_PLIST=/Library/LaunchDaemons/zone.atelier.server.staging.plist
STAGING_LABEL=zone.atelier.server.staging
HOSTNAME_PROD=atelier.zone
ORIGIN_PROD=http://100.99.0.102:4100
PROD_PLIST=/Library/LaunchDaemons/zone.atelier.server.plist
PROD_LABEL=zone.atelier.server
PLIST=/Library/LaunchDaemons/zone.atelier.tunnel.plist
LABEL=zone.atelier.tunnel
ACCESS_ISS=https://pavi.cloudflareaccess.com
STAGING_AUD=9c4c4e50f2b98fdbe60e3baf8c3729dd56f6810b7a6d16505edd2606fb4fa6ec
ACCESS_EMAIL=pavi@mac.com
DEV=${SUDO_USER:-}

fail() { echo "setup: $*" >&2; exit 1; }
dry() { [ "${DRYRUN:-}" = 1 ]; }
run() { if dry; then printf '+ %s\n' "$*"; else "$@"; fi; }

dry || [ "$(id -u)" = 0 ] || fail "run as root (sudo), or DRYRUN=1"
[ -f "$CF_SRC" ] || [ -L "$CF_SRC" ] || fail "no cloudflared at $CF_SRC"
[ -f "$CREDS_SRC" ] && [ ! -L "$CREDS_SRC" ] || fail "no credentials file at $CREDS_SRC"

# The server this run changes: its hostname, origin, LaunchDaemon, secrets
# and Access audience.
if [ "$MODE" = production ]; then
  [[ "$PROD_AUD" =~ ^[0-9a-f]{64}$ ]] || fail "ACCESS_AUD must be the application's 64-character audience tag"
  [ "$PROD_AUD" != "$STAGING_AUD" ] || fail "ACCESS_AUD is staging's; production has its own application"
  if [ -n "$DNS_CERT" ]; then
    [ -f "$DNS_CERT" ] && [ ! -L "$DNS_CERT" ] || fail "no origin certificate at $DNS_CERT"
    if ! dry && { [ -z "$DEV" ] || [ "$DEV" = root ]; }; then fail "--route-dns runs cloudflared as the developer: run through sudo from the developer's account"; fi
  fi
  T_HOST=$HOSTNAME_PROD T_ORIGIN=$ORIGIN_PROD T_PLIST=$PROD_PLIST T_LABEL=$PROD_LABEL ACCESS_AUD=$PROD_AUD
else
  T_HOST=$HOSTNAME_STAGING T_ORIGIN=$ORIGIN_STAGING T_PLIST=$STAGING_PLIST T_LABEL=$STAGING_LABEL ACCESS_AUD=$STAGING_AUD
fi

safe_dir() {
  local d=$1 owner
  [ -d "$d" ] && [ ! -L "$d" ] || fail "$d is not a plain directory"
  owner=$(stat -f %Su "$d")
  [ "$owner" = root ] || [ "$owner" = "$SVC" ] || fail "$d is owned by $owner"
  [ $(( 0$(stat -f %Lp "$d") & 022 )) = 0 ] || fail "$d is writable by a group or others"
  ! ls -lde "$d" | sed -n '2,$p' | grep -q . || fail "$d carries an ACL"
}
safe_dir /Library/LaunchDaemons
dry || { dscl . -read /Users/$SVC >/dev/null 2>&1 || fail "$SVC does not exist; run setup-server.sh first"; }
dry || { safe_dir "$HOME_DIR"; safe_dir "$HOME_DIR/bin"; safe_dir "$HOME_DIR/secrets"; safe_dir "$HOME_DIR/secrets/$MODE"; }
if ! dry && { [ ! -f "$T_PLIST" ] || [ -L "$T_PLIST" ]; }; then fail "no $MODE LaunchDaemon; run setup-server.sh --env $MODE first"; fi

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
S="$HOME_DIR/secrets/$MODE"
# atelier.zone is in the tunnel from the production step on: this run's, or
# an earlier one that gave production its public origin.
with_prod=
if [ "$MODE" = production ]; then with_prod=1
elif [ -f "$PROD_PLIST" ] && [ ! -L "$PROD_PLIST" ] && [ "$(plutil -extract EnvironmentVariables.PUBLIC_ORIGIN raw -o - "$PROD_PLIST" 2>/dev/null)" = "https://$HOSTNAME_PROD" ]; then with_prod=1
fi
{
  printf 'tunnel: %s\ncredentials-file: %s\nno-autoupdate: true\ningress:\n' "$TUNNEL" "$T/$TUNNEL.json"
  printf '  - hostname: %s\n    service: %s\n' "$HOSTNAME_STAGING" "$ORIGIN_STAGING"
  [ -z "$with_prod" ] || printf '  - hostname: %s\n    service: %s\n' "$HOSTNAME_PROD" "$ORIGIN_PROD"
  printf '  - service: http_status:404\n'
} > "$WORK/config.yml"
if dry && [ "$MODE" = production ]; then sed 's/^/+ config.yml: /' "$WORK/config.yml"; fi
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
  echo "+ (copy $T_PLIST, set PUBLIC_ORIGIN to https://$T_HOST, check it parses)"
else
  cp "$T_PLIST" "$WORK/server.old.plist"
  cp "$T_PLIST" "$WORK/server.plist"
  plutil -replace EnvironmentVariables.PUBLIC_ORIGIN -string "https://$T_HOST" "$WORK/server.plist"
  plutil -lint "$WORK/server.plist" >/dev/null || fail "the edited $MODE plist does not parse"
fi
[ ! -L "$PLIST" ] || fail "$PLIST is a link"

# 3. Stop every atelierd job (both servers, the tunnel, the backups) and
#    confirm nothing of the service user's runs while root writes in its
#    directories. The jobs that ran start again afterwards. A failure from
#    here on puts back the server's previous LaunchDaemon, the Access
#    settings and the tunnel's config and plist, and starts every job that ran.
JOBS="zone.atelier.server.staging zone.atelier.server zone.atelier.tunnel zone.atelier.backup.staging zone.atelier.backup.production"
stopped=
snapshot=
loaded=
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
# Starts the jobs that were loaded, but those named, which were started already.
start_loaded() {
  local job skip=" $* " rc=0
  for job in $JOBS; do
    case "$skip" in *" $job "*) continue ;; esac
    case " $loaded " in *" $job "*) launchctl bootstrap system "/Library/LaunchDaemons/$job.plist" || { echo "setup: $job did not start; sudo launchctl bootstrap system /Library/LaunchDaemons/$job.plist" >&2; rc=1; } ;; esac
  done
  return $rc
}
restore() {
  [ -n "$stopped" ] || return 0
  # Recovery decides by its own checks, not by set -e.
  set +e
  echo "setup: putting the previous $MODE server and tunnel back" >&2
  # Recovery writes only under the same rules as the install: every job
  # unloaded, nothing of the service user's running, its directories safe.
  # Short of that it changes nothing and says so.
  if ! stop_all; then echo "setup: nothing was restored" >&2; return 1; fi
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
  install -o root -g wheel -m 644 "$WORK/server.old.plist" "$T_PLIST" || echo "setup: could not restore $T_PLIST" >&2
  [ ! -f "$WORK/config.old.yml" ] || install -o "$SVC" -g "$SVC" -m 600 "$WORK/config.old.yml" "$T/config.yml" || echo "setup: could not restore $T/config.yml" >&2
  [ ! -f "$WORK/tunnel.old.plist" ] || install -o root -g wheel -m 644 "$WORK/tunnel.old.plist" "$PLIST" || echo "setup: could not restore $PLIST" >&2
  # The server this run changes starts again, as staging's recovery always
  # did; every other job only if it ran.
  launchctl bootstrap system "$T_PLIST" || echo "setup: the previous $MODE server did not start; sudo launchctl bootstrap system $T_PLIST" >&2
  start_loaded "$T_LABEL"
}
trap 'status=$?; [ $status = 0 ] || restore; rm -rf "$WORK"; exit $status' EXIT
for job in $JOBS; do [ ! -L "/Library/LaunchDaemons/$job.plist" ] || fail "/Library/LaunchDaemons/$job.plist is a link"; done
if ! dry; then
  # What ran, and the tunnel's current config and plist, so a failure puts
  # them back as they were.
  for job in $JOBS; do
    if launchctl print "system/$job" >/dev/null 2>&1; then
      [ -f "/Library/LaunchDaemons/$job.plist" ] || fail "$job is loaded but its plist is missing; it could not be started again"
      loaded="$loaded $job"
    fi
  done
  [ ! -L "$T/config.yml" ] || fail "$T/config.yml is a link"
  [ ! -f "$T/config.yml" ] || cp "$T/config.yml" "$WORK/config.old.yml"
  [ ! -f "$PLIST" ] || cp "$PLIST" "$WORK/tunnel.old.plist"
  stopped=1
  stop_all || fail "the $SVC jobs could not all be stopped"
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
dry || install -o root -g wheel -m 644 "$WORK/server.plist" "$T_PLIST"

# 5. The server first, then the tunnel in front of it.
run launchctl bootstrap system "$T_PLIST"
run launchctl bootstrap system "$PLIST"

# 6. Both answer: the server with the new origin, the tunnel registered in
#    this run's log.
if ! dry; then
  ok=
  for _ in $(seq 1 30); do
    if curl -fsS --connect-timeout 1 --max-time 2 "$T_ORIGIN/api/version" >/dev/null 2>&1 \
      && launchctl print "system/$T_LABEL" 2>/dev/null | grep -q "PUBLIC_ORIGIN => https://$T_HOST" \
      && grep -q "Registered tunnel connection" "$HOME_DIR/log/tunnel.log" 2>/dev/null; then ok=1; break; fi
    sleep 1
  done
  [ -n "$ok" ] || fail "$MODE or the tunnel did not come up in 30 s; see $HOME_DIR/log/$MODE.log and tunnel.log (sudo tail)"
  stopped=
  start_loaded "$T_LABEL" "$LABEL" || echo "setup: start the jobs named above by hand" >&2
  echo "the tunnel is registered and $MODE answers at $T_ORIGIN with origin https://$T_HOST"
fi

# 7. DNS, only when asked: the production step with --route-dns. The
#    developer's own cloudflared, run as the developer, with the certificate
#    the developer gave. A certificate for another zone would add a record
#    under that zone (atelier.zone.OTHER), so the answer must name
#    atelier.zone exactly.
if [ -n "$DNS_CERT" ]; then
  if dry; then
    printf '+ sudo -H -u %s %s tunnel --origincert %s route dns --overwrite-dns %s %s\n' "$DEV" "$CF_SRC" "$DNS_CERT" "$TUNNEL" "$T_HOST"
  else
    sudo -H -u "$DEV" "$CF_SRC" tunnel --origincert "$DNS_CERT" route dns --overwrite-dns "$TUNNEL" "$T_HOST" > "$WORK/dns.out" 2>&1 \
      || { cat "$WORK/dns.out" >&2; echo "setup: the DNS route failed; the tunnel and $MODE are up, and $T_HOST's DNS is as cloudflared left it" >&2; exit 2; }
    cat "$WORK/dns.out"
    host_re=${T_HOST//./\\.}
    grep -qE "(Added CNAME $host_re which will route to this tunnel|(^|[[:space:]])$host_re is already configured to route to your tunnel)" "$WORK/dns.out" \
      || { echo "setup: cloudflared did not report $T_HOST itself; check the zone's DNS records now: a certificate for another zone adds $T_HOST under that zone" >&2; exit 2; }
    echo "$T_HOST now routes to the tunnel"
  fi
elif [ "$MODE" = production ]; then
  echo "$T_HOST's DNS was not touched; to point it at the tunnel, run again with --route-dns ORIGIN_CERT, or change the record by hand"
else
  dry || echo "next, point $T_HOST at the tunnel"
fi
