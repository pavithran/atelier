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
grep -qx ".scratch/" "$ws/.git/info/exclude" 2>/dev/null || echo ".scratch/" >> "$ws/.git/info/exclude"
if [[ -f $prompt ]]; then
  brief=${prompt:A}
else
  brief="$ws/.scratch/run-agent-brief.md"
  print -r -- "$prompt" > "$brief"
fi
cd "$ws"
export XDG_DATA_HOME="$ws/.scratch/xdg-data"
case $which in
  glm) exec "$HOME/.local/bin/opencode-glm" run --model zai-coding/glm-5.3 < "$brief" > "$out" 2>&1 ;;
  deepseek) exec "$HOME/.local/bin/opencode-deepseek" run --model deepseek-api/deepseek-v4-pro < "$brief" > "$out" 2>&1 ;;
  openrouter:*) exec "$HOME/.local/bin/opencode-openrouter" run --model "openrouter-api/${which#openrouter:}" < "$brief" > "$out" 2>&1 ;;
  *) echo "run-agent.sh: unknown agent $which (glm, deepseek or openrouter:VENDOR/MODEL)" >&2; exit 64 ;;
esac
