// launchd serializes invocations; select main after the host slot is acquired.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MAIN_SUITE_FILE, readMainSuite, mainSuiteLines } from "../cli/main-suite.mjs";
export { mainSuiteLines };

export function suiteResult(commit, previous, result) {
  const green = result.status === 0;
  const failures = result.output.match(/Failing tests:\n((?:  .+\n?)+)/)?.[1].trim().split(/\n  /) ?? [];
  return { commit, status: green ? "green" : "red", lastGreen: green ? commit : previous?.lastGreen ?? null,
    failures: green ? [] : failures.length ? failures : ["Suite did not complete; see main-suite.log"], completedAt: new Date().toISOString() };
}

let running = false;
export async function checkMain({ head, read, run, save }) {
  if (running) return;
  running = true;
  try {
    const commit = head(), previous = read();
    if (previous?.commit === commit) return;
    const result = await run(commit);
    save(suiteResult(commit, previous, result));
  } finally { running = false; }
}

export async function studioMainSuite(repo, work, file = MAIN_SUITE_FILE) {
  mkdirSync(work, { recursive: true });
  const command = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    timeout: 59 * 60_000, env: { ...process.env, ATELIER_TEST_WORKERS: "1", ATELIER_TEST_TIMEOUT_MS: "3540000" } });
  const git = (...args) => {
    const r = command("git", args, work);
    if (r.error || r.status !== 0) throw Error(r.stderr || r.error?.message || "git failed");
    return r.stdout.trim();
  };
  await checkMain({
    head: () => git("--git-dir", repo, "rev-parse", "refs/heads/main"),
    read: () => readMainSuite(file),
    run: async commit => {
      const source = join(work, "source");
      let output = "";
      try {
        rmSync(source, { recursive: true, force: true });
        git("clone", "--quiet", "--no-hardlinks", repo, source);
        git("-C", source, "checkout", "--quiet", "--detach", commit);
        for (const args of [["ci", "--no-audit", "--no-fund"], ["test"]]) {
          const r = command("npm", args, source);
          output += (r.stdout ?? "") + (r.stderr ?? "") + (r.error?.message ?? "");
          writeFileSync(join(dirname(file), "main-suite.log"), output);
          if (r.status !== 0 || r.error) return { status: 1, output };
        }
        return { status: 0, output };
      } finally { rmSync(source, { recursive: true, force: true }); }
    },
    save: result => {
      writeFileSync(file + ".next", JSON.stringify(result) + "\n", { mode: 0o644 });
      renameSync(file + ".next", file);
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repo, work] = process.argv.slice(2);
  if (!repo || !work) throw Error("Usage: node scripts/main-suite.mjs BARE_REPO WORK_DIRECTORY");
  await studioMainSuite(resolve(repo), resolve(work));
}
