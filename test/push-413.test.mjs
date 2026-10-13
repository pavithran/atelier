import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushCommitsInTurn, refused413 } from "../cli/push-steps.mjs";

// t577: a runner's push of a large pack answered 413 and stranded the build.
// t544 on home:studio-3 (2026-10-13) pushed through the runner route and got
// "error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413";
// the claim was preserved and nothing was submitted for seven hours. Pushing
// the unpushed first-parent commits one at a time got all but one through,
// and that one (~96 regenerated PNGs) went to the fork's own URL.
//
// A local bare repository stands in for the runner route: its pre-receive
// hook refuses, with the 413 text, a push that brings more objects than
// $LIMIT. The same repository reached as "fork-url" stands in for the fork's
// own URL, which has no such limit. Every decision lands in the file `log`.

const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
const HOOK = `#!/bin/sh
while read old new ref; do
  n=$(git rev-list --objects "$new" --not --all | wc -l | tr -d ' ')
  if [ "$n" -gt "\${LIMIT:-1000000}" ]; then echo "$n refused" >> log; echo "error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413" >&2; exit 1; fi
  echo "$n accepted" >> log
done
`;

function scenario(t, limit) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-413-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const work = join(dir, "work"), bare = join(dir, "fork.git");
  const raw = (args, opts = {}) => spawnSync("git", args, { encoding: "utf8", cwd: opts.cwd, input: opts.input, env: { ...ENV, ...opts.env } });
  const sh = (args, cwd = work) => { const r = raw(args, { cwd }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  raw(["init", "-q", "--bare", "-b", "main", bare]);
  writeFileSync(join(bare, "hooks", "pre-receive"), HOOK); chmodSync(join(bare, "hooks", "pre-receive"), 0o755);
  raw(["init", "-q", "-b", "main", work]);
  sh(["config", "user.name", "Test"]); sh(["config", "user.email", "test@example.invalid"]);
  sh(["remote", "add", "origin", bare]);
  // The CLI's git helper as push-steps calls it: allowFail answers the
  // spawnSync result. "fork-url" is the same repository without the limit.
  const git = (args, opts = {}) => {
    const fork = args.includes("fork-url");
    return raw(args.map((a) => (a === "fork-url" ? bare : a)), { cwd: opts.cwd, input: opts.input, env: { LIMIT: fork ? "" : String(limit), ...opts.env } });
  };
  const commit = (message, files) => {
    for (let i = 0; i < files; i++) writeFileSync(join(work, `${message.replace(/\W/g, "-")}-${i}.txt`), `${message} ${i}\n`);
    sh(["add", "-A"]); sh(["commit", "-q", "-m", message]);
    return sh(["rev-parse", "HEAD"]);
  };
  const log = () => readFileSync(join(bare, "log"), "utf8").trim().split("\n");
  const remoteTip = () => sh(["rev-parse", "main"], bare);
  return { work, git, commit, log, remoteTip, sh };
}

test("the 413 text the runner route answered is recognised, and nothing else", () => {
  assert.ok(refused413("error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413\nsend-pack: unexpected disconnect while reading sideband packet"));
  assert.ok(!refused413("error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403"));
  assert.ok(!refused413("! [rejected] main -> main (non-fast-forward)"));
});

test("a push that answered 413 goes through one first-parent commit at a time, oldest first", (t) => {
  const s = scenario(t, 8);
  s.commit("base", 1);
  assert.equal(s.git(["push", "-q", "origin", "HEAD:main"], { cwd: s.work }).status, 0);
  const a = s.commit("a", 3), b = s.commit("b", 3), c = s.commit("c", 3);
  const whole = s.git(["push", "-q", "--recurse-submodules=no", "origin", "HEAD:main"], { cwd: s.work });
  assert.notEqual(whole.status, 0);
  assert.ok(refused413(whole.stderr), whole.stderr);
  const said = [];
  const pushed = pushCommitsInTurn(s.git, s.work, { remote: "origin", branch: "main", say: (l) => said.push(l), refusal: whole.stderr });
  assert.deepEqual(pushed, [a, b, c]);
  assert.equal(s.remoteTip(), c);
  // base, the whole push refused, then three steps of one commit's objects each.
  assert.deepEqual(s.log().map((l) => l.split(" ")[1]), ["accepted", "refused", "accepted", "accepted", "accepted"]);
  assert.match(said.join("\n"), /Pushing the 3 unpushed first-parent commits one at a time, oldest first/);
});

test("a single commit still too large names itself and its size, and says how the owner can push it", (t) => {
  const s = scenario(t, 8);
  s.commit("base", 1);
  s.git(["push", "-q", "origin", "HEAD:main"], { cwd: s.work });
  const small = s.commit("small", 2), big = s.commit("regenerate screenshots", 20);
  s.commit("after", 1);
  const hint = "The owner can push it from a workspace on the fork itself: atelier claim t9 --as claude-code/x --runner home:studio-3, then atelier push.";
  assert.throws(() => pushCommitsInTurn(s.git, s.work, { remote: "origin", branch: "main", ownerHint: hint }), (error) => {
    assert.match(error.message, new RegExp(`commit ${big.slice(0, 8)} \\("regenerate screenshots"\\) is too large to push on its own: 22 objects, about \\d+ (KB|MB) as git stores them`));
    assert.match(error.message, new RegExp(`1 of 3 unpushed commits went through; the remote holds main at ${small.slice(0, 8)}`));
    assert.ok(error.message.includes(hint));
    assert.match(error.message, /HTTP 413/);
    return true;
  });
  assert.equal(s.remoteTip(), small);
});

test("on the runner route, a single commit too large goes once to the fork's own URL and the rest follow", (t) => {
  const s = scenario(t, 8);
  s.commit("base", 1);
  s.git(["push", "-q", "origin", "HEAD:main"], { cwd: s.work });
  s.commit("small", 2); s.commit("regenerate screenshots", 20); const last = s.commit("after", 1);
  const said = [];
  const pushed = pushCommitsInTurn(s.git, s.work, { remote: "origin", branch: "main", fallback: "fork-url", say: (l) => said.push(l) });
  assert.equal(pushed.length, 3);
  assert.equal(s.remoteTip(), last);
  assert.match(said.join("\n"), /answered 413 on its own \(22 objects.*pushing it once to the fork's own URL/);
});
