import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { COMMAND_USAGE, HELP_FOOTER, HELP_FORMS, HELP_GROUPS, guideText, helpText } from "../cli/help.mjs";

// The CLI extends the shared web reference through cli/help.mjs. Fixtures
// pin the combined text, so these tests catch changes to what a user sees.

const cli = resolve("cli/atelier.mjs");
const fixture = (name) => readFileSync(resolve("test/fixtures/cli", name), "utf8");

function run(args) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-text-"));
  try {
    return spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ATELIER_CONFIG_DIR: dir } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("atelier help prints exactly the pinned text, however it is asked for", () => {
  const pinned = fixture("help.txt");
  for (const args of [["help"], [], ["--help"], ["help", "--help"], ["-h"]]) {
    const r = run(args);
    assert.equal(r.status, 0, args.join(" "));
    assert.equal(r.stdout, pinned, `atelier ${args.join(" ")}`);
    assert.equal(r.stderr, "");
  }
});

test("atelier guide prints exactly the pinned text", () => {
  const r = run(["guide"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, fixture("guide.txt"));
});

test("each command's usage line prints exactly as pinned", () => {
  const pinned = JSON.parse(fixture("usage.json"));
  assert.deepEqual(Object.keys(COMMAND_USAGE).sort(), Object.keys(pinned).sort());
  for (const [command, line] of Object.entries(pinned)) {
    for (const flag of ["--help", "-h"]) {
      const r = run([command, flag]);
      assert.equal(r.status, 0, `${command} ${flag}`);
      assert.equal(r.stdout, line, `atelier ${command} ${flag}`);
    }
  }
});

test("the help module renders the pinned CLI text", () => {
  assert.equal(helpText() + "\n", fixture("help.txt"));
  assert.equal(guideText(), fixture("guide.txt"));
});

// The page lists what the help lists. These two checks keep the help itself
// complete: a command added to the CLI without a help entry, or a help entry
// for a command that does not exist, fails here.
// The commands the CLI defines: one handler module each in cli/commands/.
function cliCommands() {
  return readdirSync(resolve("cli/commands")).filter((f) => f.endsWith(".mjs") && f !== "index.mjs").map((f) => f.slice(0, -".mjs".length));
}

test("every command the CLI defines is in the help, and every help entry is a command", () => {
  const defined = cliCommands();
  assert.ok(defined.length > 30, `found only ${defined.length} commands`);
  const listed = new Set(HELP_FORMS.map((form) => form.split(" ")[0]));
  for (const name of defined) if (name !== "help") assert.ok(listed.has(name), `atelier ${name} is not in the CLI help`);
  for (const name of listed) assert.ok(defined.includes(name), `the help lists ${name}, which the CLI does not define`);
});

test("every form has a description for the web reference, written without dash punctuation", () => {
  assert.ok(HELP_FOOTER.startsWith("Common flags"));
  for (const group of HELP_GROUPS) {
    for (const command of group.lines.flat()) {
      assert.ok(command.about.length > 20, `${command.form} needs a description`);
      assert.doesNotMatch(command.about, /\s[–—-]\s|[–—]/, `${command.form}: use a colon, semicolon or full stop`);
      assert.match(command.about, /[.]$/, `${command.form}: end the description with a full stop`);
    }
  }
});
