// A small Git history made the same way every time (fixed names, dates and
// contents, so the same commit ids), standing in for a 1.x project's
// Artifacts baseline and one task's fork. The 1.0 Ledger dump in
// test/fixtures/ledger-v1.0-relic.json names these commits: main's two, and
// the fork's one beyond them, which t2's recorded head is.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ENV = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Relic Builder", GIT_AUTHOR_EMAIL: "builder@relic.test", GIT_COMMITTER_NAME: "Relic Builder", GIT_COMMITTER_EMAIL: "builder@relic.test",
};

// Makes the history in `dir` (a new working repository): main at two
// commits, and branch `fork` one commit past main. Answers the ids.
export function makeV1History(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (args, date) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: dir, encoding: "utf8", env: { ...process.env, ...ENV, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  }).trim();
  git(["init", "-q", "--object-format=sha1", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "# relic\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "first"], "2026-10-01T10:00:00Z");
  const first = git(["rev-parse", "HEAD"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(["add", "a.txt"]);
  git(["commit", "-q", "-m", "second"], "2026-10-02T10:00:00Z");
  const main = git(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "-b", "fork"]);
  writeFileSync(join(dir, "b.txt"), "two\n");
  git(["add", "b.txt"]);
  git(["commit", "-q", "-m", "t2: add b"], "2026-10-03T10:00:00Z");
  const fork = git(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "main"]);
  return { first, main, fork };
}
