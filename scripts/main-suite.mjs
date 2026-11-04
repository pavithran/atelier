// launchd serializes invocations; select main after the host slot is acquired.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MAIN_SUITE_FILE, readMainSuite, mainSuiteLines } from "../cli/main-suite.mjs";
export { mainSuiteLines };

export function suiteResult(commit, previous, result) {
  const unfinished = result.incomplete || result.error || result.signal || /process group was killed/.test(result.output);
  const green = result.status === 0 && !unfinished;
  const failures = result.output.match(/Failing tests:\n((?:  .+\n?)+)/)?.[1].trim().split(/\n  /) ?? [];
  return { commit, status: green ? "green" : !unfinished && failures.length ? "red" : "incomplete", lastGreen: green ? commit : previous?.lastGreen ?? null,
    failures: green || unfinished ? [] : failures, completedAt: new Date().toISOString() };
}

export function suiteCommandOptions(env = process.env) {
  return { encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    timeout: 59 * 60_000, env: { ...env, ATELIER_TEST_WORKERS: env.ATELIER_MAIN_SUITE_WORKERS ?? "6", ATELIER_TEST_TIMEOUT_MS: "3540000" } };
}

let running = false;
export async function checkMain({ head, read, run, save }) {
  if (running) return;
  running = true;
  try {
    const commit = head(), previous = read();
    if (previous?.commit === commit && previous.status !== "incomplete") return;
    const result = await run(commit);
    save(suiteResult(commit, previous, result));
  } finally { running = false; }
}

export async function studioMainSuite(repo, work, file = MAIN_SUITE_FILE) {
  mkdirSync(work, { recursive: true });
  const command = (cmd, args, cwd) => spawnSync(cmd, args, { ...suiteCommandOptions(), cwd });
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
          writeFileSync(join(dirname(file), "main-suite.log.next"), output);
          if (r.status !== 0 || r.error) return { incomplete: args[0] !== "test", status: r.status, error: r.error, signal: r.signal, output };
        }
        return { status: 0, output };
      } finally { rmSync(source, { recursive: true, force: true }); }
    },
    save: result => {
      if (result.status !== "incomplete") renameSync(join(dirname(file), "main-suite.log.next"), join(dirname(file), "main-suite.log"));
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
