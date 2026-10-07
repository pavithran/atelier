import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// t244: bin/orchestrate/run-agent.sh and review.sh give their agent the
// prompt on standard input, never as a command-line argument, which the
// operating system caps near 1 MB. Each runs against a stand-in for the
// agent's CLI that records its arguments and what it read on standard input.

const repo = fileURLToPath(new URL("..", import.meta.url));
const zsh = ["/bin/zsh", "/usr/bin/zsh"].find((p) => existsSync(p));
const skip = !zsh && "zsh is not installed";

// A stand-in that writes its argv and its standard input to `record`, and
// prints `output`.
function standIn(path, record, output = "") {
  writeFileSync(path, `#!${process.execPath}
const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), input }));
process.stdout.write(${JSON.stringify(output)});
`);
  chmodSync(path, 0o755);
}

function gitRepo(dir) {
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd: dir, encoding: "utf8" }).trim();
  mkdirSync(dir, { recursive: true });
  git("init", "--quiet", "-b", "main");
  return git;
}

test("run-agent.sh passes the brief file to opencode on standard input, not as an argument", { skip }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-run-agent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home"), ws = join(dir, "ws"), record = join(dir, "record.json");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  standIn(join(home, ".local", "bin", "opencode-glm"), record);
  gitRepo(ws);
  // A brief over the 1 MB that an argument could carry.
  const text = `Build the thing.\n${"x".repeat(1_100_000)}\n`;
  writeFileSync(join(dir, "brief.md"), text);
  const run = (prompt) => spawnSync(zsh, [join(repo, "bin", "orchestrate", "run-agent.sh"), "glm", ws, join(dir, "out.txt"), prompt], { encoding: "utf8", env: { ...process.env, HOME: home } });
  const result = run(join(dir, "brief.md"));
  assert.equal(result.status, 0, result.stderr);
  const seen = JSON.parse(readFileSync(record, "utf8"));
  assert.deepEqual(seen.argv, ["run", "--model", "zai-coding/glm-5.3"]);
  assert.equal(seen.input, text);

  // Text that names no file is still taken as the prompt, kept in .scratch/.
  rmSync(record);
  assert.equal(run("A short prompt.").status, 0);
  const short = JSON.parse(readFileSync(record, "utf8"));
  assert.deepEqual(short.argv, ["run", "--model", "zai-coding/glm-5.3"]);
  assert.equal(short.input, "A short prompt.\n");
  assert.ok(existsSync(join(ws, ".scratch", "run-agent-brief.md")));
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: ws, encoding: "utf8" }), "", ".scratch/ is kept out of Git");
});

test("review.sh passes its prompt to agy on standard input, not as an argument", { skip }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-review-sh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tools = join(dir, "tools"), record = join(dir, "record.json"), main = join(dir, "main"), ws = join(dir, "ws");
  mkdirSync(tools);
  standIn(join(tools, "agy"), record, JSON.stringify({ response: "VERDICT: APPROVE\nSUMMARY: Read it.\n" }));
  const gitMain = gitRepo(main);
  writeFileSync(join(main, "a.txt"), "a\n");
  gitMain("add", "."); gitMain("commit", "--quiet", "-m", "base");
  execFileSync("git", ["clone", "--quiet", main, ws]);
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd: ws, encoding: "utf8" }).trim();
  git("config", "--local", "atelier.project", "demo");
  git("config", "--local", "atelier.item", "t9");
  writeFileSync(join(ws, "b.txt"), `${"y".repeat(200)}\n`);
  git("add", "."); git("commit", "--quiet", "-m", "the change");
  writeFileSync(join(dir, "context.txt"), "The task: add b.txt.\n");
  const out = join(ws, ".scratch", "review");
  const result = spawnSync(zsh, [join(repo, "bin", "orchestrate", "review.sh"), ws, out, join(dir, "context.txt")], {
    encoding: "utf8", env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, MAIN_REPO: main, TMPDIR: dir },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const seen = JSON.parse(readFileSync(record, "utf8"));
  assert.ok(!seen.argv.includes("-p"), JSON.stringify(seen.argv));
  assert.ok(seen.argv.every((arg) => arg.length < 100), "no argument carries the prompt");
  assert.equal(seen.input, readFileSync(`${out}.prompt.md`, "utf8"));
  assert.ok(seen.input.includes("+++ b/b.txt"), "the prompt carries the diff");
  assert.equal(readFileSync(`${out}.md`, "utf8"), "VERDICT: APPROVE\nSUMMARY: Read it.\n");
});
