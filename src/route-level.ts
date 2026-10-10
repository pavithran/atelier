// The server's route level, one integer the server and the CLI share by
// importing this module. GET /api/version reports it beside the deployed
// commit, and atelier land and the home runner refuse when the server's
// level is lower than this one, since the CLI may be calling a route the
// server does not have, or one whose meaning the server has changed. Raise
// it by one, and only then, when a change makes the CLI start calling a
// route the server did not have, or changes the meaning of an existing route
// the CLI relies on; a merge that changes neither changes nothing here,
// whatever commit it moves to. Two tasks that each raise it from one base
// merge cleanly to the number they share; atelier land, wherever the
// workspace's HEAD holds main — its own merge or a rerun of one resolved
// by hand — compares this file at the task's fork point, its head and
// main's head, and raises the merged level to main's plus the task's own
// raise, so each number keeps meaning one set of routes. 14: the
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
// Runner-scoped API credentials and revocable Git gateway (t444).
export const ROUTE_LEVEL = 20;

// Named capabilities (t458), which replace the one number as what a command
// or runner job asks of the server. A capability names one behaviour of the
// API a client may rely on; the server publishes the names it supports
// beside routeLevel (GET /api/version), and each command and job declares
// the names it needs and checks them before its first dependent operation.
// Offline commands (help, version) declare none and never ask.
//
// A name is `family.behaviour.vN`. Once published a name keeps its meaning:
// a change that is not compatible with it takes a new name (…v2), and the
// old one stays published for as long as the server still behaves that way,
// so a client that needs v1 is not satisfied by a server that has only v2.
// Each capability is declared on its own, below, so two tasks that add one
// each touch different lines and merge cleanly; buildCapabilities refuses a
// name declared twice, or one that is not well formed, when this module loads.
//
// Migration: until every server publishes capabilities, a server that
// reports only routeLevel is read through `level` on the declarations: level
// N guarantees exactly the capabilities declared with level <= N, which is
// the documented guarantee of each raise above (14 to 20), and nothing else.
// A capability with no level (one added after this migration) is not
// guaranteed by any legacy level, so a legacy server is refused for it.
// ROUTE_LEVEL and its merge arithmetic (atelier land) stay until no
// supported server reports a level without capabilities; docs/landing.md
// says when.
export type CapabilityDeclaration = { name: string; summary: string; level?: number };

const CAPABILITY_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+\.v[1-9][0-9]*$/;

export function buildCapabilities(declarations: readonly CapabilityDeclaration[]): readonly CapabilityDeclaration[] {
  const seen = new Set<string>();
  for (const { name, level } of declarations) {
    if (typeof name !== "string" || !CAPABILITY_NAME.test(name)) throw new Error(`capability name ${JSON.stringify(name)} is not family.behaviour.vN`);
    if (seen.has(name)) throw new Error(`capability ${name} is declared twice`);
    if (level !== undefined && !Number.isInteger(level)) throw new Error(`capability ${name} has a level that is not an integer`);
    seen.add(name);
  }
  return Object.freeze([...declarations]);
}

const landWorkflow: CapabilityDeclaration = { name: "land.workflow.v1", level: 14, summary: "the landing-workflow routes behind atelier land --workflow" };
const itemsBriefCriteria: CapabilityDeclaration = { name: "items.brief-criteria.v1", level: 15, summary: "items take a brief and acceptance criteria apart from the title; edit takes a title" };
const reviewsBinding: CapabilityDeclaration = { name: "reviews.criteria-binding.v1", level: 16, summary: "a review names the binding of the criteria it judged and the request it claimed" };
const reviewUnparsable: CapabilityDeclaration = { name: "reviews.unparsable.v1", level: 17, summary: "the review-unparsable route a runner's review job calls" };
const modelsNote: CapabilityDeclaration = { name: "models.note.v1", level: 18, summary: "dated owner notes under a pool model" };
const requireCriteria: CapabilityDeclaration = { name: "projects.require-criteria.v1", level: 19, summary: "a project that requires criteria refuses a task filed or cleared without them" };
const runnerScopedToken: CapabilityDeclaration = { name: "runners.scoped-token.v1", level: 20, summary: "runner-scoped API credentials and the revocable Git gateway" };

export const CAPABILITIES = buildCapabilities([landWorkflow, itemsBriefCriteria, reviewsBinding, reviewUnparsable, modelsNote, requireCriteria, runnerScopedToken]);

// What the server publishes in GET /api/version.
export const SERVER_CAPABILITIES: readonly string[] = CAPABILITIES.map((c) => c.name);

// What each command and runner job needs. A command or job absent here, or
// listed with none, runs without asking the server for a revision.
export const COMMAND_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  land: [landWorkflow.name, itemsBriefCriteria.name, reviewsBinding.name, requireCriteria.name],
};
export const JOB_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  build: [itemsBriefCriteria.name, runnerScopedToken.name],
  plan: [itemsBriefCriteria.name, runnerScopedToken.name],
  "merge-main": [runnerScopedToken.name],
  "merge-main-task": [runnerScopedToken.name],
  "merge-plan": [runnerScopedToken.name],
  review: [reviewsBinding.name, reviewUnparsable.name, runnerScopedToken.name],
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
