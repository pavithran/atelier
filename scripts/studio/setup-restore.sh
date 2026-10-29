#!/bin/bash -p
# Privileged bash ignores BASH_ENV, imported functions and shell options.
# Root retains no caller environment.
if builtin test "$EUID" = 0; then
  case ":$SHELLOPTS:" in *:privileged:*) ;; *) builtin echo "privileged bash (-p) is required" >&2; exit 1 ;; esac
  for inherited in $(builtin compgen -e); do
    builtin export -n "$inherited"
    builtin unset "$inherited" 2>/dev/null || :
  done
  export PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/root LC_ALL=C
fi
unset DEVELOPER_DIR
umask 077
SOURCE=${BASH_SOURCE[0]}
case "$SOURCE" in /*) ;; *) SOURCE="$(builtin pwd -P)/$SOURCE" ;; esac
cd /
# Atelier 2.0 on the Studio: puts a restored environment in place (plan task
# 12; docs/studio.md, "Restoring for real"). The backup is decrypted and
# restored on the developer's Mac with cli/restore.mjs, where the age
# identity is; the identity never comes to the Studio. The restored
# directories come here as one tar, and this script, run as root by the
# developer, who types the administrator password at sudo's prompt, installs
# them:
#
#   sudo /bin/bash -p /private/var/root/setup-restore.sh ENV /absolute/RESTORED.tar
#
# ENV           staging or production
# RESTORED.tar  made on the Mac from the directory holding the restored
#               data/ and repos/: tar -cf RESTORED.tar -C DIR data repos
#
# DRYRUN=1 prints what would change and needs no root.
#
# As in the other setup scripts, the developer's sudo is the decision to
# trust these bytes once: inputs must already be in root-owned storage with
# trusted parents. A private copy is checked and Git execution settings removed. The order is setup-tunnel.sh's: everything prepared
# and checked first; then every atelierd job stops and no atelierd process
# may run while root writes, its directories checked again once it is quiet.
# The undo is recorded before the next step: the current data/ENV and
# repos/ENV are moved aside to ENV.before-restore-STAMP, never deleted, and
# the command that undoes the restore is printed before they move. A failure
# from then on puts them back and starts again the jobs that ran.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/root LC_ALL=C
umask 077

AWK=/usr/bin/awk
BASENAME=/usr/bin/basename
CAT=/bin/cat
CHMOD=/bin/chmod
CHOWN=/usr/sbin/chown
CP=/bin/cp
DATE=/bin/date
DSCL=/usr/bin/dscl
FILE=/usr/bin/file
FIND=/usr/bin/find
GIT=/Library/Developer/CommandLineTools/usr/bin/git
GREP=/usr/bin/grep
ID_CMD=/usr/bin/id
LAUNCHCTL=/bin/launchctl
LS=/bin/ls
MKDIR=/bin/mkdir
MKTEMP=/usr/bin/mktemp
MV=/bin/mv
OTOOL=/Library/Developer/CommandLineTools/usr/bin/llvm-otool
PGREP=/usr/bin/pgrep
READLINK=/usr/bin/readlink
RM=/bin/rm
SED=/usr/bin/sed
SEQ=/usr/bin/seq
SHLOCK=/usr/bin/shlock
SLEEP=/bin/sleep
SQLITE=/usr/bin/sqlite3
STAT=/usr/bin/stat
TAR=/usr/bin/tar

check_system_tools() {
  for tool in "$AWK" "$BASENAME" "$CAT" "$CHMOD" "$CHOWN" "$CP" "$DATE" "$DSCL" "$FILE" "$FIND" "$GREP" "$ID_CMD" "$LAUNCHCTL" "$LS" "$MKDIR" "$MKTEMP" "$MV" "$PGREP" "$READLINK" "$RM" "$SED" "$SEQ" "$SHLOCK" "$SLEEP" "$SQLITE" "$STAT" "$TAR"; do
    [ -f "$tool" ] && [ -x "$tool" ] && [ "$("$STAT" -f %Su "$tool")" = root ] || { echo "unsafe system tool $tool" >&2; exit 1; }
  done
}
if [ "$EUID" = 0 ]; then check_system_tools; fi


fail() { echo "setup: $*" >&2; exit 1; }
dry() { [ "${DRYRUN:-}" = 1 ]; }
run() { if dry; then printf '+ %s\n' "$*"; else "$@"; fi; }

safe_dir() {
  local d=$1 owner
  [ -d "$d" ] && [ ! -L "$d" ] || fail "$d is not a plain directory"
  owner=$("$STAT" -f %Su "$d")
  [ "$owner" = root ] || [ "$owner" = "$SVC" ] || fail "$d is owned by $owner"
  [ $(( 0$("$STAT" -f %Lp "$d") & 022 )) = 0 ] || fail "$d is writable by a group or others"
  ! "$LS" -lde "$d" | "$SED" -n '2,$p' | "$GREP" -q . || fail "$d carries an ACL"
}
# Absent: neither a file nor a link, a dangling one included (-e misses it).
absent() { [ ! -e "$1" ] && [ ! -L "$1" ]; }
# The four paths this script moves or creates: data/ENV and repos/ENV
# absent or plain safe directories, never links; both destinations of the
# move aside absent. Run before the jobs stop and again once they have.
check_paths() {
  safe_dir "$HOME_DIR"; safe_dir "$HOME_DIR/data"; safe_dir "$HOME_DIR/repos"
  local p
  for p in "$D" "$R"; do
    [ ! -L "$p" ] || fail "$p is a link"
    absent "$p" || safe_dir "$p"
  done
  for p in "$D_OLD" "$R_OLD"; do absent "$p" || fail "$p exists already, or is a link"; done
}
# Each move aside, and each placement begun, is recorded the moment it
# happens, so recovery undoes exactly what was done.
moved_d= moved_r= placing_d= placing_r=
move_aside() {
  if ! absent "$D"; then run "$MV" "$D" "$D_OLD" || fail "could not move $D aside"; moved_d=1; fi
  if ! absent "$R"; then run "$MV" "$R" "$R_OLD" || fail "could not move $R aside"; moved_r=1; fi
}
# Undoes one path: the restored copy begun at CUR removed, then OLD moved
# back if it was moved aside. Each step is checked first: no link is
# followed, nothing unknown is removed, nothing is moved over anything.
undo_one() {
  local cur=$1 old=$2 moved=$3 placing=$4
  if [ -L "$cur" ]; then echo "setup: $cur is a link; left as it is" >&2; return 1; fi
  if [ -n "$placing" ] && [ -e "$cur" ]; then
    [ -d "$cur" ] || { echo "setup: $cur is not a directory; left as it is" >&2; return 1; }
    "$RM" -rf "$cur" || { echo "setup: could not remove the restored $cur" >&2; return 1; }
  fi
  [ -n "$moved" ] || return 0
  if [ -L "$old" ] || [ ! -d "$old" ]; then echo "setup: $old is not a plain directory; not moved back" >&2; return 1; fi
  if ! absent "$cur"; then echo "setup: $cur exists; $old was not moved back" >&2; return 1; fi
  "$MV" "$old" "$cur" || { echo "setup: could not move $old back to $cur" >&2; return 1; }
}
undone_d= undone_r=
undo_moves() {
  local rc=0
  if undo_one "$D" "$D_OLD" "$moved_d" "$placing_d"; then undone_d=1; else rc=1; fi
  if undo_one "$R" "$R_OLD" "$moved_r" "$placing_r"; then undone_r=1; else rc=1; fi
  return $rc
}

# Where each of the four paths stands: a directory, a link, something else,
# or absent.
path_state() {
  if [ -L "$1" ]; then echo "a link to $("$READLINK" "$1")"
  elif [ -d "$1" ]; then echo "a directory"
  elif [ -e "$1" ]; then echo "present, not a directory"
  else echo "absent"; fi
}
# What this run did to one path, what stands at its two places now (a
# link named as one), and hints for repairing it by hand.
manual_steps() {
  local name=$1 cur=$2 old=$3 moved=$4 placing=$5 undone=$6
  echo "  $name: this run $([ -n "$moved" ] && echo "moved the original to $old" || echo "moved nothing")$([ -n "$placing" ] && echo ", and began placing the restored copy at $cur")$([ -n "$undone" ] && echo "; the recovery put it back")."
  echo "    $cur: $(path_state "$cur")"
  echo "    $old: $(path_state "$old")"
  # Facts only, no commands: what to run depends on what stands at these
  # paths, and a printed command could nest, delete or serve the wrong one.
}

# Recovery after the jobs have stopped: the moves undone, and the jobs that
# ran started again only when every undo succeeded. If any undo step failed,
# for any reason, every job stays stopped and no start command is printed,
# since a server started on half-restored or mismatched directories would
# serve them, or make a missing data directory afresh; what stands at each
# of the four paths is printed, as facts, with no command to run.
recover() {
  if undo_moves; then start_loaded; return; fi
  {
    echo "setup: the restore could not be undone completely; every $SVC job is left stopped."
    echo "setup: what this run did, and what stands at each of the four paths:"
    manual_steps "data" "$D" "$D_OLD" "$moved_d" "$placing_d" "$undone_d"
    manual_steps "repos" "$R" "$R_OLD" "$moved_r" "$placing_r" "$undone_r"
    echo "setup: put the original data and repos back at their live paths, remove any partial restored copy and any link, then run setup-restore.sh again."
  } >&2
  return 1
}

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
  [ "$("$STAT" -f %Su "$path")" = root ] || { echo "setup: $path is not root-owned" >&2; return 1; }
  [ $(( 0$("$STAT" -f %Lp "$path") & 022 )) = 0 ] || { echo "setup: $path is group/world-writable" >&2; return 1; }
  listing=$("$LS" -lde "$path") || return 1
  [ -z "$(printf '%s\n' "$listing" | "$SED" -n '2,$p')" ] || { echo "setup: $path carries an ACL" >&2; return 1; }
}
# Never use Apple's xcode-select dispatch shims as root or atelierd.
check_tools() {
  local tool
  for tool in "$GIT" "$OTOOL"; do
    trusted_source "$tool" || fail "unsafe or missing tool $tool; repair ownership/permissions, or install Command Line Tools: /usr/bin/xcode-select --install (requires the Mac screen over SSH); PAVI can also download the Command Line Tools package"
    [ -x "$tool" ] || fail "$tool is not executable"
  done
}

check_node() {
  local binary=$1 description lib count=0 line
  description=$("$FILE" -b "$binary") || fail "cannot identify node"
  [[ "$description" = *Mach-O*executable* ]] || fail "node must be a Mach-O executable"
  "$OTOOL" -arch all -L "$binary" > "$WORK/node-libs" 2> "$WORK/node-errors" || fail "cannot read node libraries"
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

early_cleanup() {
  local status=${1:-$?}
  trap - EXIT INT TERM
  [ -z "$WORK" ] || "$RM" -rf "$WORK"
  [ -z "$LOCK" ] || "$RM" -f "$LOCK"
  exit "$status"
}

LOCK_DIR=/Library/Atelier/lock
acquire_lock() {
  local d lock_pid
  for d in "$LOCK_DIR" / /Library /Library/Atelier; do trusted_entry "$d" || fail "unsafe lock directory $d"; done
  [ -d "$LOCK_DIR" ] || fail "lock directory is not a directory: $LOCK_DIR"
  local candidate=$LOCK_DIR/install.lock
  [ ! -L "$candidate" ] || fail "$candidate is a link"
  if [ -e "$candidate" ]; then
    [ -f "$candidate" ] && [ "$("$STAT" -f %Su "$candidate")" = root ] || fail "unsafe lock $candidate"
  fi
  if ! "$SHLOCK" -p "$$" -f "$candidate"; then
    lock_pid=$("$CAT" "$candidate" 2>/dev/null) || lock_pid=
    if [[ "$lock_pid" =~ ^[1-9][0-9]*$ ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
      "$SLEEP" 1
      "$SHLOCK" -p "$$" -f "$candidate" || fail "another installer is running (lock: $candidate)"
    else fail "another installer is running (lock: $candidate)"
    fi
  fi
  LOCK=$candidate
}


extract_archive() {
  if ! dry && ! trusted_source "$TAR_SRC"; then
    echo 'setup: review and install the archive into root-owned storage first:' >&2
    echo 'sudo /usr/bin/install -o root -g wheel -m 600 restore.tar /private/var/root/' >&2
    return 1
  fi
  "$CP" -P "$TAR_SRC" "$WORK/restored.tar"
  if ! dry; then
    trusted_entry "$WORK" || fail "unsafe input storage"
    trusted_entry "$WORK/restored.tar" || fail "unsafe input copy"
  fi
  "$TAR" -tvf "$WORK/restored.tar" > "$WORK/list-long" || fail "the tar cannot be listed"
  "$TAR" -tf "$WORK/restored.tar" > "$WORK/list" || fail "the tar cannot be listed"
  [ -s "$WORK/list" ] || fail "the tar is empty"
  if "$AWK" '{t=substr($1,1,1); if (t!="-" && t!="d") bad=1} END {exit bad?0:1}' "$WORK/list-long"; then fail "the tar holds something other than files and directories"; fi
  if "$GREP" -E '(^/|(^|/)\.\.(/|$))' "$WORK/list" >/dev/null; then fail "the tar names a path outside itself"; fi
  if "$GREP" -vE '^(\./)?(data|repos)(/|$)' "$WORK/list" >/dev/null; then fail "the tar holds something besides data/ and repos/"; fi
  "$MKDIR" "$WORK/x"
  "$TAR" -xf "$WORK/restored.tar" --no-same-owner --no-same-permissions -C "$WORK/x"
  X="$WORK/x"
}
# Restored Git settings are data, never authority to run commands.
sanitize_repositories() {
  local repo
  [ -d "$X/repos" ] || fail "the tar has no repos/"
  for repo in "$X/repos"/* "$X/repos"/.[!.]* "$X/repos"/..?*; do
    [ -e "$repo" ] || continue
    case "${repo##*/}" in *.git) ;; *) fail "unexpected repository entry" ;; esac
    [ -d "$repo" ] && [ -f "$repo/HEAD" ] || fail "not a bare repository"
    "$RM" -rf "$repo/config" "$repo/config.worktree" "$repo/hooks" "$repo/info" \
      "$repo/objects/info/alternates" "$repo/objects/info/http-alternates"
    printf '[core]\n\tbare = true\n\thooksPath = /Users/atelierd/%s/hooks\n' "$SERVER" > "$repo/config"
  done
}

# A test sources the functions above alone (test/setup-restore.test.mjs).
if [ "${SETUP_RESTORE_LIB:-}" = 1 ]; then return 0; fi

usage="usage: setup-restore.sh staging|production RESTORED.tar"
ENV=${1:?$usage}
TAR_SRC=${2:?$usage}
case "$ENV" in staging) SERVER=server ;; production) SERVER=server-production ;; *) echo "setup: ENV is staging or production, not $ENV" >&2; exit 1 ;; esac

SVC=atelierd
HOME_DIR=/Users/$SVC
JOBS="zone.atelier.server.staging zone.atelier.server zone.atelier.tunnel zone.atelier.backup.staging zone.atelier.backup.production"
STAMP=$("$DATE" -u +%Y%m%dT%H%M%SZ)
D="$HOME_DIR/data/$ENV"
R="$HOME_DIR/repos/$ENV"
D_OLD="$D.before-restore-$STAMP"
R_OLD="$R.before-restore-$STAMP"

dry || [ "$("$ID_CMD" -u)" = 0 ] || fail "run as root (sudo), or DRYRUN=1"
if ! dry; then
  if ! trusted_source "$SOURCE"; then
    echo 'setup: review and copy the script into root-owned storage:' >&2
    echo 'sudo /usr/bin/install -o root -g wheel -m 700 scripts/studio/setup-restore.sh /private/var/root/' >&2
    exit 1
  fi
  check_tools
fi
[ -f "$TAR_SRC" ] && [ ! -L "$TAR_SRC" ] || fail "no restored tar at $TAR_SRC"
safe_dir /Library/LaunchDaemons
if ! dry; then
  "$DSCL" . -read /Users/$SVC >/dev/null 2>&1 || fail "$SVC does not exist; run setup-server.sh first"
fi

LOCK= WORK=
trap early_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ! dry; then
  trusted_entry / && trusted_entry /Library || fail "unsafe /Library"
  for d in /Library/Atelier "$LOCK_DIR"; do
    if [ ! -e "$d" ] && [ ! -L "$d" ]; then "$MKDIR" -m 755 "$d"; fi
    trusted_entry "$d" || fail "unsafe lock directory $d"
  done
  acquire_lock
  check_paths
fi
WORK=$("$MKTEMP" -d /var/tmp/atelier-restore-setup.XXXXXX)
if ! dry; then
  trusted_source /Users/atelierd/bin/node || fail "unsafe daemon node"
  [ -x /Users/atelierd/bin/node ] || fail "daemon node is not executable"
  check_node /Users/atelierd/bin/node
fi

# 1. The tar into root-owned storage, then checked there: plain files and
#    directories under data/ and repos/ only, nothing outside itself.
extract_archive
sanitize_repositories

[ -f "$X/data/ledgers/__index.sqlite" ] || fail "the restored data has no ledgers/__index.sqlite"
[ -d "$X/repos" ] || fail "the tar has no repos/"
# Every database passes SQLite's integrity check, and every project the
# index registers has its Ledger.
"$FIND" "$X/data" -name '*.sqlite' -type f > "$WORK/dbs"
while IFS= read -r db; do
  [ "$("$SQLITE" -readonly "$db" 'PRAGMA integrity_check' 2>/dev/null)" = ok ] || fail "${db#$X/} fails SQLite's integrity check"
done < "$WORK/dbs"
"$SQLITE" -readonly "$X/data/ledgers/__index.sqlite" "SELECT coalesce(json_extract(json, '\$.key'), name) FROM projects" > "$WORK/keys" 2>/dev/null || fail "the restored index cannot be read"
while IFS= read -r key; do
  # A Ledger's file name is "project:KEY" percent-encoded (fileName in
  # src/runtime/namespace.mjs); each candidate is decoded and compared.
  found=
  for f in "$X/data/ledgers/"project%3A*.sqlite; do
    n=$("$BASENAME" "$f" .sqlite)
    [ "$(printf '%b' "$(printf '%s' "$n" | "$SED" 's/%\(..\)/\\x\1/g')")" = "project:$key" ] && { found=1; break; }
  done
  [ -n "$found" ] || fail "the restored index registers $key, whose Ledger is missing"
done < "$WORK/keys"
for repo in "$X/repos"/*; do
  [ -e "$repo" ] || continue
  case "$("$BASENAME" "$repo")" in *.git) [ -f "$repo/HEAD" ] || fail "${repo#$X/} is not a bare repository" ;; *) fail "${repo#$X/} is not a KEY.git repository" ;; esac
done

# What ran, recorded before recovery is armed.
loaded=
if ! dry; then
  for job in $JOBS; do
    if "$LAUNCHCTL" print "system/$job" >/dev/null 2>&1; then
      [ -f "/Library/LaunchDaemons/$job.plist" ] && [ ! -L "/Library/LaunchDaemons/$job.plist" ] || fail "$job is loaded but its plist is missing or a link"
      loaded="$loaded $job"
    fi
  done
fi

stop_all() {
  local job
  for job in $JOBS; do
    "$LAUNCHCTL" print "system/$job" >/dev/null 2>&1 || continue
    "$LAUNCHCTL" bootout "system/$job" 2>/dev/null
    for _ in $("$SEQ" 1 20); do "$LAUNCHCTL" print "system/$job" >/dev/null 2>&1 || break; "$SLEEP" 0.5; done
    if "$LAUNCHCTL" print "system/$job" >/dev/null 2>&1; then echo "setup: $job would not stop" >&2; return 1; fi
  done
  for _ in $("$SEQ" 1 60); do "$PGREP" -u "$SVC" >/dev/null || break; "$SLEEP" 0.5; done
  if "$PGREP" -u "$SVC" >/dev/null; then echo "setup: a process of $SVC is still running" >&2; return 1; fi
}
start_loaded() {
  local job rc=0
  for job in $JOBS; do
    case " $loaded " in *" $job "*) "$LAUNCHCTL" bootstrap system "/Library/LaunchDaemons/$job.plist" || { echo "setup: $job did not start; sudo /bin/launchctl bootstrap system /Library/LaunchDaemons/$job.plist" >&2; rc=1; } ;; esac
  done
  return $rc
}
stopped=
restore() {
  [ -n "$stopped" ] || return 0
  set +e
  echo "setup: putting the previous $ENV data and repositories back" >&2
  if ! stop_all; then echo "setup: nothing was put back" >&2; return 1; fi
  if ! ( safe_dir "$HOME_DIR" && safe_dir "$HOME_DIR/data" && safe_dir "$HOME_DIR/repos" ) 2>/dev/null; then echo "setup: a directory of $SVC is not safe to write; nothing was put back" >&2; return 1; fi
  recover
}
trap 'status=$?; [ $status = 0 ] || restore; early_cleanup "$status"' EXIT

# 2. Everything of atelierd's stops; its directories are checked again.
if ! dry; then
  stopped=1
  stop_all || fail "the $SVC jobs could not all be stopped"
  check_paths
fi

# 3. The undo, recorded before the next step, then the move aside.
echo "to undo this restore: stop the $SVC jobs, then move $D_OLD back to $D and $R_OLD back to $R"
move_aside

# 4. The restored directories in place, atelierd's, directories 700 and
#    files 600.
placing_d=1
run "$CP" -R "$X/data" "$D"
placing_r=1
run "$CP" -R "$X/repos" "$R"
run "$CHOWN" -R "$SVC:$SVC" "$D" "$R"
run "$CHMOD" -R u=rwX,go= "$D" "$R"
if ! dry; then
  "$FIND" "$D" "$R" -type f -exec "$CHMOD" 600 {} +
  safe_dir "$D"; safe_dir "$R"
fi

# 5. The jobs that ran start again.
if dry; then echo "+ (start again the atelierd jobs that were loaded)"; else start_loaded || fail "a job that was running did not start again"; fi
stopped=
echo "the restored $ENV data and repositories are in place; the previous ones are kept as $D_OLD and $R_OLD"
