// The staging copy in wrangler.jsonc (release split, PAVI 2026-10-26): an
// env.staging block that shares no state with production. Wrangler carries
// triggers into an environment and does not carry artifacts, durable_objects,
// workflows, r2_buckets or vars, so each is read here as the block states it,
// and set against production's top-level value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// JSONC: comments and trailing commas removed outside strings, then JSON.
function parseJsonc(text) {
  let out = "", i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; }
    else if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2) + 2; }
    else { out += c; i++; }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const config = parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const staging = config.env?.staging;

test("wrangler.jsonc has an env.staging block", () => {
  assert.ok(staging && typeof staging === "object", "env.staging is missing");
});

test("staging names its own Worker, Artifacts namespace, R2 bucket and workflow, each apart from production's", () => {
  assert.equal(config.name, "atelier");
  assert.equal(staging.name, "atelier-staging");
  assert.notEqual(staging.name, config.name);

  assert.deepEqual(config.artifacts, [{ binding: "ARTIFACTS", namespace: "atelier", remote: true }]);
  assert.deepEqual(staging.artifacts, [{ binding: "ARTIFACTS", namespace: "atelier-staging", remote: true }]);
  assert.notEqual(staging.artifacts[0].namespace, config.artifacts[0].namespace);

  assert.deepEqual(config.r2_buckets, [{ binding: "LARGE", bucket_name: "atelier-large" }]);
  assert.deepEqual(staging.r2_buckets, [{ binding: "LARGE", bucket_name: "atelier-large-staging" }]);
  assert.notEqual(staging.r2_buckets[0].bucket_name, config.r2_buckets[0].bucket_name);

  assert.equal(config.workflows[0].name, "landing");
  assert.deepEqual(staging.workflows, [{ name: "landing-staging", binding: "LANDING_WORKFLOW", class_name: "LandingWorkflow" }]);
  assert.notEqual(staging.workflows[0].name, config.workflows[0].name);
});

test("staging states its triggers with no crons, so production's schedules are not inherited", () => {
  assert.ok(Object.hasOwn(staging, "triggers"), "left out, wrangler would carry production's crons into staging");
  assert.deepEqual(staging.triggers, { crons: [] });
  assert.ok(config.triggers.crons.length > 0);
  assert.notDeepEqual(staging.triggers, config.triggers);
});

test("staging answers on next.atelier.zone as a custom domain, with workers.dev off", () => {
  assert.deepEqual(staging.routes, [{ pattern: "next.atelier.zone", custom_domain: true }]);
  assert.notDeepEqual(staging.routes, config.routes);
  assert.equal(staging.workers_dev, false);
});

test("staging sets AI_GATEWAY_ID, its own origin and its own Artifacts namespace as vars", () => {
  assert.equal(staging.vars.AI_GATEWAY_ID, config.vars.AI_GATEWAY_ID);
  assert.equal(typeof staging.vars.AI_GATEWAY_ID, "string");
  assert.equal(staging.vars.PUBLIC_ORIGIN, "https://next.atelier.zone");
  assert.equal(config.vars.PUBLIC_ORIGIN, "https://atelier.zone");
  // The namespace the queue accepts is the one the ARTIFACTS binding names.
  assert.equal(staging.vars.ARTIFACTS_NAMESPACE, staging.artifacts[0].namespace);
  assert.equal(config.vars.ARTIFACTS_NAMESPACE, config.artifacts[0].namespace);
});

test("staging binds LEDGER to its own Ledger class with no script_name, and declares migrations v1 to v3", () => {
  assert.deepEqual(staging.durable_objects, { bindings: [{ name: "LEDGER", class_name: "Ledger" }] });
  for (const binding of staging.durable_objects.bindings) assert.ok(!Object.hasOwn(binding, "script_name"), "a script_name would bind another Worker's objects");
  assert.deepEqual(staging.migrations.map((m) => m.tag), ["v1", "v2", "v3"]);
  assert.deepEqual(staging.migrations, config.migrations);
});

test("production's own settings are as they were", () => {
  assert.deepEqual(config.routes, [{ pattern: "atelier.zone", custom_domain: true }]);
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.triggers, { crons: ["*/5 * * * *", "*/10 * * * *", "7 */6 * * *"] });
  assert.deepEqual(config.durable_objects, { bindings: [{ name: "LEDGER", class_name: "Ledger" }] });
  assert.deepEqual(config.workflows, [{ name: "landing", binding: "LANDING_WORKFLOW", class_name: "LandingWorkflow" }]);
  assert.equal(config.vars.AI_GATEWAY_ID, "atelier");
});
