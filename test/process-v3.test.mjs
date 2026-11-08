import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Process v3 (PAVI, 7 November 2026): six rules, taught in docs/orchestrating.md,
// by `atelier guide --role orchestrate` (all six) and by
// `atelier guide --role build` (the builder's rules 3 and 4 only).

const cli = resolve("cli/atelier.mjs");

function guide(role) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-v3-"));
  try {
    const r = spawnSync(process.execPath, [cli, "guide", "--role", role], { cwd: dir, encoding: "utf8", env: { ...process.env, ATELIER_CONFIG_DIR: dir } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.replace(/\s+/g, " ");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DESIGN_NOTE = [
  /design note/i,
  /what it records and where/,
  /production entry point/,
  /crash, a retry, a repeat and a timeout/,
  /one harness scenario/,
  /developer decides the note; a model of another company reads it once/,
];
const RULES_2_TO_6 = [
  /at most five criteria and one mechanism/,
  /prove each criterion from the\s+production entry point/,
  /test each named failure path at the real boundary/,
  /red on main first, then green/,
  /new mechanism goes in its own files; core files only call it/,
  /Never run a build inside the orchestrating session/,
  /match each requirement of the brief to the criterion that tests it/,
];

test("docs/orchestrating.md states each of the six rules under Process v3", () => {
  const doc = readFileSync("docs/orchestrating.md", "utf8").replace(/\s+/g, " ");
  const section = doc.slice(doc.indexOf("## Process v3"), doc.indexOf("## Acting on the developer token"));
  assert.ok(section.length > 100, "the section exists");
  assert.match(section, /7 November 2026/);
  assert.match(section, /Yes, all seven/);
  assert.match(section, /three review rounds and another five/);
  for (const key of [
    /A design note comes before tasks that share a mechanism/,
    /at most five criteria and one mechanism/,
    /proves each criterion from the production entry point/,
    /A new mechanism goes in its own files, and core files only call it/,
    /Builds never run inside the orchestrating session/,
    /match each requirement of the brief to the criterion that tests it/,
  ]) assert.match(section, key);
  for (const part of DESIGN_NOTE.slice(1, 5)) assert.match(section, part);
  assert.match(section, /developer decides it, and a model of another company reads it\s+once/);
});

test("atelier guide --role orchestrate states rule 1 with every part", () => {
  const text = guide("orchestrate");
  for (const part of DESIGN_NOTE) assert.match(text, part);
});

test("atelier guide --role orchestrate states rules 2 to 6", () => {
  const text = guide("orchestrate");
  for (const rule of RULES_2_TO_6) assert.match(text, rule);
});

test("atelier guide --role build states rules 3 and 4 and the walk through each criterion", () => {
  const text = guide("build");
  assert.match(text, /Prove each criterion from the production entry point/);
  assert.match(text, /Test each named failure path at the real boundary/);
  assert.match(text, /red on main first, then green; report both outputs/);
  assert.match(text, /new mechanism in its own files; core files only call it/);
  assert.match(text, /walk each criterion: name its proof and run it, and say plainly which proof you could not run/);
});

test("the build prompt states no orchestrator-only rule", () => {
  const text = guide("build");
  assert.doesNotMatch(text, /design note/i);
  assert.doesNotMatch(text, /five criteria/);
  assert.doesNotMatch(text, /orchestrating session/);
  assert.doesNotMatch(text, /requirement of the brief/);
});
