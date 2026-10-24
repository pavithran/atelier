import { parseRunner } from "./dispatch/rules.ts";
import { RuleError, validActor } from "./rules.ts";

export interface AgentToken {
  id: string;
  hash: string;
  actor: string;
  runner?: string;
  projects?: string[];
  createdAt: string;
  expiresAt: string;
  label?: string;
  revokedAt?: string;
}

// A browser session, as the index Durable Object stores it: the SHA-256 of
// the random id the cookie carries, and when it ends.
export interface BrowserSession {
  hash: string;
  createdAt: string;
  expiresAt: string;
}

export function tokenFromBytes(bytes: Uint8Array): string {
  if (bytes.length < 32) throw new Error("a token needs at least 32 random bytes");
  return "atl_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function tokenOptions(input: Record<string, unknown>, owner: string, now: number) {
  if (input.runner !== undefined && typeof input.runner !== "string") throw new RuleError("bad_runner", "runner must be a name", 400);
  const runner = input.runner === undefined ? null : parseRunner(String(input.runner).includes(":") ? String(input.runner) : `home:${input.runner}`);
  const actor = runner ? `runner/${runner.runner.split(":")[1]}` : input.actor;
  if (runner && (input.actor !== undefined || !Array.isArray(input.projects) || !input.projects.length)) {
    throw new RuleError("bad_runner_token", "a runner token needs at least one project and no actor", 400);
  }
  if (typeof actor !== "string" || !validActor(actor) || !/^[^/]+\/[^/]+$/.test(actor) || actor === owner) {
    throw new RuleError("bad_actor", "an agent token needs harness/model and cannot name the developer", 400);
  }
  const days = input.days === undefined ? 30 : input.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365) {
    throw new RuleError("bad_expiry", "days must be an integer from 1 to 365", 400);
  }
  const projects = input.projects;
  if (projects !== undefined && (!Array.isArray(projects) || projects.some((p) => typeof p !== "string" || !p.trim() || p !== p.trim() || p.includes("/")))) {
    throw new RuleError("bad_projects", "projects must be a list of project names", 400);
  }
  if (input.label !== undefined && (typeof input.label !== "string" || input.label.length > 200)) {
    throw new RuleError("bad_label", "label must be text of at most 200 characters", 400);
  }
  return { actor, ...(runner ? { runner: runner.runner } : {}), ...(projects !== undefined ? { projects: [...new Set(projects as string[])] } : {}),
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + days * 86400000).toISOString(),
    ...(input.label !== undefined ? { label: input.label as string } : {}) };
}

export function tokenActive(token: AgentToken, now: number): boolean {
  return !token.revokedAt && Date.parse(token.expiresAt) > now;
}

// A token limited to projects lists them by the names they had when it was
// issued; a project answers to every name it has had, so any of them counts.
export function inScope(token: Pick<AgentToken, "projects"> | undefined, names: string[]): boolean {
  return token?.projects === undefined || names.some((n) => token.projects!.includes(n));
}

// Only the agent's workflow is allowed. Unknown routes stay owner-only.
// POST items/tN/plan is the planner posting its plan document, and GET
// items/tN/job-brief is the holder reading the brief of the work it holds;
// the Ledger takes each only from the holder of the item's claim. Every
// other plan route is the owner's.
export function agentRoute(method: string, parts: string[], body: Record<string, unknown> = {}): boolean {
  const [root, project, section, id, verb] = parts;
  if (parts.length === 1) return method === "GET" && ["config", "inbox", "projects", "queue"].includes(root) || root === "queue" && method === "POST";
  if (root !== "projects" || !project) return false;
  if (parts.length === 2) return method === "GET";
  if (parts.length === 3) {
    // baseline-head reveals only a commit hash, which the read token an
    // agent may mint already exposes; status and unwrap read it.
    // decisions are the owner's standing decisions, which every agent of
    // the project is to know (src/decisions.ts); only the owner writes them.
    // areas stays readable so that an older CLI's agent gets the 410 the route
    // answers (t769) and not a 403.
    if (method === "GET") return ["owners", "standing", "items", "baseline-head", "decisions", "board", "areas", "refreshes"].includes(section);
    return section === "baseline-token" && method === "POST" && body.scope !== "write";
  }
  if (section !== "items" || !id) return false;
  // criteria-reviews reads where a task's criteria review stands, and
  // criteria-review-claim, criteria-review and criteria-review-failed are the
  // criteria reviewer's claim, verdict and failure (t438); asking for one
  // and resolving its findings stay the owner's.
  if (method === "GET") return parts.length === 4 || parts.length === 5 && ["brief", "diff", "job-brief", "criteria-reviews"].includes(verb) || parts.length === 6 && ["logs", "diffs"].includes(verb);
  return method === "POST" && parts.length === 5 && ["claim", "fast-take", "fast-ready", "read-token", "base-token", "push", "evidence", "review", "review-claim", "review-renew", "review-release", "review-unparsable", "criteria-review-claim", "criteria-review", "criteria-review-failed", "submit", "handoff", "release", "plan", "integrated", "integration-failed", "refreshed", "refresh-failed", "refresh-lease", "refresh-pushing", "refresh-checked", "block", "unblock"].includes(verb);
}

// A separate allowlist: runner credentials never inherit an agent's review,
// integration, handoff or owner privileges. review-skip is a runner's own
// word, not a review: it says the runner will not serve a review job it was
// offered (t353), and the gateway takes it only for such a job, as it takes
// a run report (assertRunnerReport). run-skip is its word that it gives up a
// build or plan job it was offered (t420), taken the same way. fast-take and
// fast-ready (t589) are fast mode's claim without a fork and the report of
// the commit it built, judged as a claim and the holder's calls are.
const RUNNER_ITEM = "projects/:project/items/:id";

// The authoritative method/path inventory. Body restrictions remain below;
// adding a route here also requires an answer in the shared runner test server.
export const RUNNER_ROUTES: readonly { method: string; pattern: string }[] = [
  { method: "GET", pattern: "config" },
  { method: "GET", pattern: "runners/me" },
  { method: "POST", pattern: "queue" },
  { method: "POST", pattern: "runs" },
  { method: "GET", pattern: "projects/:project" },
  { method: "GET", pattern: "projects/:project/decisions" },
  { method: "GET", pattern: "projects/:project/baseline-head" },
  { method: "POST", pattern: "projects/:project/baseline-token" },
  { method: "GET", pattern: RUNNER_ITEM },
  ...["brief", "job-brief", "diff"].map(verb => ({ method: "GET", pattern: `${RUNNER_ITEM}/${verb}` })),
  ...["logs", "diffs"].map(verb => ({ method: "GET", pattern: `${RUNNER_ITEM}/${verb}/*` })),
  ...["claim", "read-token", "base-token", "push", "evidence", "submit", "plan", "release", "review-skip", "run-skip", "fast-take", "fast-ready"]
    .map(verb => ({ method: "POST", pattern: `${RUNNER_ITEM}/${verb}` })),
];

export function runnerRoute(method: string, parts: string[], body: Record<string, unknown> = {}): boolean {
  const allowed = RUNNER_ROUTES.some(route => {
    const pattern = route.pattern.split("/");
    return route.method === method && pattern.length === parts.length && pattern.every((part, i) =>
      part === ":project" ? !!parts[i] : part === ":id" ? /^t[0-9]+$/.test(parts[i]) : part === "*" || part === parts[i]);
  });
  if (!allowed) return false;
  if (body.scope === "write" && (parts.length === 3 && parts[2] === "baseline-token" || ["read-token", "base-token"].includes(parts[4]))) return false;
  return true;
}

export function runnerDenied(token: AgentToken): RuleError {
  return new RuleError("runner_forbidden", `runner ${token.runner} (token ${token.id}) is not authorized for this operation`, 403);
}

// Every HTTP call the home runner makes against the server, declared once
// (t478): its method, its path, the body fields it may send and the kind of
// credential it goes with. The runner's own calls (`via: "runner"`) go
// through runnerTransport in cli/runner.mjs, which refuses a name not
// declared here and a body field the call does not declare; the calls an
// atelier command makes for the runner (`via: "cli"`: claim, finish and the
// rest, which the runner spawns as children) go through request() in
// cli/atelier.mjs, and runRunner spawns no command this table does not
// name. test/runner-routes.test.mjs holds one authorization case for each
// name, exercised through the real gateway and Ledger, and a source check
// that finds a call made outside the transport or a name not declared;
// test/runner-routes-helpers.test.mjs reads the spawned commands and the
// helpers they import, and fails one that calls an undeclared route, sends
// an undeclared field, bypasses the CLI's transport or calls a route its
// credential kind may not.
//
// The credential kinds are kept apart on purpose: a `runner` call is made
// with the runner's own token (cli/credentials.mjs), which runnerRoute above
// must allow; an `agent` call is made with a model's own agent token (a
// review job records its verdict as the reviewer, t346) or the integrator's
// (`--integrate` runs the integrate and refresh jobs under the reserved
// actor's token), which agentRoute must allow and runnerRoute refuses; a
// `public` call needs no token at all. An `owner` call is one a spawned
// command makes only under the developer's own token (atelier push
// --owner-port, which no runner passes): runnerRoute and agentRoute both
// refuse it, so a runner or agent token that sent it would be turned away at
// the gateway, and the helper transport refuses it to a runner token before
// it is sent. `integrator: true` marks a runner
// call the integrate and refresh jobs make too, under the integrator's
// token. `jobs` says which jobs make the call.
//
// A `preflight` call is made by every atelier command the runner spawns,
// before the command's handler runs: the capability check (t458,
// requireCapabilities in cli/atelier.mjs) reads the server's version through
// serverVersion, which builds its URL from this declaration. It is public,
// so it carries no token and names no command;
// test/runner-routes-helpers.test.mjs fails a fetch in serverVersion that
// does not go to a declared preflight call.
export type CallCredential = "runner" | "agent" | "public" | "owner";
export type RunnerJob = "build" | "plan" | "review" | "criteria-review" | "integrate" | "refresh" | "task-refresh" | "task-resolve";
export interface RunnerCall {
  name: string;
  method: "GET" | "POST";
  // A path under /api, with {project} and {item} standing for the
  // encoded path parameters (callPath).
  path: string;
  credential: CallCredential;
  // "none" for a call that sends no X-Atelier-Actor: the config read, which
  // asks the token who it is. The gateway refuses an agent token whose
  // declared actor is not its own (actor_mismatch, 403), so a runner under
  // an agent token (docs/runners.md) must name none; a runner token answers
  // with its runner whatever actor is named, and the owner's token with
  // neither. Every other call names the actor it is sent as.
  actor?: "none";
  // The body fields a POST may carry; "document" when the body is a whole
  // plan document rather than fields; [] for no body, as every GET.
  body: readonly string[] | "document";
  via: "runner" | "cli" | "preflight";
  // The atelier command that makes a `cli` call.
  command?: string;
  jobs: readonly RunnerJob[];
  integrator?: true;
}

const ITEM = "/projects/{project}/items/{item}";
const PLAN: readonly RunnerJob[] = ["plan"], REVIEW: readonly RunnerJob[] = ["review"];
const INTEGRATE: readonly RunnerJob[] = ["integrate", "refresh"];
const CRITERIA: readonly RunnerJob[] = ["criteria-review"];
// The task refresh (t462) runs as the integrator, under its token.
const TASK_REFRESH: readonly RunnerJob[] = ["task-refresh", "task-resolve"];

export const RUNNER_CALLS: readonly RunnerCall[] = [
  // The runner's own calls, before and between jobs.
  { name: "version", method: "GET", path: "/version", credential: "public", body: [], via: "runner", jobs: [] },
  // The capability check every spawned command makes first (t458).
  { name: "capabilities", method: "GET", path: "/version", credential: "public", body: [], via: "preflight", jobs: ["build", "plan", "review", "criteria-review", "integrate", "refresh", "task-refresh", "task-resolve"], integrator: true },
  // The runner's identity, read once before its first poll: a runner
  // token's runner, an agent token's actor, neither for the owner's. It
  // names no actor, as the CLI's own resolveTokenActor names none.
  { name: "config", method: "GET", path: "/config", credential: "runner", actor: "none", body: [], via: "runner", jobs: [] },
  // The runner's own token (t212): its runner name, the projects it serves
  // and when it expires, read once at start so the runner offers and polls
  // only the projects its config and the token both name. Only a runner
  // token is answered; the runner skips the read on a server that lacks
  // runners.me.v1, so an older server keeps working.
  { name: "runner-me", method: "GET", path: "/runners/me", credential: "runner", actor: "none", body: [], via: "runner", jobs: [] },
  // The poll: what the runner can run and when it started (t420), answered
  // with the tasks it may claim. GET /queue is the owner's listing, which
  // runnerRoute refuses a runner token (test/runner-routes.test.mjs).
  { name: "queue", method: "POST", path: "/queue", credential: "runner", body: ["runner", "kind", "jobs", "agents", "started", "projects", "readiness"], via: "runner", jobs: [] },
  // The same poll asked with `why` (t420), when a poll offered nothing: the
  // server answers the listing GET gives, cut to the token's projects, each
  // waiting dispatch with why it is not being taken. The same route, the
  // same credential, a body field more: declared apart so the idle path is
  // its own authorization case.
  { name: "queue-why", method: "POST", path: "/queue", credential: "runner", body: ["runner", "kind", "jobs", "agents", "started", "why", "projects", "readiness"], via: "runner", jobs: [] },
  // A busy runner's heartbeat (t537): its offer marked as one, which renews
  // its last poll while a job runs and is offered nothing back.
  { name: "queue-heartbeat", method: "POST", path: "/queue", credential: "runner", body: ["runner", "kind", "jobs", "agents", "started", "heartbeat", "projects", "readiness"], via: "runner", jobs: [] },
  // The baseline's head, for a post-merge review the runner keeps waiting on
  // a merge commit no source held (t591).
  { name: "baseline-head", method: "GET", path: "/projects/{project}/baseline-head", credential: "runner", body: [], via: "runner", jobs: REVIEW },
  { name: "runs", method: "POST", path: "/runs", credential: "runner", body: ["actor", "role", "outcome", "project", "item", "detail"], via: "runner", jobs: ["build", "plan", "review"] },
  { name: "review-skip", method: "POST", path: `${ITEM}/review-skip`, credential: "runner", body: ["head", "request", "note"], via: "runner", jobs: REVIEW },
  // The runner's word that it gives up a build or plan job under its
  // dispatch (t420), after failed runs or infrastructure failures in a row:
  // taken as a run report for the job is, under the job's actor. The actor
  // in the body is read under the owner's token alone; a runner token's
  // report is the header's actor, checked at the gateway.
  { name: "run-skip", method: "POST", path: `${ITEM}/run-skip`, credential: "runner", body: ["actor", "role", "kind", "failures", "note"], via: "runner", jobs: ["build", "plan"] },
  // The project's record, read for its preparation policy (t378) before a
  // build whose last run left a validation marker.
  { name: "project", method: "GET", path: "/projects/{project}", credential: "runner", body: [], via: "runner", jobs: ["build"] },
  // The plan job's own calls: the brief it reads, the document it posts. A
  // part reads its brief the same way, as a build.
  { name: "job-brief", method: "GET", path: `${ITEM}/job-brief`, credential: "runner", body: [], via: "runner", jobs: ["build", "plan"] },
  { name: "plan", method: "POST", path: `${ITEM}/plan`, credential: "runner", body: "document", via: "runner", jobs: PLAN },
  // The build and plan jobs' helpers: the atelier commands the runner spawns.
  { name: "claim", method: "POST", path: `${ITEM}/claim`, credential: "runner", body: [], via: "cli", command: "claim", jobs: ["build", "plan", "integrate", "refresh"], integrator: true },
  // The claim reads the project's preparation policy (t378) into the
  // workspace's Git config.
  { name: "claim-project", method: "GET", path: "/projects/{project}", credential: "runner", body: [], via: "cli", command: "claim", jobs: ["build", "plan", "integrate", "refresh"], integrator: true },
  { name: "release", method: "POST", path: `${ITEM}/release`, credential: "runner", body: ["note"], via: "cli", command: "release", jobs: ["build", "plan", "integrate", "refresh"], integrator: true },
  // A release that reports a provider limit is sent by the runner itself
  // (leaseCall), so shutdown can give it a deadline of its own.
  { name: "release-provider-limit", method: "POST", path: `${ITEM}/release`, credential: "runner", body: ["providerLimit", "note"], via: "runner", jobs: ["build", "plan", "integrate", "refresh"], integrator: true },
  { name: "item", method: "GET", path: ITEM, credential: "runner", body: [], via: "cli", command: "finish", jobs: ["build", "integrate", "refresh"], integrator: true },
  { name: "push", method: "POST", path: `${ITEM}/push`, credential: "runner", body: ["head", "rebasedFrom"], via: "cli", command: "push", jobs: ["build", "integrate", "refresh"], integrator: true },
  // The developer's push of a released task's fork from their own checkout
  // (atelier push --owner-port, t571). The runner never passes the flag;
  // it is declared because the push command makes the call.
  { name: "owner-port-token", method: "POST", path: `${ITEM}/owner-port-token`, credential: "owner", body: [], via: "cli", command: "push", jobs: [] },
  { name: "read-token", method: "POST", path: `${ITEM}/read-token`, credential: "runner", body: [], via: "cli", command: "read-token", jobs: ["build", "integrate"], integrator: true },
  { name: "base-token", method: "POST", path: `${ITEM}/base-token`, credential: "runner", body: ["scope"], via: "cli", command: "base-token", jobs: ["build", "refresh"], integrator: true },
  // The build job's merge of main before it submits (t435) reads the project's
  // baseline: a read token and the regenerate command, never a write scope.
  { name: "baseline-token", method: "POST", path: "/projects/{project}/baseline-token", credential: "runner", body: ["scope"], via: "cli", command: "baseline-token", jobs: ["build"] },
  // The same command reads the project's regenerate command from its record.
  { name: "baseline-project", method: "GET", path: "/projects/{project}", credential: "runner", body: [], via: "cli", command: "baseline-token", jobs: ["build"] },
  { name: "evidence", method: "POST", path: `${ITEM}/evidence`, credential: "runner", body: ["kind", "claim", "head", "passed", "changedPaths", "outputTail", "failureLines", "merged", "mainHead", "notApplicable", "load", "reuse"], via: "cli", command: "check", jobs: ["build", "integrate", "refresh"], integrator: true },
  // Fast mode (t589): a build taken without a fork, and the report of the
  // commit it built. atelier fast take also reads the baseline it clones.
  { name: "fast-take", method: "POST", path: `${ITEM}/fast-take`, credential: "runner", body: [], via: "cli", command: "fast", jobs: ["build"] },
  { name: "fast-ready", method: "POST", path: `${ITEM}/fast-ready`, credential: "runner", body: ["commit", "base", "builder", "workspace"], via: "cli", command: "fast", jobs: ["build"] },
  { name: "submit", method: "POST", path: `${ITEM}/submit`, credential: "runner", body: ["summary"], via: "cli", command: "submit", jobs: ["build", "integrate", "refresh"], integrator: true },
  // The review job's helpers, under the reviewer's own agent token.
  { name: "review-claim", method: "POST", path: `${ITEM}/review-claim`, credential: "agent", body: [], via: "cli", command: "review-claim", jobs: REVIEW },
  // A hand-served claim is renewed by atelier review-claim --renew (t575),
  // with the request number alone; the runner renews with leaseCall.
  { name: "review-claim-renew", method: "POST", path: `${ITEM}/review-renew`, credential: "agent", body: ["request"], via: "cli", command: "review-claim", jobs: REVIEW },
  { name: "review-release", method: "POST", path: `${ITEM}/review-release`, credential: "agent", body: ["note", "request"], via: "cli", command: "review-release", jobs: REVIEW },
  { name: "review-unparsable", method: "POST", path: `${ITEM}/review-unparsable`, credential: "agent", body: ["head", "note", "reply"], via: "cli", command: "review-unparsable", jobs: REVIEW },
  // The review lease (t351): a claim with a request number is renewed, and
  // released or kept as unparsable, by the runner itself (leaseCall in
  // cli/runner.mjs), under the reviewer's agent token, so shutdown can give
  // each its own deadline.
  { name: "review-renew", method: "POST", path: `${ITEM}/review-renew`, credential: "agent", body: ["request", "note"], via: "runner", jobs: REVIEW },
  { name: "review-release-lease", method: "POST", path: `${ITEM}/review-release`, credential: "agent", body: ["request", "note"], via: "runner", jobs: REVIEW },
  { name: "review-unparsable-lease", method: "POST", path: `${ITEM}/review-unparsable`, credential: "agent", body: ["request", "note", "head", "reply"], via: "runner", jobs: REVIEW },
  // The criteria review job (t438), under the reviewer's own agent token:
  // the claim, the verdict (atelier criteria-verdict) and the failure.
  { name: "criteria-review-claim", method: "POST", path: `${ITEM}/criteria-review-claim`, credential: "agent", body: [], via: "cli", command: "criteria-review-claim", jobs: CRITERIA },
  { name: "criteria-review", method: "POST", path: `${ITEM}/criteria-review`, credential: "agent", body: ["approve", "rev", "criteria", "request", "note", "findings", "checks"], via: "cli", command: "criteria-verdict", jobs: CRITERIA },
  { name: "criteria-review-failed", method: "POST", path: `${ITEM}/criteria-review-failed`, credential: "agent", body: ["request", "note"], via: "cli", command: "criteria-review-failed", jobs: CRITERIA },
  { name: "review", method: "POST", path: `${ITEM}/review`, credential: "agent", body: ["head", "criteria", "request", "approve", "note", "findings"], via: "cli", command: "review", jobs: REVIEW },
  // The integrate and refresh jobs' own helpers, under the integrator's token.
  { name: "integrated", method: "POST", path: `${ITEM}/integrated`, credential: "agent", body: ["part", "mergeCommit"], via: "cli", command: "integrated", jobs: ["integrate"] },
  { name: "integration-failed", method: "POST", path: `${ITEM}/integration-failed`, credential: "agent", body: ["part", "reason", "kind"], via: "cli", command: "integration-failed", jobs: ["integrate"] },
  { name: "refreshed", method: "POST", path: `${ITEM}/refreshed`, credential: "agent", body: ["mainHead", "mergeCommit", "lease", "expectedHead", "head", "diffBefore", "diffAfter", "transformations"], via: "cli", command: "refreshed", jobs: ["refresh", ...TASK_REFRESH] },
  { name: "refresh-failed", method: "POST", path: `${ITEM}/refresh-failed`, credential: "agent", body: ["mainHead", "reason", "kind", "lease", "expectedHead", "outcome", "report"], via: "cli", command: "refresh-failed", jobs: [...INTEGRATE, ...TASK_REFRESH] },
  // The task refresh's lease (t462): taken, renewed, read and given back; the
  // push announced before it is made; the checks reported at the head it
  // recorded.
  { name: "refresh-lease", method: "POST", path: `${ITEM}/refresh-lease`, credential: "agent", body: ["job", "runner", "renew", "release", "status", "reason", "providerLimit"], via: "cli", command: "refresh-lease", jobs: TASK_REFRESH },
  { name: "refresh-pushing", method: "POST", path: `${ITEM}/refresh-pushing`, credential: "agent", body: ["lease", "mainHead", "expectedHead", "head"], via: "cli", command: "refresh-pushing", jobs: TASK_REFRESH },
  { name: "refresh-checked", method: "POST", path: `${ITEM}/refresh-checked`, credential: "agent", body: ["lease", "mainHead", "expectedHead", "passed", "reason"], via: "cli", command: "refresh-checked", jobs: TASK_REFRESH },
];

// The declared call under `name`, or an error naming it: a call nobody
// declared is made nowhere.
export function declaredCall(name: string): RunnerCall {
  const call = RUNNER_CALLS.find((c) => c.name === name);
  if (!call) throw new Error(`${name} is not a call the runner declares (RUNNER_CALLS in src/tokens.ts)`);
  return call;
}

// The atelier commands the runner spawns for its `cli` calls.
export const RUNNER_COMMANDS: ReadonlySet<string> = new Set(RUNNER_CALLS.flatMap((c) => c.command ? [c.command] : []));

// Resolve the legacy CLI transport's method/path to a named declaration
// before it sends anything. Helpers share reads and finish composes other
// commands, so the boundary is the declared CLI operations, not command
// ownership. Exact segment matching rejects queries and extra path segments.
export function declaredHelperCall(method: string, path: string, body: unknown, runnerOnly = false): RunnerCall {
  const parts = path.split("/");
  const call = RUNNER_CALLS.find((c) => {
    if (c.via !== "cli" && c.name !== "config") return false;
    if (runnerOnly && c.credential !== "runner") return false;
    const pattern = c.path.split("/");
    return c.method === method && pattern.length === parts.length && pattern.every((part, i) =>
      /^\{\w+\}$/.test(part) ? !!parts[i] && !/[?#]/.test(parts[i]) : part === parts[i]);
  });
  if (!call) throw new Error(`${method} ${path} is not a call the runner helpers declare (RUNNER_CALLS in src/tokens.ts)`);
  if (method === "GET") {
    if (body !== undefined) throw new Error(`${call.name} is a GET and sends no body`);
  } else {
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error(`${call.name} sends an object`);
    const fields = call.body;
    const undeclared = Object.keys(body).filter((key) => fields === "document" || !fields.includes(key));
    if (undeclared.length) throw new Error(`${call.name} does not send ${undeclared.join(", ")}`);
    if (runnerOnly && "scope" in body && body.scope !== "read") throw new Error(`${call.name} only requests read scope for a runner`);
  }
  return call;
}

// A declared call's path under /api with its parameters filled in, each
// encoded as a path segment; a parameter the path names and the caller
// leaves out is an error, never an empty segment.
export function callPath(call: RunnerCall, params: Record<string, string> = {}): string {
  return call.path.replace(/\{(project|item)\}/g, (_, key: string) => {
    const value = params[key];
    if (typeof value !== "string" || !value) throw new Error(`${call.name} needs ${key}`);
    return encodeURIComponent(value);
  });
}

// The path's segments as the gateway splits them, for runnerRoute and
// agentRoute: the declared path with sample parameters.
export function callParts(call: RunnerCall, params: Record<string, string> = { project: "p", item: "t1" }): string[] {
  return callPath(call, params).split("/").filter(Boolean).map((s) => decodeURIComponent(s));
}

// Dedicated CLI exits carry the exact state through nested finish steps.
// Neither accepted, integrated nor blocked means the task is terminal.
export const TERMINAL_TASK_EXITS = { merged: 5, abandoned: 6 } as const;

export function runnerTaskTerminal(id: string, state: keyof typeof TERMINAL_TASK_EXITS): RuleError {
  return new RuleError("task_terminal", `${id} is ${state === "abandoned" ? "closed" : state} (state: ${state})`, 409);
}

// The exit a CLI command ends with when the server's answer is task_terminal:
// the exact state's exit, read back from the detail runnerTaskTerminal wrote,
// so claim, push and every step of finish carry the state to the runner. Null
// for any other answer, which keeps its own exit (1, or 3 for a refused claim).
export function terminalTaskExit(answer: { error?: unknown; detail?: unknown }): number | null {
  if (answer.error !== "task_terminal") return null;
  const state = /\(state: ([a-z]+)\)$/.exec(String(answer.detail ?? ""))?.[1];
  return state && Object.hasOwn(TERMINAL_TASK_EXITS, state) ? TERMINAL_TASK_EXITS[state as keyof typeof TERMINAL_TASK_EXITS] : null;
}
