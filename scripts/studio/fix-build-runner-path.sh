#!/bin/sh
# fix-build-runner-path.sh DIR...: put /usr/sbin and /sbin on the PATH of the
# Studio build runners. Run it as atelier-build on the Studio, once per runner
# config folder (~/.config/atelier/studio-*), then restart the runners.
# Without /usr/sbin, builders cannot find lsof, and Miqra's browser gate stops
# at its server-ownership check (docs/studio-miqra-visual-journeys.md).
# Each start-build*.zsh is rewritten in place only when its PATH line is the
# known one; any other line is left alone and reported.
set -eu
[ "$#" -ge 1 ] || { echo "usage: fix-build-runner-path.sh DIR..." >&2; exit 64; }
old='export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"'
new='export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"'
found=0 failed=0
for dir in "$@"; do
  for file in "$dir"/start-build*.zsh; do
    [ -f "$file" ] || continue
    found=1
    if grep -qxF "$new" "$file"; then continue; fi
    if ! grep -qxF "$old" "$file"; then
      echo "fix-build-runner-path: $file has no known PATH line; left unchanged" >&2
      failed=1
      continue
    fi
    # The copy takes the mode of the original, and replaces it only once complete.
    cp -p "$file" "$file.new"
    while IFS= read -r line || [ -n "$line" ]; do
      if [ "$line" = "$old" ]; then printf '%s\n' "$new"; else printf '%s\n' "$line"; fi
    done < "$file" > "$file.new"
    mv -f "$file.new" "$file"
    echo "fix-build-runner-path: $file updated"
  done
done
[ "$found" = 1 ] || { echo "fix-build-runner-path: no start-build*.zsh in $*" >&2; exit 1; }
exit "$failed"
