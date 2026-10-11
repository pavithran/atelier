import { CAPABILITY_DECLARATIONS } from "./capability-declarations.ts";
import type { CommandModule } from "./usage/command.ts";
import { COMMAND_MODULES } from "./usage/commands/index.ts";

// Named capabilities (t458), which replace the one number as what a command
// or runner job asks of the server. A capability names one behaviour of the
// API a client may rely on; the server publishes the names it supports
// beside routeLevel (GET /api/version), and each command and job declares
// the names it needs and checks them before its first dependent operation:
// a command in its module, src/usage/commands/NAME.ts (`capabilities`, and
// a subcommand's own), which cli/atelier.mjs reads before the handler runs
// (requireCapabilities); a runner job in JOB_CAPABILITIES below, which the
// runner checks for the jobs it offers before its first poll. A command that
// declares none, and every form of help and --version, asks nothing, so the
// offline commands stay usable with no server at all.
//
// A name is `family.behaviour.vN`. Once published a name keeps its meaning:
// a change that is not compatible with it takes a new name (…v2), and the
// old one stays published for as long as the server still behaves that way,
// so a client that needs v1 is not satisfied by a server that has only v2.
// Each capability is one line in src/capability-declarations.ts. Its
// merge=union attribute retains independent additions, including names in
// the same family. Duplicate names still fail validation after a merge.
// buildCapabilities refuses a name declared twice, or one that
// is not well formed, when this module loads, and commandCapabilities
// refuses a command that requires a name no declaration publishes.
//
// Migration: until every server publishes capabilities, a server that
// reports only routeLevel is read through `level` on the declarations: level
// N guarantees exactly the capabilities declared with level <= N, which is
// the documented guarantee of each raise (the integration routes at 6, in
// the commits named there, and each raise from 14 on below), and nothing
// else. A capability with no level (one added after this migration) is not
// guaranteed by any legacy level, so a legacy server is refused for it.
// ROUTE_LEVEL and its merge arithmetic (atelier land) stay until no
// supported server reports a level without capabilities; docs/landing.md
// says when.
export type CapabilityDeclaration = { name: string; summary: string; level?: number };

const CAPABILITY_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+\.v[1-9][0-9]*$/;

export function buildCapabilities<const T extends readonly CapabilityDeclaration[]>(declarations: T): Readonly<T> {
  const seen = new Set<string>();
  for (const { name, level } of declarations) {
    if (typeof name !== "string" || !CAPABILITY_NAME.test(name)) throw new Error(`capability name ${JSON.stringify(name)} is not family.behaviour.vN`);
    if (seen.has(name)) throw new Error(`capability ${name} is declared twice`);
    if (level !== undefined && !Number.isInteger(level)) throw new Error(`capability ${name} has a level that is not an integer`);
    seen.add(name);
  }
  return Object.freeze(declarations);
}

// Add one declaration with the level the change raises ROUTE_LEVEL to
// during migration, or level: undefined afterward. Keep names as literal
// types so undeclared requirements also fail typechecking.
// Level 6 guarantees both sides of integration: plans.integration.v1 for
// integrators and plans.refresh.v1 for owners (32d5755 and 933d198).
export const CAPABILITIES = buildCapabilities(CAPABILITY_DECLARATIONS);

// Every published name, as a type: a command module's `capabilities` holds these.
export type CapabilityName = (typeof CAPABILITIES)[number]["name"];

// What the server publishes in GET /api/version.
export const SERVER_CAPABILITIES: readonly string[] = CAPABILITIES.map((c) => c.name);

// What each command needs, read from the command modules: the command's own
// `capabilities` and, under its subcommands' words, each subcommand's. A
// module that requires a name no declaration above publishes fails here,
// naming the module. The runner command is absent: it needs the union of its
// jobs' (JOB_CAPABILITIES), checked in cli/runner.mjs for the jobs it offers,
// and `runner setup`, --discover and --usage need no server.
export type CommandCapabilities = Readonly<Record<string, { own: readonly string[]; subcommands: Readonly<Record<string, readonly string[]>> }>>;
export function commandCapabilities(modules: readonly CommandModule[], published: ReadonlySet<string> = new Set(SERVER_CAPABILITIES)): CommandCapabilities {
  const out: Record<string, { own: readonly string[]; subcommands: Record<string, readonly string[]> }> = {};
  for (const { path, spec } of modules) {
    const checked = (names: readonly string[] | undefined, where: string): readonly string[] => {
      for (const name of names ?? []) if (!published.has(name)) throw new Error(`${path}: ${where} requires capability ${name}, which src/route-level.ts does not declare`);
      return Object.freeze([...new Set(names ?? [])]);
    };
    const own = checked(spec.capabilities, `atelier ${spec.name}`);
    const subcommands: Record<string, readonly string[]> = {};
    for (const [word, sub] of Object.entries(spec.subcommands ?? {})) {
      const names = checked(sub.capabilities, `atelier ${spec.name} ${word}`);
      if (names.length) subcommands[word] = names;
    }
    if (own.length || Object.keys(subcommands).length) out[spec.name] = { own, subcommands };
  }
  return out;
}
const DECLARED = commandCapabilities(COMMAND_MODULES);

// Everything a command may need, its subcommands' included; atelier land
// checks its own list again where it runs (cli/land.mjs). A command absent
// here needs nothing.
export const COMMAND_CAPABILITIES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(DECLARED).map(([name, d]) => [name, [...new Set([...d.own, ...Object.values(d.subcommands).flat()])]]),
);

// What one run of a command needs: its own capabilities and, when the word
// after the command names a subcommand that declares some, that
// subcommand's. `atelier models` lists the pool on any server; `atelier
// models note` needs models.note.v1.
// new declares area support, but only requires it when --area is supplied.
export function requiredForCommand(command: string, word?: string, flags: Readonly<Record<string, unknown>> = {}): string[] {
  const d = DECLARED[command];
  if (!d) return [];
  const sub = word !== undefined && Object.hasOwn(d.subcommands, word) ? d.subcommands[word] : [];
  return [...new Set([...d.own, ...sub])].filter((name) =>
    command !== "new" || name !== "areas.manage.v1" || flags.area !== undefined,
  );
}

// What each runner job needs. A job absent here runs without asking. Every
// job claims the task and reaches Git through the runner's own credential
// (runners.scoped-token.v1); the build and plan jobs read a brief that
// carries the criteria; the review job posts the binding, keeps an
// unparsable reply and reports a review it will not serve as the job's
// actor (reviews.skip.v1, reviews.skip-as-runner.v1); the integrate and
// refresh jobs post the integration routes (plans.integration.v1). Every
// job but the review reports one it gives up to run-skip (runners.run-skip.v1,
// t420); the queue's why poll, which the same capability names, is only
// read for the idle message, so the review job does not require it.
export const JOB_CAPABILITIES: Readonly<Record<string, readonly CapabilityName[]>> = {
  build: ["projects.commit-identity.v1", "items.brief-criteria.v1", "runners.scoped-token.v1", "runners.run-skip.v1"],
  plan: ["projects.commit-identity.v1", "items.brief-criteria.v1", "runners.scoped-token.v1", "runners.run-skip.v1"],
  "merge-main": ["projects.commit-identity.v1", "runners.scoped-token.v1", "runners.run-skip.v1"],
  "merge-main-task": ["projects.commit-identity.v1", "runners.scoped-token.v1", "runners.run-skip.v1"],
  "merge-plan": ["projects.commit-identity.v1", "runners.scoped-token.v1", "runners.run-skip.v1"],
  review: ["projects.commit-identity.v1", "reviews.criteria-binding.v1", "reviews.lease.v1", "reviews.unparsable.v1", "reviews.skip.v1", "reviews.skip-as-runner.v1", "runners.scoped-token.v1"],
  integrate: ["projects.commit-identity.v1", "plans.integration.v1", "runners.scoped-token.v1", "runners.run-skip.v1"],
  refresh: ["projects.commit-identity.v1", "plans.integration.v1", "runners.scoped-token.v1", "runners.run-skip.v1"],
};

export const requiredForJobs = (jobs: readonly string[]): string[] => [...new Set(jobs.flatMap((job) => JOB_CAPABILITIES[job] ?? []))];

// The capabilities a legacy route level guarantees, and no more.
export const capabilitiesForLevel = (level: number): string[] => CAPABILITIES.filter((c) => c.level !== undefined && c.level <= level).map((c) => c.name);

export type CapabilityFailure = "unavailable" | "malformed" | "missing" | "unmapped";
export type CapabilityCheck = { ok: true; via: "capabilities" | "legacy" } | { ok: false; kind: CapabilityFailure; missing: string[]; message: string };

// Whether a server's answer to GET /api/version (null when it gave none)
// supports every capability in `required`. Extra capabilities are accepted.
// Failures are told apart: unavailable (no usable answer), malformed
// (capabilities or routeLevel of the wrong shape, or neither present),
// missing (short of the requirement), unmapped (a legacy server asked for a
// capability no legacy level guarantees). The message names the missing set,
// the server's revision and the remedy; a caller adds what to run again.
export function checkCapabilities(version: unknown, required: readonly string[]): CapabilityCheck {
  const v = version !== null && typeof version === "object" && !Array.isArray(version) ? version as Record<string, unknown> : null;
  const commit = typeof v?.commit === "string" && v.commit ? v.commit.slice(0, 8) : null;
  const revision = commit ? `main at ${commit}` : "an unrecorded revision";
  const remedy = "Deploy the server from a checkout that declares them (npm run deploy, which records the commit it deploys)";
  const fail = (kind: CapabilityFailure, missing: string[], message: string): CapabilityCheck => ({ ok: false, kind, missing, message });
  if (!v) return fail("unavailable", [...required], `the server did not answer GET /api/version with a version, so its capabilities (${required.join(", ") || "none"}) cannot be checked. Check that the server is reachable and deployed. ${remedy}`);
  let have: Set<string>, via: "capabilities" | "legacy";
  if ("capabilities" in v) {
    const list = v.capabilities;
    if (!Array.isArray(list) || list.some((n) => typeof n !== "string" || !CAPABILITY_NAME.test(n))) return fail("malformed", [], `the server (${revision}) reports capabilities that are not a list of family.behaviour.vN names. ${remedy}`);
    have = new Set(list as string[]); via = "capabilities";
  } else if (v.routeLevel !== undefined) {
    if (!Number.isInteger(v.routeLevel) || (v.routeLevel as number) < 0) return fail("malformed", [], `the server (${revision}) reports a route level that is not a non-negative integer. ${remedy}`);
    have = new Set(capabilitiesForLevel(v.routeLevel as number)); via = "legacy";
  } else {
    return fail("malformed", [], `the server (${revision}) reports neither capabilities nor a route level. ${remedy}`);
  }
  const missing = required.filter((n) => !have.has(n));
  if (!missing.length) return { ok: true, via };
  const unmapped = via === "legacy" ? missing.filter((n) => !CAPABILITIES.some((c) => c.name === n && c.level !== undefined)) : [];
  const what = via === "legacy" ? `reports only route level ${v.routeLevel}, which guarantees ${[...have].join(", ") || "none"}` : `publishes ${[...have].join(", ") || "none"}`;
  return fail(unmapped.length ? "unmapped" : "missing", missing, `the server (${revision}) lacks capabilities ${missing.join(", ")}: it ${what}. ${remedy}`);
}

// The server's route level, one integer the server and the CLI share by
// importing this module. GET /api/version reports it beside the deployed
// commit, and a CLI from before capabilities (above) refuses when the
// server's level is lower than its own, since it may be calling a route the
// server does not have, or one whose meaning the server has changed. Raise
// it by one, and only then, when a change makes the CLI start calling a
// route the server did not have, or changes the meaning of an existing route
// the CLI relies on; a merge that changes neither changes nothing here,
// whatever commit it moves to. Two tasks that each raise it from one base
// merge cleanly to the number they share; atelier land, wherever the
// workspace's HEAD holds main — its own merge or a rerun of one resolved
// by hand — compares this file at the task's fork point, its head and
// main's head, and raises the merged level to main's plus the task's own
// raise for legacy files. With named declarations, landing instead refuses
// automatic arithmetic until the builder resolves the legacy mappings.
// The number still gates legacy clients: each raise declares the capability
// it stands for in src/capability-declarations.ts with its guaranteed level;
// test/capabilities.test.mjs fails a raise that declares none, or a
// declaration with a level this number has not reached. 14: the
// landing-workflow routes, behind atelier land --workflow (t280). 15: items
// take a brief and acceptance criteria apart from the short title, and edit
// takes a title (t315). 16: a review names the binding of the acceptance
// criteria it judged and may name the request it claimed, the review claim
// gives both, and edit says what a change of criteria withdrew (t326).
// 17: the review-unparsable route, which the runner's review job calls to
// keep a reply no verdict could be read from on the task (t407).
// 18: the owner keeps dated notes under a pool model, atelier models note
// (t406).
// 19: a project that requires criteria refuses a task filed or cleared
// without them, and init takes --require-criteria (t397).
// 20: runner-scoped API credentials and revocable Git gateway (t444).
// 21: a runner reports a review it will not serve to review-skip, the
// queue's review tasks and the review request's answer name the request's
// number, and the landing counts skips by it (t353). 22: a runner token
// posts review-skip for a review job it was offered, under the job's actor,
// as the runner has done since runner tokens (t444); a server at 21 refused
// it, so a runner's skip never reached the landing (t353).
// 23: function areas, task assignments and the shared board snapshot (t456).
// 24: a project's policy carries its commit identity, which every claim,
// runner and landing reads, and init takes commitName, commitEmail,
// agentEmails, privateEmails and publicMirrors (t451).
// 25: the owner admits, withdraws and lists outside reviewers (PUT, DELETE
// and GET /projects/:p/reviewers), which an older server answers 404 (t492).

// 26: review-renew and five-minute leases; release and verdicts name the
// exact request generation, and expired requests are reoffered (t351).
// 27: durable owner-approved post-merge steps and recovery (t477,
// land.post-merge.v1).
// 28: the ledger takes the land step triage and its binding, so atelier land
// records a triage, a --no-triage bypass and an --override-triage (t475,
// land.triage.v1).
// 29: a runner reports a build or plan job it gives up to run-skip, and its
// poll asks the queue `why` dispatches wait (t420, runners.run-skip.v1).
export const ROUTE_LEVEL = 29;
