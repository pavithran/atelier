import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ROLES, ROLE_PROMPTS, ROLE_PROMPT_MAX, rolePrompt, guideText } from "../src/usage.ts";
import { roleText } from "../cli/runner.mjs";

// The role prompts behind `atelier guide --role ROLE`: each role has default
// text in src/usage.ts, a project may override it with `.atelier/prompts/ROLE.md`,
// and the runner passes the same text to the agent it runs.

const cli = resolve("cli/atelier.mjs");

function run(args, env = {}, cwd) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-role-"));
  try {
    return spawnSync(process.execPath, [cli, ...args], { cwd: cwd ?? dir, encoding: "utf8", env: { ...process.env, ATELIER_CONFIG_DIR: env.configDir ?? dir, ...env } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("every role has default text, and rolePrompt returns it", () => {
  assert.deepEqual([...ROLES], ["build", "review", "plan", "orchestrate"]);
  for (const role of ROLES) {
    assert.ok(ROLE_PROMPTS[role].length > 40, `${role} has real text`);
    assert.ok(ROLE_PROMPTS[role].endsWith("\n"), `${role} ends with a newline`);
    assert.equal(rolePrompt(role), ROLE_PROMPTS[role]);
  }
});

test("atelier guide --role ROLE prints the default text, and the plain guide is unchanged", () => {
  const r = run(["guide"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, guideText());
  for (const role of ROLES) {
    const each = run(["guide", "--role", role]);
    assert.equal(each.status, 0, role);
    assert.equal(each.stdout, ROLE_PROMPTS[role], `--role ${role}`);
    assert.equal(each.stderr, "");
  }
});

// The orchestrate guide's standing rules, pinned: a change that drops one
// fails here, and docs/orchestrating.md must state the same ones.
const ORCHESTRATE_RULES = [
  /builders from several companies, chosen by tier/,
  /reviewed by a model from another\s+company/,
  /Never override[^.]*except on the owner's own\s+confirmation/,
  /Judge each review finding against the code[^.]*record every\s+verdict/,
  /Land one task at a time/,
  /Report every run that ended without a result/,
  /On a stall/,
  /repeated rejection/,
];

test("the orchestrate guide states each standing rule and names docs/orchestrating.md", () => {
  const text = ROLE_PROMPTS.orchestrate;
  for (const rule of ORCHESTRATE_RULES) assert.match(text, rule);
  assert.match(text, /docs\/orchestrating\.md/);
  assert.equal(run(["guide", "--role", "orchestrate"]).stdout, text);
});

test("docs/orchestrating.md states the same standing rules", () => {
  const doc = readFileSync("docs/orchestrating.md", "utf8");
  for (const rule of ORCHESTRATE_RULES) assert.match(doc, rule);
});

test("the orchestrate guide names the handbook's public URL, and --full prints the handbook from outside the checkout", () => {
  assert.ok(ROLE_PROMPTS.orchestrate.includes("https://github.com/pavithran/atelier/blob/main/docs/orchestrating.md"));
  const full = run(["guide", "--role", "orchestrate", "--full"]);
  assert.equal(full.status, 0, full.stderr);
  assert.equal(full.stdout, readFileSync("docs/orchestrating.md", "utf8"));
  assert.equal(full.stderr, "");
});

test("atelier guide --full refuses a role other than orchestrate, and no role", () => {
  for (const args of [["guide", "--role", "build", "--full"], ["guide", "--full"]]) {
    const r = run(args);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /--full prints the orchestrate handbook/);
    assert.equal(r.stdout, "");
  }
});

test("atelier guide --role refuses a role it does not know, and a --role with no value", () => {
  const unknown = run(["guide", "--role", "proofread"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /--role needs one of build, review, plan, orchestrate/);
  assert.equal(unknown.stdout, "");
  const bare = run(["guide", "--role"]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /--role needs a value/);
});

test("a project's .atelier/prompts/ROLE.md overrides the role's text, for the project named", () => {
  const cfgDir = mkdtempSync(join(tmpdir(), "atelier-role-cfg-"));
  const projectDir = mkdtempSync(join(tmpdir(), "atelier-role-proj-"));
  try {
    mkdirSync(join(projectDir, ".atelier", "prompts"), { recursive: true });
    writeFileSync(join(projectDir, ".atelier", "prompts", "build.md"), "Custom build instructions.\nSecond line.\n");
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ server: null, projects: { demo: { path: projectDir } } }));
    const r = run(["guide", "--role", "build", "--project", "demo"], { configDir: cfgDir }, projectDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "Custom build instructions.\nSecond line.\n");
    // Another role without an override still prints its default.
    const other = run(["guide", "--role", "review", "--project", "demo"], { configDir: cfgDir }, projectDir);
    assert.equal(other.stdout, ROLE_PROMPTS.review);
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("roleText reads the workspace's override and falls back to the default", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-role-text-"));
  try {
    assert.equal(roleText("build", dir), ROLE_PROMPTS.build.trimEnd());
    mkdirSync(join(dir, ".atelier", "prompts"), { recursive: true });
    writeFileSync(join(dir, ".atelier", "prompts", "review.md"), "Override review.\n");
    assert.equal(roleText("review", dir), "Override review.");
    // A blank override file is not an override.
    writeFileSync(join(dir, ".atelier", "prompts", "plan.md"), "  \n");
    assert.equal(roleText("plan", dir), ROLE_PROMPTS.plan.trimEnd());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("roleText refuses a role override over the length cap, loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-role-cap-"));
  try {
    mkdirSync(join(dir, ".atelier", "prompts"), { recursive: true });
    writeFileSync(join(dir, ".atelier", "prompts", "build.md"), "x".repeat(ROLE_PROMPT_MAX + 1));
    assert.throws(() => roleText("build", dir), new RegExp(`over the ${ROLE_PROMPT_MAX} a role prompt may be`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atelier guide --role --project for a project not registered on this Mac dies, not silently prints the default", () => {
  const cfgDir = mkdtempSync(join(tmpdir(), "atelier-role-cfg-"));
  const projectDir = mkdtempSync(join(tmpdir(), "atelier-role-proj-"));
  try {
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ server: null, projects: { demo: { path: projectDir } } }));
    const r = run(["guide", "--role", "build", "--project", "typo"], { configDir: cfgDir }, projectDir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a registered checkout/);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});
