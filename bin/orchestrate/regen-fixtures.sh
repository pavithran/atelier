#!/bin/zsh
# regen-fixtures.sh: run from an Atelier checkout or workspace root; rewrites
# test/fixtures/cli/help.txt and usage.json from the CLI there, with an empty
# config so no machine's projects appear in them.
set -eu
D=$(mktemp -d "${TMPDIR:-/tmp}/atelier-cfg.XXXXXX")
trap 'rm -rf "$D"' EXIT
ATELIER_CONFIG_DIR=$D node cli/atelier.mjs help > test/fixtures/cli/help.txt
node --input-type=module -e '
import { COMMAND_USAGE } from "./src/usage.ts";
import { spawnSync } from "node:child_process";
const out = {};
for (const c of Object.keys(COMMAND_USAGE).sort()) out[c] = spawnSync(process.execPath, ["cli/atelier.mjs", c, "--help"], { encoding: "utf8", env: { ...process.env, ATELIER_CONFIG_DIR: process.argv[1] } }).stdout;
process.stdout.write(JSON.stringify(out, null, 2) + "\n");' "$D" > test/fixtures/cli/usage.json
