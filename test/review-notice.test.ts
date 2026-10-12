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
import { changeClass, type ProjectPolicy } from "../src/rules.ts";

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
  assert.match(text, /a different model than every contributor/);
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

test("the workspace notice does not attribute an unrelated protection to a local execution file", (t) => {
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
  assert.equal(policySource(dir, controllingRule(["AGENTS.md"], open), open), null);
  const lines = workspaceNotice(git, dir, open)!;
  assert.doesNotMatch(lines.join("\n"), /execution-policy\.v1\.json/);
  assert.match(lines.join("\n"), /AGENTS\.md matches the protected glob AGENTS\.md/);
});

test("a plan's part keeps the notice for a direct change, and says why", () => {
  assert.equal(reviewNotice(["docs/a.md"], governed), null);
  const text = reviewNotice(["docs/a.md"], governed, null, true)!.join("\n");
  assert.match(text, /part of a plan, and every part of a plan is reviewed/);
  assert.match(text, /another model family/);
  assert.ok(reviewNotice(["src/a.ts"], open, null, true));
});

test("an execution policy's protected paths count in the disagreement", () => {
  const policy: ProjectPolicy = { checks: [], protected: [], execution: { allowed_classes: ["protected"], direct: { enabled: false, allowed_path_patterns: [] }, protected_path_patterns: ["src/**"] } };
  const found = reviewDisagreements(policy, [{ file: "AGENTS.md", text: "Review is optional for non-authority changes.\n" }]);
  assert.equal(found.length, 1);
  assert.match(found[0], /src\/\*\*/);
});

test("implicit protections still disagree with instructions making all review optional", () => {
  const policy: ProjectPolicy = { checks: ["node test/check.mjs"], protected: [], shipRuns: ["node bin/deploy.mjs"] };
  for (const path of ["test/check.mjs", "bin/deploy.mjs", "docs/atelier/ship.json"]) {
    assert.equal(controllingRule([path], policy)?.kind, "protected");
  }
  const found = reviewDisagreements(policy, [{ file: "AGENTS.md", text: "Review is optional." }]);
  assert.equal(found.length, 1);
  assert.match(found[0], /test\/check\.mjs/);
  assert.match(found[0], /bin\/deploy\.mjs/);
  assert.match(found[0], /docs\/atelier\/\*\*/);
});

test("the notice measures against the project baseline, not the fork's origin/main", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atelier-notice-base-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sh = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const base = join(root, "base"), fork = join(root, "fork.git"), ws = join(root, "ws");
  mkdirSync(base);
  sh(base, "init", "-b", "main"); writeFileSync(join(base, "a.txt"), "1"); sh(base, "add", "."); sh(base, "commit", "-m", "base");
  sh(root, "clone", "--bare", base, fork); sh(root, "clone", fork, ws);
  writeFileSync(join(ws, "AGENTS.md"), "x"); sh(ws, "add", "."); sh(ws, "commit", "-m", "task"); sh(ws, "push", "-q", "origin", "main");
  const git = (argv: string[], o: { cwd?: string } = {}) => {
    try { return { status: 0, stdout: sh(o.cwd ?? ws, ...argv) }; } catch { return { status: 1, stdout: "" }; }
  };
  const baseline = { remote: base, defaultBranch: "main", token: "t" };
  // The fork already holds the head, so its origin/main sees no change.
  assert.deepEqual(changedFromMain(git, ws), []);
  assert.deepEqual(changedFromMain(git, ws, baseline), ["AGENTS.md"]);
  assert.match(workspaceNotice(git, ws, open, { baseline })!.join("\n"), /AGENTS\.md matches the protected glob/);
});

 test("a local execution file is not the source of checks, ship files, or plan review", () => {
  const source = { file: "docs/control-plane/execution-policy.v1.json", version: "9" };
  for (const [paths, policy, part] of [
    [["AGENTS.md"], open, false],
    [["test/check.mjs"], { ...open, checks: ["node test/check.mjs"] }, false],
    [["docs/atelier/ship.json"], open, false],
    [["docs/a.md"], governed, true],
  ] as const) {
    const text = reviewNotice(paths, policy, source, part)!.join("\n");
    assert.doesNotMatch(text, /Controlling policy: docs\/control-plane\/execution-policy/);
  }
});

test("imported adapter and execution protections name the matching file and version", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-sources-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs/control-plane"), { recursive: true });
  writeFileSync(join(dir, "docs/control-plane/execution-policy.v1.json"), JSON.stringify({ version: 3, protected_path_patterns: ["auth/**"] }));
  writeFileSync(join(dir, "docs/control-plane/project-adapter.v1.json"), JSON.stringify({ version: 2, protected_surfaces: [{ pattern: "db/**" }] }));
  const policy = { ...open, protected: ["auth/**", "db/**", "other/**"] };
  for (const [path, file, version] of [["auth/a", "execution-policy", "3"], ["db/a", "project-adapter", "2"]]) {
    const source = policySource(dir, controllingRule([path], policy), policy);
    assert.deepEqual(source, { file: `docs/control-plane/${file}.v1.json`, version });
    assert.match(reviewNotice([path], policy, () => source)!.join("\n"), new RegExp(file));
  }
  assert.equal(policySource(dir, controllingRule(["other/a"], policy), policy), null);
});

test("post-merge policy gives even a direct docs-only change a protected notice and status disagreement", () => {
  const postMerge: NonNullable<ProjectPolicy["postMerge"]> = {
    version: 1,
    approval: { by: "owner", at: "2026-10-09T00:00:00Z", reason: "run checks after landing" },
    steps: [{ name: "check", command: "node scripts/check.mjs", class: "check", when: "always", protect: ["scripts/**"], timeoutMs: 1000 }],
  };
  for (const base of [governed, { checks: [], protected: [] }]) {
    const policy = { ...base, postMerge };
    for (const path of ["docs/guide.md", "scripts/check.mjs", "scripts/import.mjs", "package.json", ".npmrc"]) {
      assert.equal(changeClass([path], policy), "protected");
      assert.equal(controllingRule([path], policy)?.kind, changeClass([path], policy));
      const text = reviewNotice([path], policy)!.join("\n");
      assert.ok(text.includes(`${path} matches the protected glob`));
      if (path === "docs/guide.md") {
        assert.ok(text.includes(`${path} matches the protected glob **`));
        assert.match(text, /Controlling policy:.*post-merge policy/);
      }
      assert.match(text, /another model family/);
    }
    const found = reviewDisagreements(policy, [{ file: "AGENTS.md", text: "Review is optional for docs." }]);
    assert.equal(found.length, 1);
    assert.match(found[0], /post-merge policy protects all repository paths \(\*\*\)/);
    assert.match(formatStatus([{ name: "p", items: [], inbox: [], mismatches: found }]), /post-merge policy/);
    assert.equal(reviewNotice(["docs/guide.md"], { ...policy, postMerge: null }), null);
  }
});

test("a plan part's notice names the rule's real file and fits a project without an execution policy", () => {
  const text = reviewNotice(["src/a.ts"], open, null, true)!.join("\n");
  assert.match(text, /src\/review\/needed\.ts: reviewNeeded/);
  assert.doesNotMatch(text, /src\/rules\.ts: reviewNeeded/);
  assert.doesNotMatch(text, /execution policy's direct paths/);
  assert.match(text, /no execution policy/);
});

test("a plan part's notice in single-family mode asks for a different model of the same company", () => {
  const single = { ...open, familyMode: { single: "anthropic", by: "pavi", at: "2026-10-11T00:00:00Z" } } as typeof open;
  const text = reviewNotice(["src/a.ts"], single, null, true)!.join("\n");
  assert.match(text, /different anthropic model/);
  assert.doesNotMatch(text, /another family/);
});
