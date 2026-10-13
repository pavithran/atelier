#!/bin/zsh
# regen-fixtures.sh: run from an Atelier checkout or workspace root; rewrites
# the command indexes and test/fixtures/cli/ (help.txt, usage.json,
# guide.txt) with node cli/regenerate.mjs, the generator
# bin/merge-manifest.json declares for them.
set -eu
exec node cli/regenerate.mjs
