#!/bin/zsh
# worktree.sh TASK: makes the Git worktree a builder works in, branch TASK
# from main, at $ATELIER_WORKTREES/TASK, and sets the project's commit
# identity in that worktree's own Git config. A worktree shares its
# repository's config, so one made with a bare `git worktree add` commits
# as whoever the checkout does; on 2026-10-16 that was a private address, 61
# builder commits carried it, and the privacy scan refused them at the very
# end of the push (t731). The identity is read first, from the project's
# policy (atelier identity), and a project with none, a server that cannot be
# reached, or a value that does not read back as written stops the script
# before it creates or changes anything. Run it again on an existing worktree
# to set the identity again. The registered checkout's own config is not
# changed, and nothing is pushed.
set -eu
source "${0:A:h}/lib.sh"
t=$1
root=${ATELIER_WORKTREES:-$HOME/Library/Caches/ai-projects/atelier-worktrees}
M=$(checkout_of "$ATELIER_PROJECT")
atelier=${ATELIER_BIN:-atelier}
json=$("$atelier" identity --json --project "$ATELIER_PROJECT") || { echo "worktree.sh: could not read $ATELIER_PROJECT's commit identity; no worktree was made or changed" >&2; exit 1; }
name=$(print -r -- "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
email=$(print -r -- "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["email"])')
[[ -n $name && -n $email ]] || { echo "worktree.sh: $ATELIER_PROJECT's commit identity is empty; no worktree was made or changed" >&2; exit 1; }
wt=$root/$t
if [[ ! -e $wt ]]; then
  mkdir -p "$root"
  git -C "$M" worktree add -b "$t" "$wt" main
fi
git -C "$M" config extensions.worktreeConfig true
git -C "$wt" config --worktree user.name "$name"
git -C "$wt" config --worktree user.email "$email"
[[ $(git -C "$wt" config user.name) == "$name" && $(git -C "$wt" config user.email) == "$email" ]] \
  || { echo "worktree.sh: $wt does not commit as $name <$email> after the change; do not build there" >&2; exit 1; }
echo "$wt commits as $name <$email>"
