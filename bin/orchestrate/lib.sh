# Shared by the orchestration scripts: where a project's registered checkout
# and a task's workspace are on this machine, read from the Atelier CLI's own
# config and cache, so nothing here names one machine's paths.
ATELIER_CONFIG_DIR=${ATELIER_CONFIG_DIR:-$HOME/.config/atelier}
ATELIER_CACHE=${ATELIER_CACHE:-$HOME/Library/Caches/ai-projects/cloudflare-git}
ATELIER_PROJECT=${ATELIER_PROJECT:-atelier}

# checkout_of NAME: the registered checkout's path, from config.json.
checkout_of() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["projects"][sys.argv[2]]["path"])' \
    "$ATELIER_CONFIG_DIR/config.json" "$1" 2>/dev/null || { echo "no registered checkout for $1 in $ATELIER_CONFIG_DIR/config.json" >&2; return 1; }
}

# workspace_of NAME ID: the task's workspace, where atelier claim made it.
workspace_of() { echo "$ATELIER_CACHE/work/$1/$2"; }

# project_of WORKSPACE: the project a workspace belongs to, from its Git config.
project_of() { git -C "$1" config --local atelier.project; }
