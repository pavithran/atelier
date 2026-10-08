import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// t215: bin/orchestrate/land.sh, run against stand-ins for `atelier` and for
// review.sh. It records the reviewer's own summary as the review's note and
// the session's NOTE on the acceptance, names the reviewer from the model
// that ran (refusing any other before anything runs), and passes the head it
// read before the review to both the review and the acceptance.

const repo = fileURLToPath(new URL("..", import.meta.url));
const zsh = ["/bin/zsh", "/usr/bin/zsh"].find((p) => existsSync(p));

// What atelier show --json gives for the task: its criteria and their binding.
const SHOWN = { criteria: "c".repeat(64), accept: ["A nested list parses", "Nothing else changes"], partAccept: null };

function landing(t, { model, answer = "VERDICT: APPROVE\nSUMMARY: The reviewer's own summary.\n", check = "PASS npm test" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-land-sh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // land.sh beside its siblings, with a review.sh that writes the answer and
  // moves the workspace's head, as a push during the review would.
  const bin = join(dir, "root", "bin", "orchestrate");
  mkdirSync(bin, { recursive: true });
  for (const f of ["land.sh", "lib.sh", "verdict.mjs"]) copyFileSync(join(repo, "bin", "orchestrate", f), join(bin, f));
  symlinkSync(join(repo, "src"), join(dir, "root", "src"));
  writeFileSync(join(dir, "answer.md"), answer);
  writeFileSync(join(dir, "context.txt"), "The session's context.\n");
  // It keeps the context it was given, so a test can read what the reviewer was told.
  writeFileSync(join(bin, "review.sh"), `#!/bin/zsh\nmkdir -p "\${2:h}"\ncp ${JSON.stringify(join(dir, "answer.md"))} "$2.md"\ncp "$3" ${JSON.stringify(join(dir, "given-context.txt"))}\ngit -C "$1" commit -q --allow-empty -m later\n`);
  chmodSync(join(bin, "review.sh"), 0o755);
  // An atelier that records each call and passes every check.
  const tools = join(dir, "tools"), log = join(dir, "calls.jsonl");
  mkdirSync(tools);
  writeFileSync(join(tools, "atelier"), `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nconsole.log(process.argv[2] === "check" ? ${JSON.stringify(check)} : process.argv[2] === "show" ? ${JSON.stringify(JSON.stringify(SHOWN))} : "ok");\n`);
  chmodSync(join(tools, "atelier"), 0o755);
  const cache = join(dir, "cache"), config = join(dir, "config"), checkout = join(dir, "checkout");
  const ws = join(cache, "work", "demo", "t9");
  mkdirSync(ws, { recursive: true }); mkdirSync(config); mkdirSync(checkout);
  writeFileSync(join(config, "config.json"), JSON.stringify({ projects: { demo: { path: checkout } } }));
  const git = (...a) => spawnSync("git", ["-C", ws, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" });
  git("init", "-q"); git("commit", "-q", "--allow-empty", "-m", "work");
  const head = git("rev-parse", "HEAD").stdout.trim();
  const result = spawnSync(zsh, [join(bin, "land.sh"), "t9", join(dir, "context.txt"), "Session note on the acceptance"], {
    encoding: "utf8",
    env: {
      ...process.env, PATH: `${tools}:${process.env.PATH}`, ATELIER_PROJECT: "demo", ATELIER_CACHE: cache, ATELIER_CONFIG_DIR: config,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
      ...(model ? { REVIEW_MODEL: model } : { REVIEW_MODEL: "" }),
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const given = existsSync(join(dir, "given-context.txt")) ? readFileSync(join(dir, "given-context.txt"), "utf8") : null;
  return { result, calls, head, given };
}

const flag = (call, name) => call[call.indexOf(name) + 1];

test("the review carries the reviewer's summary and the reviewed head; the acceptance carries the note and the same head", { skip: !zsh && "zsh is not installed" }, (t) => {
  const { result, calls, head, given } = landing(t, { model: "gemini-3.1-pro-high" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const review = calls.find((c) => c[0] === "review"), accept = calls.find((c) => c[0] === "accept");
  assert.ok(review && accept, JSON.stringify(calls));
  assert.equal(flag(review, "--as"), "antigravity/gemini-3.1-pro");
  assert.equal(flag(review, "--head"), head, "the review names the head read before review.sh ran, not the one after");
  assert.equal(flag(review, "--note"), "The reviewer's own summary.");
  // t326: the review is bound to the criteria read with the head, and the
  // reviewer is given those criteria with the session's context.
  assert.equal(flag(review, "--criteria"), SHOWN.criteria);
  assert.match(given, /The session's context\./);
  assert.match(given, /1\. A nested list parses\n2\. Nothing else changes/);
  assert.ok(review.includes("--approve"));
  assert.equal(flag(accept, "--head"), head);
  assert.equal(flag(accept, "--note"), "Session note on the acceptance");
});

test("gpt-oss-120b-medium is recorded as antigravity/gpt-oss-120b", { skip: !zsh && "zsh is not installed" }, (t) => {
  const { result, calls } = landing(t, { model: "gpt-oss-120b-medium" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(flag(calls.find((c) => c[0] === "review"), "--as"), "antigravity/gpt-oss-120b");
});

test("any other model is refused before anything runs", { skip: !zsh && "zsh is not installed" }, (t) => {
  const { result, calls } = landing(t, { model: "gemini-3-flash" });
  assert.equal(result.status, 7);
  assert.match(result.stdout, /REVIEW_MODEL gemini-3-flash is not one land.sh can name/);
  assert.deepEqual(calls, []);
});

test("a failed check shows the last 25 lines of its output", { skip: !zsh && "zsh is not installed" }, (t) => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const { result, calls } = landing(t, { model: "gemini-3.1-pro-high", check: ["FAIL  npm test", ...lines].join("\n") });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /t9: CHECK FAILED\n/);
  const shown = result.stdout.slice(result.stdout.indexOf("CHECK FAILED\n") + 13).trim().split("\n");
  assert.deepEqual(shown, lines.slice(-25));
  assert.ok(!calls.some((c) => c[0] === "submit"));
});
