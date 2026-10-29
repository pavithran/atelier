#!/bin/bash
# Atelier 2.0 on the Studio: install the server at a commit of the project's
# branch, or roll back to the release before (design-branches-2026-10-28.md,
# section 4.1; plan task 9). setup-server.sh installs this script, root's, at
# /Library/Atelier/install-server.sh, outside every release; nothing else
# changes it. `atelier ship` runs it under sudo with two arguments:
#
#   sudo /Library/Atelier/install-server.sh --env staging|production COMMIT
#   sudo /Library/Atelier/install-server.sh --env staging|production --rollback
#
# The developer types the administrator password at sudo's own prompt;
# nothing here reads or passes one.
#
# Trust. Agents run as the developer's user, so nothing that user can write is
# ever run as root or as atelierd. The release is built here, by root, from
# the Studio's own repository of the project, which only reviewed, landed
# commits reach (the hook). Nothing comes from the caller but the commit id:
# 1. As atelierd, with no configuration but the repository's own and no
#    hooks, git checks that COMMIT is on the project's branch (the
#    repository's HEAD) and writes `git archive COMMIT`.
# 2. Root checks the archive holds only plain files and directories inside
#    itself, and extracts it into a fresh root-owned directory.
# 3. The runtime packages: each package the archived lock file installs
#    (dev packages aside) is fetched as atelierd, from the npm registry,
#    into an atelierd-owned scratch directory, and kept only if its SHA-512
#    is the lock file's `integrity`. No install script runs. Root copies the
#    result in. This is `npm ci --ignore-scripts` for a lock file whose
#    packages come from the registry; the Studio has no npm of root's own,
#    and Homebrew's belongs to the developer's user, so none is run.
# 4. Root writes COMMIT, which /api/version reports: true by construction.
#
# The swap, which recovers from a failure at any point:
#   stop the daemon; SERVER -> SERVER.prev; SERVER.new -> SERVER; start it;
#   wait at most 60 s for /api/version to report COMMIT.
# On a failure the daemon is stopped, a new release in place moves to
# SERVER.failed, SERVER.prev moves back if SERVER is missing, and what is
# there starts again. Every run first settles what an interrupted run left:
# SERVER missing with SERVER.prev present puts SERVER.prev back.
# --rollback swaps SERVER and SERVER.prev the same way.
#
# SERVER is /Users/atelierd/server for staging, server-production for
# production.
#
# Run as root only. A test, not root, may point it at a scratch home with
# ATELIER_INSTALL_TEST_HOME, where it runs git, node and the launchctl, lsof
# and curl it finds on PATH, as itself, changes no owners, waits
# ATELIER_INSTALL_TEST_WAIT seconds where it would wait 60, and fetches
# packages from ATELIER_INSTALL_TEST_REGISTRY; as root none of these is read.
set -euo pipefail
umask 077
# Nothing here reads the caller's directory, which atelierd may not enter.
cd /

fail() { echo "install: $*" >&2; exit 1; }
SVC=atelierd
if [ "$(id -u)" = 0 ]; then
  export PATH=/usr/bin:/bin:/usr/sbin:/sbin
  HOME_DIR=/Users/$SVC
  DAEMONS=/Library/LaunchDaemons
  OWNER=root
  TEST=
  WAIT=60
  REGISTRY=https://registry.npmjs.org/
  NODE=$HOME_DIR/bin/node
  as_svc() { sudo -u "$SVC" /usr/bin/env -i HOME="$HOME_DIR" PATH=/usr/bin:/bin:/usr/sbin:/sbin LC_ALL=C "$@"; }
elif [ -n "${ATELIER_INSTALL_TEST_HOME:-}" ]; then
  HOME_DIR=$ATELIER_INSTALL_TEST_HOME
  DAEMONS=$HOME_DIR/LaunchDaemons
  SVC=$(id -un)
  OWNER=$SVC
  TEST=1
  WAIT=${ATELIER_INSTALL_TEST_WAIT:-60}
  [[ "$WAIT" =~ ^[0-9]{1,3}$ ]] || fail "ATELIER_INSTALL_TEST_WAIT is a number of seconds"
  REGISTRY=${ATELIER_INSTALL_TEST_REGISTRY:-https://registry.npmjs.org/}
  NODE=$(command -v node)
  as_svc() { /usr/bin/env -i HOME="$HOME_DIR" PATH="$PATH" LC_ALL=C "$@"; }
else
  fail "run as root (sudo)"
fi

USAGE="usage: install-server.sh --env staging|production COMMIT
       install-server.sh --env staging|production --rollback"
[ $# = 3 ] && [ "$1" = --env ] || fail "$USAGE"
ENV=$2
COMMIT= ROLLBACK=
if [ "$3" = --rollback ]; then ROLLBACK=1
else COMMIT=$3; [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "the commit must be 40 hexadecimal digits"
fi
case "$ENV" in
  staging) LABEL=zone.atelier.server.staging; SERVER=server ;;
  production) LABEL=zone.atelier.server; SERVER=server-production ;;
  *) fail "$USAGE" ;;
esac
PLIST=$DAEMONS/$LABEL.plist
S=$HOME_DIR/$SERVER
REPO=$HOME_DIR/repos/$ENV/atelier.git

# git as atelierd: no system or global configuration, no hooks, no prompt.
git_svc() { as_svc GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git -c core.hooksPath=/dev/null -C "$REPO" "$@"; }

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
for d in "$S" "$S.prev" "$S.swap"; do [ ! -e "$d" ] || safe_dir "$d"; done

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
DEPS=
phase=
trap 'rm -rf "$WORK" ${DEPS:+"$DEPS"}' EXIT

commit_of() { local c; c=$(cat "$1/COMMIT" 2>/dev/null) && [[ "$c" =~ ^[0-9a-f]{40}$ ]] && printf '%s\n' "$c"; }
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

# What an interrupted run left, settled before anything else: a rollback's
# SERVER.swap goes back where it is missing from, and SERVER.prev goes back
# when SERVER is missing.
settle() {
  if [ -e "$S.swap" ]; then
    if [ ! -e "$S" ]; then mv "$S.swap" "$S" || return 1
    elif [ ! -e "$S.prev" ]; then mv "$S.swap" "$S.prev" || return 1
    else echo "install: $S, $S.prev and $S.swap all exist; sort them by hand" >&2; return 1
    fi
  fi
  if [ ! -e "$S" ] && [ -d "$S.prev" ]; then
    echo "install: $S was missing; putting $S.prev back" >&2
    mv "$S.prev" "$S" || return 1
  fi
}

# Recovery, after a failure once the daemon was stopped, whatever the phase:
# stopped (nothing moved), prev (SERVER moved to SERVER.prev), placed or
# started (the new release in SERVER). For a rollback: swap1, swap2, swap3
# after each of its moves. It decides by its own checks, not by set -e.
recover() {
  set +e
  echo "install: putting back what ran before" >&2
  if ! stop_daemon; then echo "install: $LABEL would not stop; nothing was put back; see $HOME_DIR/log/$ENV.log (sudo tail)" >&2; return 1; fi
  case "$phase" in
    placed|started)
      if [ -d "$S.prev" ]; then
        rm -rf "$S.failed"
        mv "$S" "$S.failed" || { echo "install: the new release could not be moved aside; $ENV is stopped" >&2; return 1; }
      fi ;;
    swap3)
      mv "$S" "$S.swap" || { echo "install: the rollback could not be undone; $ENV is stopped" >&2; return 1; } ;;
  esac
  case "$phase" in
    swap2) mv "$S" "$S.prev" || { echo "install: the rollback could not be undone; $ENV is stopped" >&2; return 1; } ;;
    swap3) mv "$S.prev" "$S" || { echo "install: the rollback could not be undone; $ENV is stopped" >&2; return 1; } ;;
  esac
  settle || { echo "install: the releases could not be put back; $ENV is stopped; see $HOME_DIR" >&2; return 1; }
  [ -d "$S" ] || { echo "install: there is no release to start; $ENV is stopped" >&2; return 1; }
  launchctl bootstrap system "$PLIST" || { echo "install: $LABEL did not start; sudo launchctl bootstrap system $PLIST" >&2; return 1; }
  local back
  back=$(commit_of "$S") || back=
  if answers "$back" "$WAIT"; then
    echo "install: $ENV answers again at commit ${back:-unknown}, the release that ran before${phase:+ (failed at: $phase)}" >&2
    [ ! -d "$S.failed" ] || echo "install: the release that failed is kept as $S.failed" >&2
  else
    echo "install: the release that ran before is in place but does not answer; see $HOME_DIR/log/$ENV.log (sudo tail)" >&2
    return 1
  fi
}
trap 'status=$?; if [ $status != 0 ] && [ -n "$phase" ]; then recover; fi; rm -rf "$WORK" ${DEPS:+"$DEPS"}; exit $status' EXIT

settle || fail "the releases left by an earlier run could not be settled"

if [ -n "$ROLLBACK" ]; then
  [ -d "$S.prev" ] || fail "there is no previous release to roll back to ($S.prev)"
  [ -d "$S" ] || fail "there is no current release ($S)"
  want=$(commit_of "$S.prev") || want=
  from=$(commit_of "$S") || from=
  phase=stopped
  stop_daemon || fail "$LABEL would not stop, or something still listens on $BIND:$PORT"
  mv "$S" "$S.swap"; phase=swap1
  mv "$S.prev" "$S"; phase=swap2
  mv "$S.swap" "$S.prev"; phase=swap3
  launchctl bootstrap system "$PLIST" || fail "$LABEL did not start"
  answers "$want" "$WAIT" || fail "the previous release did not answer${want:+ with commit $want} in $WAIT s"
  phase=
  echo "rolled $ENV back to commit ${want:-unknown}; the release it replaced (${from:-unknown}) is kept as $S.prev"
  exit 0
fi

# 1. The commit, on the project's branch, archived by atelierd.
[ -d "$REPO" ] && [ ! -L "$REPO" ] || fail "no repository at $REPO"
git_svc cat-file -e "$COMMIT^{commit}" 2>/dev/null || fail "$COMMIT is not a commit in $REPO"
BRANCH=$(git_svc symbolic-ref -q HEAD) || fail "$REPO's HEAD names no branch"
[[ "$BRANCH" =~ ^refs/heads/[A-Za-z0-9._/-]+$ ]] || fail "$REPO's HEAD is $BRANCH"
git_svc merge-base --is-ancestor "$COMMIT" "$BRANCH" || fail "$COMMIT is not on ${BRANCH#refs/heads/}, the project's branch; only landed commits are installed"
git_svc archive --format=tar "$COMMIT" > "$WORK/server.tar" || fail "git archive $COMMIT failed"

# 2. Plain files and directories inside the release, extracted by root.
# Listed to files first: a grep -q in a pipe can end the pipe early and,
# under pipefail, read as no match.
tar -tvf "$WORK/server.tar" > "$WORK/list-long" || fail "the archive cannot be listed"
tar -tf "$WORK/server.tar" > "$WORK/list" || fail "the archive cannot be listed"
[ -s "$WORK/list" ] || fail "the archive is empty"
if awk '{t=substr($1,1,1); if (t!="-" && t!="d") bad=1} END {exit bad?0:1}' "$WORK/list-long" || grep -q ' link to ' "$WORK/list-long"; then
  fail "the archive holds a link or something else that is not a plain file or directory"
fi
if grep -E '(^/|(^|/)\.\.(/|$))' "$WORK/list" >/dev/null; then fail "the archive names a path outside itself"; fi
mkdir "$WORK/server"
tar -xof "$WORK/server.tar" -C "$WORK/server"
for f in cli/serve.mjs hooks/pre-receive package.json package-lock.json; do [ -f "$WORK/server/$f" ] && [ ! -L "$WORK/server/$f" ] || fail "the release lacks $f"; done
[ ! -e "$WORK/server/node_modules" ] || fail "the release holds node_modules"

# 3. The runtime packages, as atelierd, checked against the lock file.
DEPS=$(mktemp -d /var/tmp/atelier-deps.XXXXXX)
cp "$WORK/server/package.json" "$WORK/server/package-lock.json" "$DEPS/"
[ -n "$TEST" ] || chown -R "$SVC:$SVC" "$DEPS"
FETCH=$(cat <<'JS'
const [dir, registry] = process.argv.slice(1);
const { readFileSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
const { createHash } = await import("node:crypto");
const { execFileSync } = await import("node:child_process");
const { join } = await import("node:path");
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
const no = (why) => { console.error(`install: ${why}`); process.exit(1); };
if (lock.lockfileVersion < 2 || typeof lock.packages !== "object") no("the lock file has no packages list (lockfileVersion 2 or later)");
const PATH = /^(?:node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:\/node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)*$/;
for (const name of Object.keys(pkg.dependencies ?? {})) {
  const p = lock.packages[`node_modules/${name}`];
  if (!p || p.dev) no(`the lock file does not install ${name}, which package.json needs; it is out of step`);
}
let n = 0;
for (const [path, p] of Object.entries(lock.packages)) {
  if (path === "" || p.dev) continue;
  if (!PATH.test(path)) no(`the lock file names a package at ${JSON.stringify(path)}`);
  if (p.link) no(`${path} is a link in the lock file`);
  if (typeof p.resolved !== "string" || !p.resolved.startsWith(registry)) no(`${path} does not come from ${registry}`);
  if (typeof p.integrity !== "string" || !p.integrity.startsWith("sha512-")) no(`${path} has no sha512 integrity`);
  const res = await fetch(p.resolved, { redirect: "error" });
  if (res.status !== 200) no(`${p.resolved} answered ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== p.integrity) no(`${path} does not match its integrity in the lock file`);
  const tgz = join(dir, `package-${n++}.tgz`);
  writeFileSync(tgz, bytes);
  const listed = execFileSync("tar", ["-tvzf", tgz], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const line of listed) if (!/^[-d]/.test(line) || / link to /.test(line)) no(`${path}'s package holds a link or a special file`);
  for (const name of execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).split("\n").filter(Boolean)) {
    if (!name.startsWith("package/") || /(^|\/)\.\.(\/|$)/.test(name)) no(`${path}'s package names ${name}, outside package/`);
  }
  mkdirSync(join(dir, path), { recursive: true });
  execFileSync("tar", ["-xzf", tgz, "-C", join(dir, path), "--strip-components", "1"]);
  rmSync(tgz);
}
console.log(`install: ${n} runtime package${n === 1 ? "" : "s"} fetched and checked against the lock file`);
JS
)
as_svc "$NODE" --input-type=module -e "$FETCH" "$DEPS" "$REGISTRY" || fail "the runtime packages could not be installed; nothing was changed"
if [ -d "$DEPS/node_modules" ]; then
  [ -z "$(find "$DEPS/node_modules" ! -type f ! -type d)" ] || fail "the runtime packages hold a link or a special file"
  cp -R "$DEPS/node_modules" "$WORK/server/node_modules"
fi

# 4. COMMIT, written by root.
printf '%s\n' "$COMMIT" > "$WORK/server/COMMIT"

# Staged beside the current release, root's and read-only to the daemon.
rm -rf "$S.new" "$S.failed"
cp -R "$WORK/server" "$S.new"
[ -n "$TEST" ] || chown -R root:"$SVC" "$S.new"
chmod -R u=rwX,g=rX,o= "$S.new"
chmod 750 "$S.new/hooks/pre-receive"
chmod -RN "$S.new"
prev=$(commit_of "$S") || prev=

# The swap. From here a failure runs recover() for the phase reached.
phase=stopped
stop_daemon || fail "$LABEL would not stop, or something still listens on $BIND:$PORT"
if [ -e "$S" ]; then
  rm -rf "$S.prev"
  mv "$S" "$S.prev"
fi
phase=prev
mv "$S.new" "$S"
phase=placed
launchctl bootstrap system "$PLIST" || fail "$LABEL did not start"
phase=started
answers "$COMMIT" "$WAIT" || fail "$ENV did not report commit $COMMIT at http://$BIND:$PORT/api/version in $WAIT s"
phase=
echo "$ENV runs commit $COMMIT at http://$BIND:$PORT; the previous release (${prev:-none}) is kept as $S.prev for rollback"
