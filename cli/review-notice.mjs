// The early review notice (t422): what `atelier done` and `atelier land` say,
// before any check runs, when the change will need a review, and the
// instruction files `atelier status` compares with the recorded policy. The
// rules are in src/review-notice.ts; this reads the checkout and Git.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reviewNotice } from "../src/review-notice.ts";

export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "GLM.md"];
const EXECUTION_POLICY = "docs/control-plane/execution-policy.v1.json";

// The paths the workspace's head changes from the project baseline, as the
// Worker measures them: the baseline's default branch is fetched with its
// read grant and the merge base taken with it. The fork's origin/main is no
// stand-in (a pushed task's own fork holds its head there), so it and a local
// main serve only where no baseline is given. Null where it cannot be told.
export function changedFromMain(git, dir, baseline) {
  const diffFrom = (rev) => {
    const mb = git(["merge-base", rev, "HEAD"], { cwd: dir, allowFail: true });
    if (mb.status !== 0) return null;
    const diff = git(["diff", "--no-renames", "--name-only", "-z", mb.stdout.trim(), "HEAD"], { cwd: dir, allowFail: true });
    return diff.status === 0 ? diff.stdout.split("\0").filter(Boolean) : null;
  };
  if (baseline) {
    const fetched = git(["fetch", "--quiet", baseline.remote, baseline.defaultBranch], { cwd: dir, token: baseline.token, allowFail: true });
    return fetched.status === 0 ? diffFrom("FETCH_HEAD") : null;
  }
  for (const base of ["origin/main", "main"]) {
    const paths = diffFrom(base);
    if (paths) return paths;
  }
  return null;
}

// Name a local policy only when its relevant rule matches the recorded rule.
// Merely having an execution policy file does not make it the source of every
// protection: checks, ship files and explicit server protections have theirs.
export function policySource(dir, rule, policy) {
  const read = (file) => {
    try { return JSON.parse(readFileSync(join(dir, file), "utf8")); } catch { return null; }
  };
  const execution = read(EXECUTION_POLICY);
  const adapterFile = "docs/control-plane/project-adapter.v1.json";
  const adapter = read(adapterFile);
  let file, doc;
  if (rule?.origin.includes("execution policy") && execution && policy?.execution
      && JSON.stringify(execution.direct) === JSON.stringify(policy.execution.direct)
      && JSON.stringify(execution.protected_path_patterns) === JSON.stringify(policy.execution.protected_path_patterns)) {
    file = EXECUTION_POLICY; doc = execution;
  } else if (rule?.origin === "the project's protected paths" && rule.glob) {
    if (execution?.protected_path_patterns?.includes(rule.glob) || execution?.maintenance_path_rules?.some((r) => r.paths?.includes(rule.glob))) {
      file = EXECUTION_POLICY; doc = execution;
    } else if (adapter?.protected_surfaces?.some((s) => s.pattern === rule.glob)) {
      file = adapterFile; doc = adapter;
    }
  }
  if (!doc) return null;
  const version = doc.version ?? doc.policy_version ?? doc.schema_version;
  return { file, version: version === undefined ? null : String(version) };
}

// The notice's lines for the workspace at `dir`, or null where no review is
// needed or the changed paths cannot be told.
// `baseline` is the read grant for the project baseline ({ remote,
// defaultBranch, token }); `part` says the task is a plan's part.
export function workspaceNotice(git, dir, policy, { baseline, part = false } = {}) {
  if (!policy) return null;
  const paths = changedFromMain(git, dir, baseline);
  return paths ? reviewNotice(paths, policy, (rule) => policySource(dir, rule, policy), part) : null;
}

// The instruction files the checkout holds.
export function readInstructions(dir) {
  const found = [];
  for (const file of INSTRUCTION_FILES) {
    try { found.push({ file, text: readFileSync(join(dir, file), "utf8") }); } catch { /* absent */ }
  }
  return found;
}
