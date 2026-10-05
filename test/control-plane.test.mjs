import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { readControlPlane } from "../cli/atelier.mjs";

const agents = { codex: { available: true, eligible_roles: ["executor"], preferred_roles: ["planner"] }, claude: { available: false, eligible_roles: ["assessor"] } };
const execution = { allowed_classes: ["direct", "protected"], direct: { enabled: true, allowed_path_patterns: ["docs/**"] }, protected_path_patterns: ["src/security/**"] };

test("CLI reads roles, preferences and classes without losing protected surfaces", () => {
  mkdirSync(".cache", { recursive: true });
  const top = mkdtempSync(resolve(".cache/control-plane-"));
  const dir = join(top, "docs/control-plane");
  try {
    assert.equal(readControlPlane(top), null);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-policy.v1.json"), JSON.stringify({ agents, authority: { overlapping_claims: "refuse" } }));
    writeFileSync(join(dir, "execution-policy.v1.json"), JSON.stringify({ ...execution, maintenance_path_rules: [{ paths: ["tools/**"] }] }));
    writeFileSync(join(dir, "project-adapter.v1.json"), JSON.stringify({ protected_surfaces: [{ pattern: "adapter/**" }] }));
    const cp = readControlPlane(top);
    assert.deepEqual(cp.agents, agents);
    assert.deepEqual(cp.execution, execution);
    assert.deepEqual(cp.eligible, ["codex"]);
    assert.equal(cp.refuseOverlap, true);
    for (const path of ["src/security/**", "tools/**", "adapter/**", "docs/control-plane/**"]) assert.ok(cp.protected.includes(path));
    rmSync(join(dir, "execution-policy.v1.json"));
    assert.equal(readControlPlane(top).execution, undefined);
    writeFileSync(join(dir, "agent-policy.v1.json"), JSON.stringify({ agents: {} }));
    assert.deepEqual(readControlPlane(top).agents, {});
  } finally { rmSync(top, { recursive: true, force: true }); }
});
