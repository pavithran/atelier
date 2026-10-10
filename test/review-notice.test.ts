// The early review notice (t422): the controlling policy and rule are named
// before the checks run, and status shows where the recorded policy and the
// written instructions disagree about reviews.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controllingRule, reviewDisagreements, reviewNotice } from "../src/review-notice.ts";
import { changedFromMain, policySource, workspaceNotice } from "../cli/review-notice.mjs";
import { formatStatus, statusJson } from "../cli/status.mjs";
import type { ProjectPolicy } from "../src/rules.ts";

const open: ProjectPolicy = { checks: ["npm test"], protected: ["AGENTS.md", "wrangler.*"] };
const governed: ProjectPolicy = {
  ...open,
  execution: {
    allowed_classes: ["direct", "coordinated", "protected"],
    direct: { enabled: true, allowed_path_patterns: ["docs/**"] },
    protected_path_patterns: ["src/auth/**"],
  },
};

test("a protected change names the glob that made it protected, and its origin", () => {
  const rule = controllingRule(["src/a.ts", "AGENTS.md"], open)!;
  assert.equal(rule.kind, "protected");
  assert.equal(rule.glob, "AGENTS.md");
  assert.equal(rule.path, "AGENTS.md");
  const exec = controllingRule(["src/auth/login.ts"], governed)!;
  assert.match(exec.origin, /protected_path_patterns/);
});

test("the notice names the policy file and version and the exact rule", () => {
  const lines = reviewNotice(["src/auth/login.ts"], governed, { file: "docs/control-plane/execution-policy.v1.json", version: "3" })!;
  const text = lines.join("\n");
  assert.match(text, /review will be needed/);
  assert.match(text, /execution-policy\.v1\.json \(version 3\)/);
  assert.match(text, /src\/auth\/login\.ts matches the protected glob src\/auth\/\*\*/);
  assert.match(text, /another model family/);
});

test("a coordinated change needs a notice only under an execution policy", () => {
  assert.equal(reviewNotice(["src/a.ts"], open), null);
  const text = reviewNotice(["src/a.ts"], governed)!.join("\n");
  assert.match(text, /not within the execution policy's direct paths/);
  assert.match(text, /another agent/);
  assert.match(text, /as stored on the server/);
});

test("a direct change gets no notice", () => {
  assert.equal(reviewNotice(["docs/a.md"], governed), null);
});

test("instructions that call review optional are reported against the recorded policy", () => {
  const found = reviewDisagreements(governed, [{ file: "AGENTS.md", text: "# Rules\nReview is optional for non-authority changes.\n" }]);
  assert.equal(found.length, 1);
  assert.match(found[0], /^AGENTS\.md:2 calls review optional/);
  assert.match(found[0], /recorded policy says/);
  assert.deepEqual(reviewDisagreements(governed, [{ file: "AGENTS.md", text: "Review everything.\n" }]), []);
});

test("status lists the disagreement under its project, and in JSON", () => {
  const mismatches = ["AGENTS.md:2 calls review optional (\"x\"), but the recorded policy says y"];
  const view = { name: "p", items: [], inbox: [], mismatches };
  const text = formatStatus([view]);
  assert.match(text, /Policy and instructions disagree/);
  assert.match(text, /AGENTS\.md:2/);
  assert.deepEqual(statusJson([view])[0].mismatches, mismatches);
  assert.doesNotMatch(formatStatus([{ ...view, mismatches: [] }]), /disagree/);
  assert.equal("mismatches" in statusJson([{ ...view, mismatches: [] }])[0], false);
});

test("the workspace notice reads the changed paths and the policy file's version", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-notice-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (argv: string[], o: { cwd?: string; allowFail?: boolean } = {}) => {
    const r = { status: 0, stdout: "" };
    try { r.stdout = execFileSync("git", argv, { cwd: o.cwd ?? dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { r.status = 1; }
    return r;
  };
  const run = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...a], { cwd: dir, stdio: "ignore" });
  run("init", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "1");
  run("add", "."); run("commit", "-m", "base");
  run("checkout", "-b", "task");
  mkdirSync(join(dir, "docs/control-plane"), { recursive: true });
  writeFileSync(join(dir, "docs/control-plane/execution-policy.v1.json"), JSON.stringify({ version: 4 }));
  writeFileSync(join(dir, "AGENTS.md"), "x");
  run("add", "."); run("commit", "-m", "task");
  assert.deepEqual(changedFromMain(git, dir)?.sort(), ["AGENTS.md", "docs/control-plane/execution-policy.v1.json"]);
  assert.deepEqual(policySource(dir), { file: "docs/control-plane/execution-policy.v1.json", version: "4" });
  const lines = workspaceNotice(git, dir, open)!;
  assert.match(lines.join("\n"), /execution-policy\.v1\.json \(version 4\)/);
  assert.match(lines.join("\n"), /AGENTS\.md matches the protected glob AGENTS\.md/);
});
