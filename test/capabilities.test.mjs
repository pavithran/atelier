import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CAPABILITIES, COMMAND_CAPABILITIES, JOB_CAPABILITIES, ROUTE_LEVEL, SERVER_CAPABILITIES,
  buildCapabilities, capabilitiesForLevel, checkCapabilities, commandCapabilities, requiredForCommand, requiredForJobs,
} from "../src/route-level.ts";
import { COMMAND_MODULES } from "../src/usage/commands/index.ts";
import { MANIFEST_PATH } from "../cli/merge-driver.mjs";
import { installMergeConfig } from "../cli/merge-pipeline.mjs";
import { DEFAULT_JOBS } from "../cli/runner-config.mjs";

const need = ["a.one.v1", "a.two.v1"];
const cli = resolve("cli/atelier.mjs");
const SHA = "a".repeat(40), BINDING = "b".repeat(64);

test("declarations are well formed, unique, and every requirement is declared", () => {
  assert.equal(new Set(SERVER_CAPABILITIES).size, CAPABILITIES.length);
  const declared = new Set(SERVER_CAPABILITIES);
  for (const names of [...Object.values(COMMAND_CAPABILITIES), ...Object.values(JOB_CAPABILITIES)]) for (const n of names) assert.ok(declared.has(n), n);
  assert.throws(() => buildCapabilities([{ name: "a.b.v1", summary: "x" }, { name: "a.b.v1", summary: "y" }]), /declared twice/);
  for (const name of ["a", "a.b", "A.b.v1", "a.b.v0", "a.b.v1x", ""]) assert.throws(() => buildCapabilities([{ name, summary: "x" }]), /not family\.behaviour\.vN/);
});

test("a server publishing the required names passes, and extra names are accepted", () => {
  assert.deepEqual(checkCapabilities({ capabilities: need }, need), { ok: true, via: "capabilities" });
  assert.equal(checkCapabilities({ capabilities: [...need, "z.extra.v9"], routeLevel: 1 }, need).ok, true);
  assert.equal(checkCapabilities({ capabilities: [] }, []).ok, true);
});

test("a missing capability is named with the server revision and the deployment remedy", () => {
  const r = checkCapabilities({ capabilities: ["a.one.v1"], commit: "0123456789abcdef" }, need);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "missing");
  assert.deepEqual(r.missing, ["a.two.v1"]);
  assert.match(r.message, /lacks capabilities a\.two\.v1/);
  assert.match(r.message, /main at 01234567/);
  assert.match(r.message, /Deploy the server .*npm run deploy/);
  assert.match(checkCapabilities({ capabilities: [] }, need).message, /unrecorded revision/);
});

test("an incompatible revision in a route family does not satisfy the older name", () => {
  const r = checkCapabilities({ capabilities: ["items.brief-criteria.v2"] }, ["items.brief-criteria.v1"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["items.brief-criteria.v1"]);
  assert.equal(checkCapabilities({ capabilities: ["items.brief-criteria.v1", "items.brief-criteria.v2"] }, ["items.brief-criteria.v1"]).ok, true);
});

test("malformed and unavailable answers get their own errors", () => {
  for (const version of [{ capabilities: "a.one.v1" }, { capabilities: [1] }, { capabilities: ["Bad Name"] }, { capabilities: null }, { routeLevel: "20" }, { routeLevel: 1.5 }, { routeLevel: -1 }, {}, { commit: "abc" }]) {
    assert.equal(checkCapabilities(version, need).kind, "malformed", JSON.stringify(version));
  }
  for (const version of [null, undefined, "ok", 5, []]) assert.equal(checkCapabilities(version, need).kind, "unavailable", String(version));
  assert.match(checkCapabilities(null, need).message, /did not answer GET \/api\/version/);
});

test("legacy route levels map to the documented guarantees only", () => {
  assert.deepEqual(capabilitiesForLevel(5), []);
  assert.deepEqual(capabilitiesForLevel(13), ["plans.integration.v1", "plans.refresh.v1"]);
  assert.deepEqual(capabilitiesForLevel(14), ["plans.integration.v1", "plans.refresh.v1", "land.workflow.v1"]);
  const legacy = CAPABILITIES.filter((c) => c.level !== undefined && c.level <= ROUTE_LEVEL).map((c) => c.name);
  assert.deepEqual(capabilitiesForLevel(ROUTE_LEVEL), legacy);
  assert.deepEqual(capabilitiesForLevel(ROUTE_LEVEL + 100), legacy);
  assert.equal(checkCapabilities({ routeLevel: 17 }, ["reviews.unparsable.v1"]).ok, true);
  const behind = checkCapabilities({ routeLevel: 17 }, ["reviews.unparsable.v1", "models.note.v1"]);
  assert.equal(behind.kind, "missing");
  assert.deepEqual(behind.missing, ["models.note.v1"]);
  assert.match(behind.message, /route level 17/);
});

test("a legacy server is refused for a requirement no level guarantees", () => {
  const r = checkCapabilities({ routeLevel: ROUTE_LEVEL + 100 }, ["future.thing.v1"]);
  assert.equal(r.kind, "unmapped");
  assert.deepEqual(r.missing, ["future.thing.v1"]);
});

test("new declarations, including queued legacy metadata, require published names", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-capabilities-new-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const declarations = [...CAPABILITIES,
    { name: "future.named.v1", summary: "a new route" },
    { name: "future.queued.v1", level: ROUTE_LEVEL + 6, summary: "a queued route" },
  ];
  // Load the real support check against future declarations, as another task would.
  const source = readFileSync(resolve("src/route-level.ts"), "utf8")
    .replace('import { CAPABILITY_DECLARATIONS } from "./capability-declarations.ts";', `const CAPABILITY_DECLARATIONS = ${JSON.stringify(declarations)} as const;`)
    .replaceAll('from "./usage/', `from "${resolve("src/usage")}/`);
  const file = join(dir, "route-level.ts");
  writeFileSync(file, source);
  const future = await import(file);
  for (const name of ["future.named.v1", "future.queued.v1"]) {
    assert.ok(future.SERVER_CAPABILITIES.includes(name));
    for (const version of [{ routeLevel: ROUTE_LEVEL }, { routeLevel: ROUTE_LEVEL + 100 }, { capabilities: SERVER_CAPABILITIES }]) {
      const old = future.checkCapabilities(version, [name]);
      assert.equal(old.ok, false);
      assert.deepEqual(old.missing, [name]);
      assert.match(old.message, /Deploy the server .*npm run deploy/);
    }
    assert.equal(future.checkCapabilities({ routeLevel: 0, capabilities: future.SERVER_CAPABILITIES }, [name]).ok, true);
  }
});

// The check a client from before capabilities made, as cli/land.mjs and
// cli/runner.mjs (versionRefusal) had it at f7493eb^: routeLevel alone, read
// as an integer, refused below the client's own ROUTE_LEVEL. It stands in
// for every old client the new server must keep serving.
function oldClientRefusal(version, clientLevel) {
  const level = Number.isInteger(version?.routeLevel) ? version.routeLevel : null;
  const commit = typeof version?.commit === "string" && version.commit ? version.commit.slice(0, 8) : null;
  const deploy = (why) => `the server ${commit ? `runs main at ${commit}, ` : ""}${level === null ? "reports no route level" : `runs route level ${level}`}, this CLI route level ${clientLevel}: ${why}. Deploy the server from a checkout at route level ${clientLevel} or newer (npm run deploy, which records the commit it deploys), then start the runner again`;
  if (!version) return deploy("the server does not answer GET /api/version");
  if (level === null) return deploy("the server is older than route levels");
  if (level < clientLevel) return deploy("the server's routes are older than the ones this CLI calls");
  return null;
}

test("old clients against the new server: the server's answer carries routeLevel and capabilities", async () => {
  // What src/index.ts answers on GET /api/version, as test/land-routes.spec.ts checks against the worker.
  const answer = { commit: "c0ffee0123456789", routeLevel: ROUTE_LEVEL, capabilities: SERVER_CAPABILITIES };
  // An old client at this level, or any level up to it, reads routeLevel alone and starts.
  for (const clientLevel of [ROUTE_LEVEL, ROUTE_LEVEL - 1, 14, 6, 1]) assert.equal(oldClientRefusal(answer, clientLevel), null, `old client at level ${clientLevel}`);
  // An old client whose level the server has not reached still refuses on the level, as before.
  assert.match(oldClientRefusal(answer, ROUTE_LEVEL + 1), /runs main at c0ffee01, runs route level \d+, this CLI route level \d+: the server's routes are older/);
  // The answer survives the old client's reading whatever the capability list holds.
  assert.equal(oldClientRefusal({ ...answer, capabilities: [...SERVER_CAPABILITIES, "future.thing.v1"] }, ROUTE_LEVEL), null);
  assert.equal(oldClientRefusal({ ...answer, capabilities: [] }, ROUTE_LEVEL), null);
  // and a new client reading a server that carries both uses the capabilities, not the level
  assert.equal(checkCapabilities(answer, COMMAND_CAPABILITIES.land).via, "capabilities");
  assert.equal(checkCapabilities(answer, requiredForJobs(Object.keys(JOB_CAPABILITIES))).ok, true);
  assert.equal(checkCapabilities({ ...answer, routeLevel: 0 }, COMMAND_CAPABILITIES.land).ok, true, "a new client ignores the level when capabilities are published");
  assert.equal(checkCapabilities({ ...answer, capabilities: [] }, COMMAND_CAPABILITIES.land).kind, "missing", "and reads an empty list as empty, not through the level");
});

test("a command or job with no declaration needs nothing", () => {
  assert.deepEqual(requiredForJobs(["unknown-job"]), []);
  assert.equal(COMMAND_CAPABILITIES.help, undefined);
  assert.deepEqual(requiredForCommand("help"), []);
  assert.deepEqual(requiredForCommand("status"), []);
});

// t458 rework: every command whose handler calls a route a named capability
// stands for declares it in its module, src/usage/commands/NAME.ts, and the
// CLI checks the declaration before the handler runs. The list here is the
// set of commands that depend on one; a command dropped from it, or one that
// starts depending on a capability without declaring it, fails here.
test("each command that relies on a named capability declares it in its module", () => {
  assert.deepEqual(Object.keys(COMMAND_CAPABILITIES).sort(), ["abandon", "accept", "block", "board", "branch", "claim", "clear-secret", "criteria-finding", "criteria-review", "criteria-review-claim", "criteria-review-failed", "criteria-verdict", "edit", "fast", "identity", "init", "integrated", "integration-failed", "land", "merge", "mode", "models", "new", "plan", "push", "record-merge", "refresh-checked", "refresh-failed", "refresh-lease", "refresh-pushing", "refreshed", "refreshes", "revert", "review", "review-claim", "review-request", "review-unparsable", "review-withdraw", "start", "stuck", "token", "unblock", "wrap"]);
  for (const command of ["integrated", "integration-failed", "refreshed", "refresh-failed"]) assert.deepEqual(COMMAND_CAPABILITIES[command], ["plans.integration.v1"], command);
  // The task refresh (t462): its queue, lease and reports.
  for (const command of ["refreshes", "refresh-lease", "refresh-pushing", "refresh-checked"]) assert.deepEqual(COMMAND_CAPABILITIES[command], ["refresh.tasks.v1"], command);
  // land counts the runners that skipped its review request by the request number the answer carries (t353).
  assert.deepEqual(COMMAND_CAPABILITIES.land, ["projects.commit-identity.v1", "land.workflow.v1", "items.brief-criteria.v1", "reviews.criteria-binding.v1", "projects.require-criteria.v1", "reviews.skip.v1", "land.post-merge.v1", "land.triage.v1"]);
  // new and edit no longer assign a function area (t769); board reads the snapshot.
  assert.deepEqual(COMMAND_CAPABILITIES.new, ["items.brief-criteria.v1"]);
  assert.deepEqual(COMMAND_CAPABILITIES.edit, ["items.brief-criteria.v1", "reviews.criteria-binding.v1", "items.context.v1"]);
  assert.deepEqual(COMMAND_CAPABILITIES.board, ["areas.board.v1"]);
  // branch mints the developer's branches token and records each push (t641).
  assert.deepEqual(COMMAND_CAPABILITIES.branch, ["projects.developer-branches.v1"]);
  // mode switches the project's mode (t585); fast status reads the
  // ready reports of the removed fast build (t589, t228).
  // mode fast, accept and merge send the developer's direction with --quote (t629).
  assert.deepEqual(COMMAND_CAPABILITIES.mode, ["projects.mode.v1", "projects.developer-direction.v1"]);
  assert.deepEqual(COMMAND_CAPABILITIES.accept, ["projects.developer-direction.v1"]);
  // block, unblock, abandon and clear-secret send it with --quote (t178).
  for (const command of ["block", "unblock", "abandon", "clear-secret"]) assert.deepEqual(COMMAND_CAPABILITIES[command], ["items.developer-direction.v1"], command);
  assert.deepEqual(COMMAND_CAPABILITIES.fast, ["projects.mode.v1", "runners.fast-build.v1"]);
  // stuck reads the owner's stuck report route (t441).
  assert.deepEqual(COMMAND_CAPABILITIES.stuck, ["projects.stuck.v1"]);
  assert.deepEqual(COMMAND_CAPABILITIES.init, ["projects.commit-identity.v1", "projects.require-criteria.v1", "land.post-merge.v1", "land.triage.v1", "reviews.criteria-review.v1"]);
  // The criteria review's commands post the criteria-review routes (t438).
  for (const command of ["criteria-review", "criteria-review-claim", "criteria-verdict", "criteria-review-failed", "criteria-finding"]) assert.deepEqual(COMMAND_CAPABILITIES[command], ["reviews.criteria-review.v1"], command);
  for (const command of ["review", "review-claim"]) assert.deepEqual(COMMAND_CAPABILITIES[command], ["reviews.criteria-binding.v1"], command);
  // merge posts the owner's review and, for an accepted plan that conflicts with main, the plan refresh route.
  assert.deepEqual(COMMAND_CAPABILITIES.merge, ["projects.commit-identity.v1", "reviews.criteria-binding.v1", "plans.refresh.v1", "projects.developer-direction.v1"]);
  assert.deepEqual(COMMAND_CAPABILITIES.plan, ["plans.refresh.v1"]);
  assert.deepEqual(COMMAND_CAPABILITIES["review-unparsable"], ["reviews.unparsable.v1"]);
  assert.deepEqual(COMMAND_CAPABILITIES["review-withdraw"], ["reviews.withdraw.v1"]);
  // record-merge records a merge made outside Atelier (t653).
  assert.deepEqual(COMMAND_CAPABILITIES["record-merge"], ["land.record-merge.v1"]);
  // The declarations are the modules' own: the module says what the registry reads.
  for (const { spec } of COMMAND_MODULES) {
    const declared = [...new Set([...(spec.capabilities ?? []), ...Object.values(spec.subcommands ?? {}).flatMap((s) => s.capabilities ?? [])])];
    assert.deepEqual(COMMAND_CAPABILITIES[spec.name] ?? [], declared, spec.name);
  }
  assert.deepEqual(COMMAND_CAPABILITIES.push, ["items.owner-port.v1"]);
  // land exempts --release-lease; push checks only when porting as the owner.
  assert.deepEqual(COMMAND_MODULES.filter(({ spec }) => spec.capabilityCheck === "handler").map(({ spec }) => spec.name), ["land", "push"]);
});

test("a subcommand's capabilities are asked only when that subcommand runs", () => {
  // atelier models lists the pool on any server; note and show need the notes.
  assert.deepEqual(requiredForCommand("models"), []);
  assert.deepEqual(requiredForCommand("models", "add"), []);
  assert.deepEqual(requiredForCommand("models", "note"), ["models.note.v1"]);
  assert.deepEqual(requiredForCommand("models", "show"), ["models.note.v1"]);
  // card posts vendor cards (t625); show prints them only where the server has them.
  assert.deepEqual(requiredForCommand("models", "card"), ["models.card.v1"]);
  // set posts the pool's standing (t389); add needs it only when it gives --state, --roles or --tier.
  assert.deepEqual(requiredForCommand("models", "set"), ["models.standing.v1"]);
  assert.deepEqual(requiredForCommand("models", "add", { harness: "codex" }), []);
  for (const flag of ["state", "roles", "tier"]) assert.deepEqual(requiredForCommand("models", "add", { [flag]: "x" }), ["models.standing.v1"], flag);
  // assign and roles record and read role assignments (t622).
  assert.deepEqual(requiredForCommand("models", "assign"), ["models.roles.v1"]);
  assert.deepEqual(requiredForCommand("models", "roles"), ["models.roles.v1"]);
  // review reads the recurring model review (t624).
  assert.deepEqual(requiredForCommand("models", "review"), ["models.review.v1"]);
  assert.deepEqual(COMMAND_CAPABILITIES.models, ["reviews.admission.v1", "models.note.v1", "models.card.v1", "models.review.v1", "models.standing.v1", "models.roles.v1"]);
  assert.deepEqual(requiredForCommand("token", "issue"), ["runners.scoped-token.v1"]);
  assert.deepEqual(requiredForCommand("token", "store"), ["runners.scoped-token.v1"]);
  assert.deepEqual(requiredForCommand("token", "ls"), []);
  // atelier plan, plan show and the rest call routes every server has; refresh posts the plan refresh route.
  for (const word of [undefined, "show", "approve", "revise", "reroute", "retry", "stop", "post", "t1"]) assert.deepEqual(requiredForCommand("plan", word), [], String(word));
  assert.deepEqual(requiredForCommand("plan", "refresh"), ["plans.refresh.v1"]);
  // A prototype key is not a subcommand.
  assert.deepEqual(requiredForCommand("models", "constructor"), []);
  // The command's own are asked under every word.
  assert.deepEqual(requiredForCommand("edit", "t1"), ["items.brief-criteria.v1", "reviews.criteria-binding.v1", "items.context.v1"]);
});

test("a module that requires a name no declaration publishes is refused, naming the module", () => {
  const module = (spec) => [{ path: `src/usage/commands/${spec.name}.ts`, spec: { forms: [], flags: {}, ...spec } }];
  assert.throws(() => commandCapabilities(module({ name: "x", capabilities: ["items.brief-criteria.v9"] })), /src\/usage\/commands\/x\.ts: atelier x requires capability items\.brief-criteria\.v9, which src\/route-level\.ts does not declare/);
  assert.throws(() => commandCapabilities(module({ name: "x", subcommands: { go: { capabilities: ["nope.thing.v1"] } } })), /atelier x go requires capability nope\.thing\.v1/);
  assert.deepEqual(commandCapabilities(module({ name: "x" })), {});
  assert.deepEqual(commandCapabilities(module({ name: "x", capabilities: ["models.note.v1", "models.note.v1"], subcommands: { go: {} } })), { x: { own: ["models.note.v1"], subcommands: {} } });
});

// t458 rework: the integrate and refresh jobs claim the task, read Git
// through the runner's credential and post the integration routes, so the
// integrator's start check has something to check.
test("every runner job declares what it needs, the integrator's jobs included", () => {
  for (const job of [...DEFAULT_JOBS, "review", "criteria-review", "integrate", "refresh"]) assert.ok(JOB_CAPABILITIES[job]?.length, `${job} declares nothing`);
  assert.deepEqual(requiredForJobs(["integrate", "refresh"]), ["projects.commit-identity.v1", "plans.integration.v1", "runners.scoped-token.v1", "runners.run-skip.v1"]);
  const required = requiredForJobs(["integrate", "refresh"]);
  assert.equal(checkCapabilities({ capabilities: [] }, required).kind, "missing");
  // The run skip (t420) has no legacy level, so a server that reports only a level is refused for it.
  assert.equal(checkCapabilities({ routeLevel: 0 }, required).kind, "unmapped");
  assert.deepEqual(checkCapabilities({ routeLevel: 0 }, required).missing, required);
  assert.deepEqual(checkCapabilities({ routeLevel: ROUTE_LEVEL }, required).missing, ["runners.run-skip.v1"]);
  assert.equal(checkCapabilities({ capabilities: SERVER_CAPABILITIES }, required).ok, true);
  // A server with the routes but not the runner credential is short of one.
  assert.deepEqual(checkCapabilities({ routeLevel: 19 }, required).missing, ["projects.commit-identity.v1", "runners.scoped-token.v1", "runners.run-skip.v1"]);
});

test("the integration routes are guaranteed from legacy level 6, as the commits that added them document", () => {
  assert.deepEqual(capabilitiesForLevel(5), []);
  // Level 6 was one raise for two routes' sides (933d198): the integrator's and the owner's plan refresh.
  assert.deepEqual(capabilitiesForLevel(6), ["plans.integration.v1", "plans.refresh.v1"]);
  assert.deepEqual(capabilitiesForLevel(13), ["plans.integration.v1", "plans.refresh.v1"]);
  assert.deepEqual(capabilitiesForLevel(14), ["plans.integration.v1", "plans.refresh.v1", "land.workflow.v1"]);
});

test("the legacy route level is frozen; additions need no numeric allocation", () => {
  assert.equal(ROUTE_LEVEL, 29, "declare a named capability instead of raising ROUTE_LEVEL again");
  // main's raises while t458 was built: the review skip (t353, 21 and 22) and the function areas (t456, 23).
  assert.deepEqual(CAPABILITIES.filter((c) => c.level === 21).map((c) => c.name), ["reviews.skip.v1"]);
  assert.deepEqual(CAPABILITIES.filter((c) => c.level === 22).map((c) => c.name), ["reviews.skip-as-runner.v1"]);
  assert.deepEqual(CAPABILITIES.filter((c) => c.level === 23).map((c) => c.name).sort(), ["areas.board.v1", "areas.manage.v1"]);
  assert.deepEqual(capabilitiesForLevel(20).filter((n) => n.startsWith("reviews.skip") || n.startsWith("areas.")), []);
  assert.deepEqual(capabilitiesForLevel(22).filter((n) => n.startsWith("areas.")), []);
});

test("post-merge runs are guaranteed from legacy level 27 alone, and init and land require them (t477)", () => {
  assert.deepEqual(CAPABILITIES.filter((c) => c.level === 27).map((c) => c.name), ["land.post-merge.v1"]);
  for (const command of ["init", "land"]) {
    // init also requires the criteria review (t438) and the publication policy (t433), which no legacy level guarantees, checked below.
    const upTo27 = COMMAND_CAPABILITIES[command].filter((n) => n !== "land.triage.v1" && n !== "reviews.criteria-review.v1" && n !== "projects.publication-policy.v1" && n !== "projects.developer-direction.v1");
    assert.deepEqual(checkCapabilities({ routeLevel: 26 }, upTo27).missing, ["land.post-merge.v1"], command);
    assert.equal(checkCapabilities({ routeLevel: 27 }, upTo27).ok, true, command);
  }
});

// t770 removed publish REMOTE and the init flags that recorded the policy's destinations and
// privacy rules. A CLI from before it still requires the capability, so the server keeps declaring it.
test("the server still declares the publication policy for CLIs from before t770, and no command requires it", () => {
  assert.equal(CAPABILITIES.find((c) => c.name === "projects.publication-policy.v1")?.level, undefined);
  assert.ok(SERVER_CAPABILITIES.includes("projects.publication-policy.v1"));
  for (const [command, names] of Object.entries(COMMAND_CAPABILITIES)) assert.ok(!names.includes("projects.publication-policy.v1"), command);
  assert.ok(!requiredForCommand("init").includes("projects.publication-policy.v1"));
});

test("the landing's triage is guaranteed from legacy level 28 alone, and init and land require it (t475)", () => {
  assert.deepEqual(CAPABILITIES.filter((c) => c.level === 28).map((c) => c.name), ["land.triage.v1"]);
  for (const command of ["init", "land"]) {
    const upTo28 = COMMAND_CAPABILITIES[command].filter((n) => n !== "reviews.criteria-review.v1" && n !== "projects.publication-policy.v1" && n !== "projects.developer-direction.v1");
    assert.deepEqual(checkCapabilities({ routeLevel: 27 }, upTo28).missing, ["land.triage.v1"], command);
    assert.equal(checkCapabilities({ routeLevel: 28 }, upTo28).ok, true, command);
  }
});

test("the criteria review job and init require the criteria review by name, which no legacy level guarantees (t438)", () => {
  assert.equal(CAPABILITIES.find((c) => c.name === "reviews.criteria-review.v1")?.level, undefined);
  assert.ok(SERVER_CAPABILITIES.includes("reviews.criteria-review.v1"));
  assert.deepEqual(requiredForJobs(["criteria-review"]), ["reviews.criteria-review.v1", "runners.scoped-token.v1"]);
  const without = SERVER_CAPABILITIES.filter((n) => n !== "reviews.criteria-review.v1");
  for (const required of [requiredForJobs(["criteria-review"]), COMMAND_CAPABILITIES.init]) {
    assert.equal(checkCapabilities({ capabilities: SERVER_CAPABILITIES }, required).ok, true);
    assert.deepEqual(checkCapabilities({ capabilities: without }, required).missing, ["reviews.criteria-review.v1"]);
    const legacy = checkCapabilities({ routeLevel: ROUTE_LEVEL + 4 }, required);
    assert.equal(legacy.kind, "unmapped");
    assert.ok(legacy.missing.includes("reviews.criteria-review.v1"));
  }
});

test("atelier stuck requires the stuck report by name, which no legacy level guarantees (t441)", () => {
  assert.equal(CAPABILITIES.find((c) => c.name === "projects.stuck.v1")?.level, undefined);
  assert.ok(SERVER_CAPABILITIES.includes("projects.stuck.v1"));
  assert.equal(checkCapabilities({ capabilities: SERVER_CAPABILITIES }, COMMAND_CAPABILITIES.stuck).ok, true);
  assert.deepEqual(checkCapabilities({ capabilities: SERVER_CAPABILITIES.filter((n) => n !== "projects.stuck.v1") }, COMMAND_CAPABILITIES.stuck).missing, ["projects.stuck.v1"]);
  const legacy = checkCapabilities({ routeLevel: ROUTE_LEVEL + 2 }, COMMAND_CAPABILITIES.stuck);
  assert.equal(legacy.kind, "unmapped");
  assert.deepEqual(legacy.missing, ["projects.stuck.v1"]);
});

test("fast status requires the fast build by name, which no legacy level guarantees; close does not (t589)", () => {
  assert.equal(CAPABILITIES.find((c) => c.name === "runners.fast-build.v1")?.level, undefined);
  assert.ok(SERVER_CAPABILITIES.includes("runners.fast-build.v1"));
  for (const word of ["status"]) {
    const required = requiredForCommand("fast", word);
    assert.deepEqual(required, ["projects.mode.v1", "runners.fast-build.v1"], word);
    assert.equal(checkCapabilities({ capabilities: SERVER_CAPABILITIES }, required).ok, true, word);
    assert.deepEqual(checkCapabilities({ capabilities: SERVER_CAPABILITIES.filter((n) => n !== "runners.fast-build.v1") }, required).missing, ["runners.fast-build.v1"], word);
    assert.equal(checkCapabilities({ routeLevel: ROUTE_LEVEL + 3 }, required).kind, "unmapped", word);
  }
  assert.deepEqual(requiredForCommand("fast", "close"), ["projects.mode.v1"]);
  // The build job asks nothing of it: the fork-less build is gone (t228).
  assert.ok(!JOB_CAPABILITIES.build.includes("runners.fast-build.v1"));
  assert.equal(ROUTE_LEVEL, 29);
});

// t591: the infrastructure_miss run report is published by name, and no job
// requires it: a runner starts against a server without it (the live one
// until its deploy) and sends the review skip there instead.
test("the infrastructure_miss run report is a named capability no runner job requires (t591)", () => {
  assert.equal(CAPABILITIES.find((c) => c.name === "runs.infrastructure-miss.v1")?.level, undefined);
  assert.ok(SERVER_CAPABILITIES.includes("runs.infrastructure-miss.v1"));
  for (const job of Object.keys(JOB_CAPABILITIES)) assert.ok(!JOB_CAPABILITIES[job].includes("runs.infrastructure-miss.v1"), job);
});

test("models set requires the pool's standing by name, which no legacy level guarantees (t389)", () => {
  assert.equal(CAPABILITIES.find((c) => c.name === "models.standing.v1")?.level, undefined);
  assert.ok(SERVER_CAPABILITIES.includes("models.standing.v1"));
  const set = requiredForCommand("models", "set");
  assert.equal(checkCapabilities({ capabilities: SERVER_CAPABILITIES }, set).ok, true);
  assert.deepEqual(checkCapabilities({ capabilities: SERVER_CAPABILITIES.filter((n) => n !== "models.standing.v1") }, set).missing, ["models.standing.v1"]);
  const legacy = checkCapabilities({ routeLevel: ROUTE_LEVEL + 3 }, set);
  assert.equal(legacy.kind, "unmapped");
  assert.deepEqual(legacy.missing, ["models.standing.v1"]);
});

test("every job but the review requires the run skip by name, which no legacy level guarantees (t420)", () => {
  assert.equal(CAPABILITIES.find((c) => c.name === "runners.run-skip.v1")?.level, undefined);
  assert.ok(SERVER_CAPABILITIES.includes("runners.run-skip.v1"));
  const without = SERVER_CAPABILITIES.filter((n) => n !== "runners.run-skip.v1");
  for (const job of [...DEFAULT_JOBS, "integrate", "refresh"]) {
    assert.ok(JOB_CAPABILITIES[job].includes("runners.run-skip.v1"), job);
    assert.deepEqual(checkCapabilities({ capabilities: without }, requiredForJobs([job])).missing, ["runners.run-skip.v1"], job);
    assert.equal(checkCapabilities({ capabilities: SERVER_CAPABILITIES }, requiredForJobs([job])).ok, true, job);
    const legacy = checkCapabilities({ routeLevel: ROUTE_LEVEL }, requiredForJobs([job]));
    assert.equal(legacy.kind, "unmapped", job);
    assert.deepEqual(legacy.missing, ["runners.run-skip.v1"], job);
  }
  assert.ok(!JOB_CAPABILITIES.review.includes("runners.run-skip.v1"));
  // The task refresh's jobs report one they give up too (t462).
  for (const job of ["task-refresh", "task-resolve"]) {
    assert.deepEqual(checkCapabilities({ capabilities: without }, requiredForJobs([job])).missing, ["runners.run-skip.v1"], job);
    assert.equal(checkCapabilities({ capabilities: SERVER_CAPABILITIES }, requiredForJobs([job])).ok, true, job);
  }
});

test("main's identity and reviewer admission guarantees keep their legacy boundaries", () => {
  assert.deepEqual(CAPABILITIES.filter((c) => c.level === 24).map((c) => c.name), ["projects.commit-identity.v1"]);
  assert.deepEqual(CAPABILITIES.filter((c) => c.level === 25).map((c) => c.name), ["reviews.admission.v1"]);
  for (const command of ["revert", "claim", "start", "wrap", "init", "land", "merge"]) {
    assert.ok(COMMAND_CAPABILITIES[command].includes("projects.commit-identity.v1"), command);
    // Only what levels up to 24 guarantee: init and land also require the post-merge runs (27, t477) and the triage step (28, t475),
    // and init the criteria review (t438) and the publication policy (t433), and merge the developer's direction (t629), which no level guarantees.
    const upTo24 = COMMAND_CAPABILITIES[command].filter((n) => n !== "land.post-merge.v1" && n !== "land.triage.v1" && n !== "reviews.criteria-review.v1" && n !== "projects.publication-policy.v1" && n !== "projects.developer-direction.v1");
    assert.deepEqual(checkCapabilities({ routeLevel: 23 }, upTo24).missing, ["projects.commit-identity.v1"]);
    assert.equal(checkCapabilities({ routeLevel: 24 }, upTo24).ok, true);
  }
  for (const word of ["admit", "withdraw", "reviewers"]) {
    assert.deepEqual(requiredForCommand("models", word), ["reviews.admission.v1"]);
    assert.equal(checkCapabilities({ routeLevel: 24 }, requiredForCommand("models", word)).kind, "missing");
    assert.equal(checkCapabilities({ routeLevel: 25 }, requiredForCommand("models", word)).ok, true);
  }
});

// The review job reports a review it will not serve as the job's actor
// (t353): a server at 20, which has the review routes but refuses the skip,
// and one at 21, which refuses a runner token's skip, are both short.
test("the review job requires the skip routes, and a legacy server from before them is refused", () => {
  assert.deepEqual(JOB_CAPABILITIES.review, ["reviews.post-merge.v1", "projects.commit-identity.v1", "reviews.criteria-binding.v1", "reviews.lease.v1", "reviews.unparsable.v1", "reviews.skip.v1", "reviews.skip-as-runner.v1", "runners.scoped-token.v1"]);
  assert.deepEqual(checkCapabilities({ routeLevel: 20 }, requiredForJobs(["review"])).missing, ["reviews.post-merge.v1", "projects.commit-identity.v1", "reviews.lease.v1", "reviews.skip.v1", "reviews.skip-as-runner.v1"]);
  assert.deepEqual(checkCapabilities({ routeLevel: 21 }, requiredForJobs(["review"])).missing, ["reviews.post-merge.v1", "projects.commit-identity.v1", "reviews.lease.v1", "reviews.skip-as-runner.v1"]);
  // A server before t351's claim leases (level 25) would accept the claim and then refuse every renewal.
  assert.deepEqual(checkCapabilities({ routeLevel: 25 }, requiredForJobs(["review"])).missing, ["reviews.post-merge.v1", "reviews.lease.v1"]);
  assert.equal(checkCapabilities({ routeLevel: 26 }, requiredForJobs(["review"])).ok, false);
  assert.equal(checkCapabilities({ capabilities: SERVER_CAPABILITIES.filter((n) => !n.startsWith("areas.")) }, requiredForJobs([...DEFAULT_JOBS, "review", "integrate", "refresh"])).ok, true, "no job asks for the areas");
  const short = checkCapabilities({ capabilities: SERVER_CAPABILITIES.filter((n) => n !== "reviews.skip-as-runner.v1") }, requiredForJobs(["review"]));
  assert.deepEqual(short.missing, ["reviews.skip-as-runner.v1"]);
  assert.equal(checkCapabilities({ capabilities: SERVER_CAPABILITIES.filter((n) => n !== "reviews.skip-as-runner.v1") }, requiredForJobs(["build"])).ok, true);
});

// Exercise git merge itself so this also verifies the committed attribute,
// which routes the file to the records driver (t463) through this
// repository's manifest, installed as Atelier installs it in every clone.
test("independent capability additions merge cleanly, including the same and new families; a name both sides add stops as a conflict", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-capabilities-merge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Capability test");
  git("config", "user.email", "capability@example.test");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "cli"));
  mkdirSync(join(dir, "src"));
  const file = "src/capability-declarations.ts";
  const base = readFileSync(resolve(file), "utf8");
  writeFileSync(join(dir, file), base);
  writeFileSync(join(dir, ".gitattributes"), readFileSync(resolve(".gitattributes")));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, MANIFEST_PATH), readFileSync(resolve(MANIFEST_PATH)));
  installMergeConfig(dir);
  const supportSource = readFileSync(resolve("src/route-level.ts"), "utf8")
    .replaceAll('from "./usage/', `from "${resolve("src/usage")}/`);
  writeFileSync(join(dir, "src/route-level.ts"), supportSource);
  git("add", "."); git("commit", "-qm", "base");
  const baseline = git("rev-parse", "HEAD").trim();
  const add = (name, summary, level) => base.replace("] as const;", `  { name: "${name}", ${level === undefined ? "" : `level: ${level}, `}summary: "${summary}" },\n] as const;`);
  const cases = [
    { names: ["reviews.first.v1", "reviews.second.v1"] },
    { names: ["one.new.v1", "two.new.v1"] },
    { names: ["reviews.same.v1", "reviews.same.v1"] },
    // Queued tasks keep their metadata, even with gaps or overlapping levels.
    { names: ["queued.first.v1", "queued.second.v1"], levels: [ROUTE_LEVEL + 1, ROUTE_LEVEL + 6] },
    { names: ["queued.first.v1", "queued.second.v1"], levels: [ROUTE_LEVEL + 1, ROUTE_LEVEL + 1] },
  ];
  for (const [i, { names, levels = [] }] of cases.entries()) {
    git("checkout", "-qB", `ours-${i}`, baseline);
    writeFileSync(join(dir, file), add(names[0], "ours", levels[0]));
    git("add", file); git("commit", "-qm", "ours");
    git("checkout", "-qB", `theirs-${i}`, baseline);
    writeFileSync(join(dir, file), add(names[1], "theirs", levels[1]));
    git("add", file); git("commit", "-qm", "theirs");
    for (const [first, second] of [[`ours-${i}`, `theirs-${i}`], [`theirs-${i}`, `ours-${i}`]]) {
      git("checkout", "-qB", `merge-${first}`, first);
      if (names[0] === names[1]) {
        // The same name added differently on both sides is a key conflict
        // the merge leaves for a person, never two declarations.
        assert.throws(() => git("merge", "--no-edit", second), /reviews\.same\.v1: added by both sides with different records/);
        assert.match(readFileSync(join(dir, file), "utf8"), /^<{7} ours\n {2}\{ name: "reviews\.same\.v1"/m);
        git("merge", "--abort");
        continue;
      }
      git("merge", "--no-edit", second);
      const merged = readFileSync(join(dir, file), "utf8");
      assert.doesNotMatch(merged, /^[<>=]{7}/m);
      assert.ok(merged.includes('summary: "ours"') && merged.includes('summary: "theirs"'));
      assert.equal(readFileSync(join(dir, "src/route-level.ts"), "utf8"), supportSource);
      // Give each merged module its own declaration import to avoid Node's cache.
      const declarationsFile = `declarations-${first}.ts`;
      writeFileSync(join(dir, "src", declarationsFile), merged);
      const supportFile = join(dir, "src", `support-${first}.ts`);
      writeFileSync(supportFile, supportSource.replace("./capability-declarations.ts", `./${declarationsFile}`));
      if (names[0] === names[1]) await assert.rejects(import(supportFile), /declared twice/);
      else {
        const { SERVER_CAPABILITIES: published, checkCapabilities, ROUTE_LEVEL: mergedLevel } = await import(supportFile);
        assert.equal(mergedLevel, ROUTE_LEVEL);
        assert.deepEqual(published.filter((n) => names.includes(n)).sort(), [...names].sort());
        for (const name of names) {
          for (const version of [{ routeLevel: ROUTE_LEVEL + 100 }, { routeLevel: ROUTE_LEVEL, capabilities: SERVER_CAPABILITIES }]) {
            const old = checkCapabilities(version, [name]);
            assert.equal(old.ok, false);
            assert.deepEqual(old.missing, [name]);
            assert.match(old.message, /Deploy the server .*npm run deploy/);
          }
          assert.deepEqual(checkCapabilities({ routeLevel: ROUTE_LEVEL, capabilities: published }, [name]), { ok: true, via: "capabilities" });
          const firstOnly = [...SERVER_CAPABILITIES, names[first.startsWith("ours") ? 0 : 1]];
          assert.equal(checkCapabilities({ capabilities: firstOnly }, [name]).ok, firstOnly.includes(name));
        }
      }
    }
  }
});

// The CLI against a stub server: what GET /api/version answers decides
// whether the command's first request is made.
async function stub(t, version, { status = 200 } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, path: req.url });
    if (req.url === "/api/version") {
      res.writeHead(status, { "content-type": "application/json" });
      return res.end(typeof version === "string" ? version : JSON.stringify(version));
    }
    res.writeHead(200, { "content-type": "application/json" });
    // One answer for every route: an item, a pool entry, a token, a note,
    // and a project with no live items, which atelier new reads first to
    // refuse a duplicate (t409).
    res.end(JSON.stringify({ items: [], id: "t1", title: "x", scope: [], head: SHA, item: { id: "t1", head: SHA, state: "claimed", title: "x", scope: [] }, criteria: BINDING, at: "2026-10-10T00:00:00.000Z", by: "owner", text: "x", kept: true, expiresAt: "later", token: "atl_x", actor: "codex/x", remote: "https://fork.invalid/x.git", defaultBranch: "main" }));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const root = mkdtempSync(join(tmpdir(), "atelier-capabilities-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const run = (argv) => new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd: root, env: { ...process.env, ATELIER_ACTOR: "codex/x", ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: origin } });
    let output = "";
    child.stdout.on("data", (s) => (output += s));
    child.stderr.on("data", (s) => (output += s));
    child.on("close", (status) => done({ status, output }));
  });
  return { requests, run, root };
}

// One invocation of each command and subcommand that declares capabilities
// and leaves the check to the CLI, with the words that reach its first
// request. land checks for itself, after --release-lease and before the lease
// is read (cli/land.mjs); test/land.test.mjs covers that refusal and that
// --release-lease asks for no version.
function invocations(root) {
  const reply = join(root, "reply.txt");
  writeFileSync(reply, "no verdict here");
  return [
    { argv: ["new", "A short title", "--project", "proj"], required: COMMAND_CAPABILITIES.new },
    { argv: ["edit", "t1", "--title", "Another", "--project", "proj"], required: COMMAND_CAPABILITIES.edit },
    { argv: ["init", "--title", "Proj"], required: COMMAND_CAPABILITIES.init },
    { argv: ["merge", "t1", "--project", "proj"], required: requiredForCommand("merge", "t1", {}) },
    { argv: ["plan", "refresh", "t1", "--project", "proj"], required: ["plans.refresh.v1"] },
    { argv: ["models", "admit", "gpt", "--project", "proj", "--reason", "independent"], required: ["reviews.admission.v1"] },
    { argv: ["models", "withdraw", "gpt", "--project", "proj", "--reason", "retired"], required: ["reviews.admission.v1"] },
    { argv: ["models", "reviewers", "--project", "proj"], required: ["reviews.admission.v1"] },
    { argv: ["revert", "t1", "--project", "proj"], required: COMMAND_CAPABILITIES.revert },
    { argv: ["claim", "t1", "--project", "proj"], required: COMMAND_CAPABILITIES.claim },
    { argv: ["start", "t1", "--project", "proj"], required: COMMAND_CAPABILITIES.start },
    { argv: ["wrap", "summary"], required: COMMAND_CAPABILITIES.wrap },
    { argv: ["models", "note", "gpt", "a note"], required: ["models.note.v1"] },
    { argv: ["models", "show", "gpt"], required: ["models.note.v1"] },
    { argv: ["review", "t1", "--approve", "--criteria", BINDING, "--project", "proj"], required: COMMAND_CAPABILITIES.review },
    { argv: ["review-claim", "t1", "--project", "proj"], required: COMMAND_CAPABILITIES["review-claim"] },
    { argv: ["review-unparsable", "t1", "--head", SHA, "--note", "n", "--reply-file", reply, "--project", "proj"], required: COMMAND_CAPABILITIES["review-unparsable"] },
    { argv: ["token", "issue", "--as", "codex/x"], required: ["runners.scoped-token.v1"] },
    { argv: ["token", "store", "--runner", "home:x"], required: ["runners.scoped-token.v1"] },
    { argv: ["board", "--project", "proj"], required: COMMAND_CAPABILITIES.board },
    { argv: ["criteria-review", "t1", "--project", "proj"], required: COMMAND_CAPABILITIES["criteria-review"] },
  ];
}

test("a server missing one capability a command needs refuses it before its first request, naming the capability", async (t) => {
  const argvDir = mkdtempSync(join(tmpdir(), "atelier-capabilities-argv-"));
  t.after(() => rmSync(argvDir, { recursive: true, force: true }));
  for (const { argv, required } of invocations(argvDir)) {
    for (const missing of required) {
      const f = await stub(t, { commit: "0123456789abcdef", routeLevel: ROUTE_LEVEL, capabilities: SERVER_CAPABILITIES.filter((n) => n !== missing) });
      const r = await f.run(argv);
      assert.equal(r.status, 1, `${argv.join(" ")} without ${missing}: ${r.output}`);
      assert.match(r.output, new RegExp(`^atelier: the server \\(main at 01234567\\) lacks capabilities ${missing.replaceAll(".", "\\.")}: it publishes .*Deploy the server from a checkout that declares them \\(npm run deploy, which records the commit it deploys\\), then run atelier ${argv[0]} again\\n$`), `${argv.join(" ")} without ${missing}`);
      assert.deepEqual(f.requests, [{ method: "GET", path: "/api/version" }], `${argv.join(" ")} without ${missing} made a request beyond the version`);
    }
  }
});

test("a server with every capability a command needs, or more, lets its first request through", async (t) => {
  const extra = { commit: "0123456789abcdef", routeLevel: ROUTE_LEVEL, capabilities: [...SERVER_CAPABILITIES, "future.thing.v1"] };
  for (const argv of [["new", "A short title", "--project", "proj"], ["models", "note", "gpt", "a note"], ["review-claim", "t1", "--project", "proj"], ["token", "issue", "--as", "codex/x"], ["board", "--project", "proj"]]) {
    const f = await stub(t, extra);
    const r = await f.run(argv);
    assert.doesNotMatch(r.output, /lacks capabilities/, argv.join(" "));
    assert.equal(f.requests[0].path, "/api/version", argv.join(" "));
    assert.ok(f.requests.length > 1, `${argv.join(" ")} made no request after the version: ${r.output}`);
  }
  // A legacy server at this CLI's level is read through the level.
  const legacy = await stub(t, { commit: "0123456789abcdef", routeLevel: ROUTE_LEVEL });
  const r = await legacy.run(["models", "note", "gpt", "a note"]);
  assert.doesNotMatch(r.output, /lacks capabilities/);
  assert.deepEqual(legacy.requests.map((x) => x.path), ["/api/version", "/api/models/gpt/notes"]);
  // A legacy server behind the capability is refused through the level.
  const behind = await stub(t, { commit: "0123456789abcdef", routeLevel: 17 });
  const b = await behind.run(["models", "note", "gpt", "a note"]);
  assert.equal(b.status, 1);
  assert.match(b.output, /lacks capabilities models\.note\.v1: it reports only route level 17/);
  assert.deepEqual(behind.requests.map((x) => x.path), ["/api/version"]);
});

test("new asks only for the brief and criteria, and --area is refused by the CLI before any request (t769)", async (t) => {
  assert.deepEqual(requiredForCommand("new"), ["items.brief-criteria.v1"]);
  assert.deepEqual(requiredForCommand("new", undefined, { area: "a1" }), COMMAND_CAPABILITIES.new);
  for (const version of [{ capabilities: ["items.brief-criteria.v1"] }, { routeLevel: 15 }]) {
    const f = await stub(t, version);
    const allowed = await f.run(["new", "Title", "--project", "proj"]);
    assert.equal(allowed.status, 0, allowed.output);
    assert.ok(f.requests.some((r) => r.method === "POST" && r.path === "/api/projects/proj/items"));
    f.requests.length = 0;
    const refused = await f.run(["new", "Title", "--area", "a1", "--project", "proj"]);
    assert.equal(refused.status, 1, refused.output);
    assert.match(refused.output, /does not take --area/);
    assert.deepEqual(f.requests, []);
  }
});

test("a subcommand with no capabilities asks nothing and runs against a server that lacks its siblings'", async (t) => {
  const f = await stub(t, { commit: "0123456789abcdef", capabilities: [] });
  for (const argv of [["models"], ["models", "add", "gpt", "--harness", "codex", "--where", "cloud"]]) {
    const r = await f.run(argv);
    assert.doesNotMatch(r.output, /lacks capabilities/, argv.join(" "));
  }
  assert.deepEqual(f.requests.map((x) => x.path), ["/api/models", "/api/models/gpt"]);
});

test("an unavailable or malformed version answer refuses with its own message and code", async (t) => {
  const down = await stub(t, { error: "unavailable" }, { status: 503 });
  const r = await down.run(["new", "A short title", "--project", "proj"]);
  assert.equal(r.status, 4, r.output);
  assert.match(r.output, /^atelier: the server did not answer GET \/api\/version with a version, so its capabilities \(items\.brief-criteria\.v1\) cannot be checked\. Check that the server is reachable and deployed\./);
  assert.deepEqual(down.requests.map((x) => x.path), ["/api/version"]);
  const text = await stub(t, "<html>not json</html>");
  const n = await text.run(["new", "A short title", "--project", "proj"]);
  assert.equal(n.status, 4, n.output);
  assert.match(n.output, /did not answer GET \/api\/version with a version/);
  for (const [version, message] of [[{ commit: "c0ffee" }, /reports neither capabilities nor a route level/], [{ capabilities: "items.brief-criteria.v1" }, /capabilities that are not a list/], [{ routeLevel: "20" }, /route level that is not a non-negative integer/]]) {
    const f = await stub(t, version);
    const m = await f.run(["new", "A short title", "--project", "proj"]);
    assert.equal(m.status, 1, m.output);
    assert.match(m.output, message);
    assert.deepEqual(f.requests.map((x) => x.path), ["/api/version"], JSON.stringify(version));
  }
});

test("help, --help and --version of a command that declares capabilities contact no server", async (t) => {
  const f = await stub(t, { capabilities: [] });
  for (const argv of [["help"], ["new", "--help"], ["models", "note", "--help"], ["land", "--version"], ["token", "issue", "-h"]]) {
    const r = await f.run(argv);
    assert.equal(r.status, 0, `${argv.join(" ")}: ${r.output}`);
  }
  const rename = await f.run(["init", "--rename-local", "--name", "renamed"]);
  assert.doesNotMatch(rename.output, /capabilities|GET \/api\/version/);
  // A flag the command does not take is refused before the server is asked.
  const bad = await f.run(["new", "A title", "--bogus"]);
  assert.equal(bad.status, 1);
  assert.match(bad.output, /new does not take --bogus/);
  assert.deepEqual(f.requests, []);
});


test("post-merge audits require a named capability without raising the frozen route level", () => {
  const capability = "reviews.post-merge.v1";
  assert.equal(ROUTE_LEVEL, 29);
  assert.deepEqual(requiredForCommand("review-request"), [capability]);
  assert.ok(requiredForJobs(["review"]).includes(capability));
  assert.equal(CAPABILITIES.find((c) => c.name === capability).level, undefined);
  assert.equal(checkCapabilities({ routeLevel: ROUTE_LEVEL + 100 }, [capability]).ok, false);
  assert.equal(checkCapabilities({ capabilities: SERVER_CAPABILITIES }, [capability]).ok, true);
});

// t629: the developer's direction (--quote with the acting model) lets the
// developer token alone switch to fast mode or override a missing review, on
// a server that publishes projects.developer-direction.v1. The live server
// (dd7ebfe8) does not until it is deployed again, so --quote asks for the
// capability, and a server without it is refused before any request, naming
// the Settings page and the task page as the way until then. Without --quote
// nothing more is asked, so the page's permission keeps working there.
test("--quote asks for the developer's direction by name, and a server without it names the pages as the way until then (t629)", async (t) => {
  const DIRECTION = "projects.developer-direction.v1";
  assert.deepEqual(requiredForCommand("mode", "fast", { reason: "r" }), ["projects.mode.v1"]);
  assert.deepEqual(requiredForCommand("mode", "fast", { reason: "r", quote: "go" }), ["projects.mode.v1", DIRECTION]);
  assert.deepEqual(requiredForCommand("mode", "full", { quote: "go" }), ["projects.mode.v1", DIRECTION]);
  assert.deepEqual(requiredForCommand("accept", "t1", { "override-review": "r" }), []);
  assert.deepEqual(requiredForCommand("accept", "t1", { "override-review": "r", quote: "go" }), [DIRECTION]);
  assert.ok(!requiredForCommand("merge", "t1", { head: SHA, "override-review": "r" }).includes(DIRECTION));
  assert.ok(requiredForCommand("merge", "t1", { head: SHA, "override-review": "r", quote: "go" }).includes(DIRECTION));
  const without = { commit: "dd7ebfe8aaaaaaaa", routeLevel: ROUTE_LEVEL, capabilities: SERVER_CAPABILITIES.filter((n) => n !== DIRECTION) };
  for (const argv of [
    ["mode", "fast", "--reason", "forks fail", "--quote", "go fast", "--project", "proj"],
    ["accept", "t1", "--override-review", "no reviewer", "--quote", "override it", "--project", "proj"],
    ["merge", "t1", "--head", SHA, "--override-review", "no reviewer", "--quote", "override it", "--project", "proj"],
  ]) {
    const f = await stub(t, without);
    const r = await f.run(argv);
    assert.equal(r.status, 1, `${argv.join(" ")}: ${r.output}`);
    assert.match(r.output, /lacks capabilities projects\.developer-direction\.v1/, argv.join(" "));
    assert.match(r.output, /Until then, the developer gives the permission on the project's Settings page \(Allow fast mode from the command line\) or the task's page \(Allow an override from the command line\), and the command runs again without --quote/, argv.join(" "));
    assert.deepEqual(f.requests, [{ method: "GET", path: "/api/version" }], argv.join(" "));
  }
});

// t621: the comparison route is published by name without raising the route
// level, and `models show` requires no more than before: it prints the
// comparison when the server publishes models.compare.v1 and says so when not.
test("models.compare.v1 is a named capability that models show reads without requiring (t621)", () => {
  assert.equal(CAPABILITIES.find((c) => c.name === "models.compare.v1")?.level, undefined);
  assert.ok(SERVER_CAPABILITIES.includes("models.compare.v1"));
  assert.equal(ROUTE_LEVEL, 29);
  assert.deepEqual(requiredForCommand("models", "show"), ["models.note.v1"]);
});

// t623: the trend route is published by name without raising the route
// level, and `models show` requires no more than before: --trend asks for
// models.trend.v1 itself and refuses a server without it.
test("models.trend.v1 is a named capability that models show --trend reads without requiring (t623)", () => {
  assert.equal(CAPABILITIES.find((c) => c.name === "models.trend.v1")?.level, undefined);
  assert.ok(SERVER_CAPABILITIES.includes("models.trend.v1"));
  assert.equal(ROUTE_LEVEL, 29);
  assert.deepEqual(requiredForCommand("models", "show", { trend: true }), ["models.note.v1"]);
});
