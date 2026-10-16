#!/bin/zsh
# run-agent.sh glm|deepseek|openrouter:VENDOR/MODEL WORKSPACE OUTFILE BRIEF
# Runs an opencode agent in WORKSPACE with its own data folder, since
# concurrent runs sharing ~/.local/share/opencode/opencode.db deadlock.
# BRIEF is a file holding the prompt; text that names no file is taken as the
# prompt itself and written to the workspace's .scratch/ first. The prompt
# reaches opencode on standard input (opencode run reads it when it is not a
# terminal), never as a command-line argument, which the operating system
# caps near 1 MB, and standard input is never left open, since opencode
# otherwise waits on it. The opencode-* wrappers it calls are set up as
# README.md here describes; each reads its key into its own process only.
set -eu
which=$1 ws=${2:A} out=${3:A} prompt=$4
mkdir -p "$ws/.scratch/xdg-data"
# In a linked worktree .git is a file, so ask git where the exclude file is.
# It may answer relative to the workspace, and its folder may not exist yet.
excl=$(git -C "$ws" rev-parse --git-path info/exclude)
[[ $excl == /* ]] || excl="$ws/$excl"
mkdir -p "${excl:h}"
grep -qx ".scratch/" "$excl" 2>/dev/null || echo ".scratch/" >> "$excl"
if [[ -f $prompt ]]; then
  brief=${prompt:A}
else
  brief="$ws/.scratch/run-agent-brief.md"
  print -r -- "$prompt" > "$brief"
fi
# The opencode configs' cf-aig-metadata header reads {env:CF_AIG_METADATA};
# the home runner sets it per run, and a hand dispatch reads the task from
# the brief. Only plain characters survive, so the JSON stays one line.
task=$(grep -m1 '^Task: ' "$brief" | sed 's/^Task: //' | tr -cd 'A-Za-z0-9.-' || true)
if [[ -n $task ]]; then
  export CF_AIG_METADATA="{\"task\":\"$task\",\"role\":\"build\",\"runner\":\"hand\"}"
else
  export CF_AIG_METADATA='{"role":"build","runner":"hand"}'
fi
cd "$ws"
export XDG_DATA_HOME="$ws/.scratch/xdg-data"
dir=${OPENCODE_WRAPPER_DIR:-$HOME/.local/bin}
case $which in
  glm) wrapper=$dir/opencode-glm model=zai-coding/glm-5.3 ;;
  deepseek) wrapper=$dir/opencode-deepseek model=deepseek-api/deepseek-v4-pro ;;
  openrouter:*) wrapper=$dir/opencode-openrouter model="openrouter-api/${which#openrouter:}" ;;
  *) echo "run-agent.sh: unknown agent $which (glm, deepseek or openrouter:VENDOR/MODEL)" >&2; exit 64 ;;
esac
# opencode 2's run connects to a background service that all runs share, with
# a data folder of its own, unless it is given --standalone; opencode 1 may
# reject the flag, so the major version decides (t683). opencode 2 also asks
# before it reads outside the workspace, and `run` approves what it is asked,
# so a deny rule for external_directory goes in through
# OPENCODE_CONFIG_CONTENT, which opencode merges over the wrapper's config.
# A version that cannot be read is refused: it might be opencode 2, and
# opencode 1 rejects both the flag and the rule.
major=
if version=$("$wrapper" --version 2>/dev/null); then
  major=$(print -r -- "$version" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 | cut -d. -f1 || true)
fi
if [[ -z $major ]]; then
  echo "run-agent.sh: could not read the version of $wrapper (--version failed or printed no version), so it is not known whether it needs --standalone and the external_directory deny; no run was started" >&2
  exit 69
fi
flags=()
if [[ $major -ge 2 ]]; then
  flags=(--standalone)
  export OPENCODE_CONFIG_CONTENT='{"permissions":[{"action":"external_directory","resource":"*","effect":"deny"}]}'
fi
exec "$wrapper" run "${flags[@]}" --model "$model" < "$brief" > "$out" 2>&1
