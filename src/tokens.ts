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
  if (runner && (input.actor !== undefined || !Array.isArray(input.projects) || input.projects.length !== 1)) {
    throw new RuleError("bad_runner_token", "a runner token needs exactly one project and no actor", 400);
  }
  if (typeof actor !== "string" || !validActor(actor) || !/^[^/]+\/[^/]+$/.test(actor) || actor === owner) {
    throw new RuleError("bad_actor", "an agent token needs harness/model and cannot name the project owner", 400);
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
    if (method === "GET") return ["owners", "standing", "items", "baseline-head", "decisions", "board", "areas"].includes(section);
    return section === "baseline-token" && method === "POST" && body.scope !== "write";
  }
  if (section !== "items" || !id) return false;
  if (method === "GET") return parts.length === 4 || parts.length === 5 && ["brief", "diff", "job-brief"].includes(verb) || parts.length === 6 && ["sandbox", "logs", "diffs"].includes(verb);
  return method === "POST" && parts.length === 5 && ["claim", "read-token", "base-token", "push", "evidence", "sandbox", "review", "review-claim", "review-release", "review-unparsable", "submit", "handoff", "release", "plan", "integrated", "integration-failed", "refreshed", "refresh-failed", "block", "unblock"].includes(verb);
}

// A separate allowlist: runner credentials never inherit an agent's review,
// integration, handoff or owner privileges. review-skip is a runner's own
// word, not a review: it says the runner will not serve a review job it was
// offered (t353), and the gateway takes it only for such a job, as it takes
// a run report (assertRunnerReport).
export function runnerRoute(method: string, parts: string[], body: Record<string, unknown> = {}): boolean {
  if (parts.length === 1) return method === "GET" && parts[0] === "config" || method === "POST" && ["queue", "runs"].includes(parts[0]);
  if (parts[0] !== "projects" || !parts[1]) return false;
  if (parts.length === 2) return method === "GET";
  if (parts.length === 3) return method === "GET" && ["decisions", "baseline-head"].includes(parts[2]) || method === "POST" && parts[2] === "baseline-token" && body.scope !== "write";
  if (parts[2] !== "items" || !/^t[0-9]+$/.test(parts[3])) return false;
  if (["read-token", "base-token"].includes(parts[4]) && body.scope === "write") return false;
  if (method === "GET") return parts.length === 4 || parts.length === 5 && ["brief", "job-brief", "diff"].includes(parts[4]) || parts.length === 6 && ["sandbox", "logs", "diffs"].includes(parts[4]);
  return method === "POST" && parts.length === 5 && ["claim", "read-token", "base-token", "push", "evidence", "sandbox", "submit", "plan", "release", "review-skip"].includes(parts[4]);
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
// `public` call needs no token at all. `integrator: true` marks a runner
// call the integrate and refresh jobs make too, under the integrator's
// token. `jobs` says which jobs make the call.
export type CallCredential = "runner" | "agent" | "public";
export type RunnerJob = "build" | "plan" | "review" | "integrate" | "refresh";
export interface RunnerCall {
  name: string;
  method: "GET" | "POST";
  // A path under /api, with {project}, {item} and {run} standing for the
  // encoded path parameters (callPath).
  path: string;
  credential: CallCredential;
  // The body fields a POST may carry; "document" when the body is a whole
  // plan document rather than fields; [] for no body, as every GET.
  body: readonly string[] | "document";
  via: "runner" | "cli";
  // The atelier command that makes a `cli` call.
  command?: string;
  jobs: readonly RunnerJob[];
  integrator?: true;
}

const ITEM = "/projects/{project}/items/{item}";
const PLAN: readonly RunnerJob[] = ["plan"], REVIEW: readonly RunnerJob[] = ["review"];
const INTEGRATE: readonly RunnerJob[] = ["integrate", "refresh"];

export const RUNNER_CALLS: readonly RunnerCall[] = [
  // The runner's own calls, before and between jobs.
  { name: "version", method: "GET", path: "/version", credential: "public", body: [], via: "runner", jobs: [] },
  { name: "config", method: "GET", path: "/config", credential: "runner", body: [], via: "runner", jobs: [] },
  { name: "queue", method: "POST", path: "/queue", credential: "runner", body: ["runner", "kind", "jobs", "agents"], via: "runner", jobs: [] },
  { name: "runs", method: "POST", path: "/runs", credential: "runner", body: ["actor", "role", "outcome", "project", "item", "detail"], via: "runner", jobs: ["build", "plan", "review"] },
  { name: "review-skip", method: "POST", path: `${ITEM}/review-skip`, credential: "runner", body: ["head", "request", "note"], via: "runner", jobs: REVIEW },
  // The plan job's own calls: the brief it reads, the document it posts. A
  // part reads its brief the same way, as a build.
  { name: "job-brief", method: "GET", path: `${ITEM}/job-brief`, credential: "runner", body: [], via: "runner", jobs: ["build", "plan"] },
  { name: "plan", method: "POST", path: `${ITEM}/plan`, credential: "runner", body: "document", via: "runner", jobs: PLAN },
  // The build and plan jobs' helpers: the atelier commands the runner spawns.
  { name: "claim", method: "POST", path: `${ITEM}/claim`, credential: "runner", body: [], via: "cli", command: "claim", jobs: ["build", "plan", "integrate", "refresh"], integrator: true },
  { name: "release", method: "POST", path: `${ITEM}/release`, credential: "runner", body: ["note"], via: "cli", command: "release", jobs: ["build", "plan", "integrate", "refresh"], integrator: true },
  { name: "item", method: "GET", path: ITEM, credential: "runner", body: [], via: "cli", command: "finish", jobs: ["build", "integrate", "refresh"], integrator: true },
  { name: "push", method: "POST", path: `${ITEM}/push`, credential: "runner", body: ["head", "rebasedFrom"], via: "cli", command: "push", jobs: ["build", "integrate", "refresh"], integrator: true },
  { name: "read-token", method: "POST", path: `${ITEM}/read-token`, credential: "runner", body: [], via: "cli", command: "read-token", jobs: ["build", "integrate"], integrator: true },
  { name: "base-token", method: "POST", path: `${ITEM}/base-token`, credential: "runner", body: ["scope"], via: "cli", command: "base-token", jobs: ["build", "refresh"], integrator: true },
  { name: "evidence", method: "POST", path: `${ITEM}/evidence`, credential: "runner", body: ["kind", "claim", "head", "passed", "changedPaths", "outputTail", "merged", "mainHead", "notApplicable", "load"], via: "cli", command: "check", jobs: ["build", "integrate", "refresh"], integrator: true },
  { name: "sandbox", method: "POST", path: `${ITEM}/sandbox`, credential: "runner", body: ["merged"], via: "cli", command: "check", jobs: ["build", "integrate", "refresh"], integrator: true },
  { name: "sandbox-run", method: "GET", path: `${ITEM}/sandbox/{run}`, credential: "runner", body: [], via: "cli", command: "check", jobs: ["build", "integrate", "refresh"], integrator: true },
  { name: "submit", method: "POST", path: `${ITEM}/submit`, credential: "runner", body: ["summary"], via: "cli", command: "submit", jobs: ["build", "integrate", "refresh"], integrator: true },
  // The review job's helpers, under the reviewer's own agent token.
  { name: "review-claim", method: "POST", path: `${ITEM}/review-claim`, credential: "agent", body: [], via: "cli", command: "review-claim", jobs: REVIEW },
  { name: "review-release", method: "POST", path: `${ITEM}/review-release`, credential: "agent", body: ["note"], via: "cli", command: "review-release", jobs: REVIEW },
  { name: "review-unparsable", method: "POST", path: `${ITEM}/review-unparsable`, credential: "agent", body: ["head", "note", "reply"], via: "cli", command: "review-unparsable", jobs: REVIEW },
  { name: "review", method: "POST", path: `${ITEM}/review`, credential: "agent", body: ["head", "criteria", "request", "approve", "note", "findings"], via: "cli", command: "review", jobs: REVIEW },
  // The integrate and refresh jobs' own helpers, under the integrator's token.
  { name: "integrated", method: "POST", path: `${ITEM}/integrated`, credential: "agent", body: ["part", "mergeCommit"], via: "cli", command: "integrated", jobs: ["integrate"] },
  { name: "integration-failed", method: "POST", path: `${ITEM}/integration-failed`, credential: "agent", body: ["part", "reason", "kind"], via: "cli", command: "integration-failed", jobs: ["integrate"] },
  { name: "refreshed", method: "POST", path: `${ITEM}/refreshed`, credential: "agent", body: ["mainHead", "mergeCommit"], via: "cli", command: "refreshed", jobs: ["refresh"] },
  { name: "refresh-failed", method: "POST", path: `${ITEM}/refresh-failed`, credential: "agent", body: ["mainHead", "reason", "kind"], via: "cli", command: "refresh-failed", jobs: INTEGRATE },
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

// A declared call's path under /api with its parameters filled in, each
// encoded as a path segment; a parameter the path names and the caller
// leaves out is an error, never an empty segment.
export function callPath(call: RunnerCall, params: Record<string, string> = {}): string {
  return call.path.replace(/\{(project|item|run)\}/g, (_, key: string) => {
    const value = params[key];
    if (typeof value !== "string" || !value) throw new Error(`${call.name} needs ${key}`);
    return encodeURIComponent(value);
  });
}

// The path's segments as the gateway splits them, for runnerRoute and
// agentRoute: the declared path with sample parameters.
export function callParts(call: RunnerCall, params: Record<string, string> = { project: "p", item: "t1", run: "p:t1:abc:1" }): string[] {
  return callPath(call, params).split("/").filter(Boolean).map((s) => decodeURIComponent(s));
}
