import { familyOf, type PoolFamily } from "./models/pool.ts";
import { MODEL_PROFILES } from "./models/registry.ts";
import type { Dispatch } from "./dispatch/rules";
import type { CheckDeclaration } from "./checks.ts";
// Atelier's rules, as pure functions. Nothing here touches Cloudflare, so the
// whole policy can be tested with `node --test` and read in one place.

export type ItemState = "open" | "claimed" | "submitted" | "accepted" | "merged" | "abandoned" | "blocked";

export interface Item {
  id: string;
  title: string;
  scope: string[];          // globs the item intends to touch
  state: ItemState;
  owner: string | null;     // actor, e.g. "claude-code/opus-5.5"; null when unowned
  fork: string | null;      // Artifacts repo name of the item's workspace
  base: string | null;      // baseline commit the fork started from
  head: string | null;      // last head Atelier verified in the fork
  acceptedHead: string | null;
  pushActors?: string[];     // holders and recorded push contributors
  createdAt: string;
  updatedAt: string;
  lastPushAt: string | null;
  dispatch?: Dispatch | null; // set while the task waits for a runner; kept as the record once claimed
  runner?: string | null;     // the runner that holds the claim, if a runner claimed it
  reviewOverride?: ReviewOverride | null; // the owner's latest override; it counts only at the head it names
  // The owner's framing of the task, from ControlPlane's work item: what the
  // task is not to do, what tells its holder to stop and ask, and the gate it
  // goes to next. Each is optional; the brief and the task page show them.
  nonGoals?: string[];
  stopWhen?: string[];
  nextGate?: string | null;
  blocked?: Block | null;   // set while the task is blocked; it keeps its owner and fork meanwhile
  // A plan, or a part of one (docs/orchestrator.md). An ordinary task
  // carries none of these four fields.
  kind?: "plan" | "part";
  plan?: string;            // a part's plan item, tP
  partKey?: string;         // a part's key in the approved plan
  deps?: string[];          // the keys of the parts a part depends on
}

// Why a task is blocked, who blocked it, when, and the state it was in,
// which `unblock` returns it to. The holder or the project owner records
// it; while it stands the task is skipped by dispatch and stuck detection,
// cannot be pushed, submitted, reviewed, handed off or released, and sits
// in the owner's inbox with the reason.
export interface Block {
  reason: string;
  by: string;
  at: string;
  from: ItemState;
}

// What `atelier new` and `atelier edit` set. A field present replaces the
// item's value; one absent keeps it. An empty list or a null gate clears.
export interface ItemFields {
  nonGoals?: string[];
  stopWhen?: string[];
  nextGate?: string | null;
}

// Whether two items belong to one plan: two parts of it, or a part and the
// plan item. The plan item stands for all its parts' work, and validation
// lets parts share paths only when one depends on the other, so overlap
// between them is ordered by the plan already.
export function samePlan(a: Pick<Item, "id" | "kind" | "plan">, b: Pick<Item, "id" | "kind" | "plan">): boolean {
  const planOf = (i: Pick<Item, "id" | "kind" | "plan">) => (i.kind === "plan" ? i.id : i.kind === "part" ? i.plan ?? null : null);
  const pa = planOf(a);
  return pa !== null && pa === planOf(b);
}

// The project owner's override of the independent review a change needs,
// for when no reviewer qualifies. It is not a review: it approves nothing,
// it is recorded as an event of its own (review.overridden) with a required
// reason, and the gate counts it in place of the missing review only at the
// head it names. The owner records it while accepting (Ledger.accept).
export interface ReviewOverride {
  head: string;
  by: string;
  reason: string;
  at: string;
}

// Observed: Atelier ran it itself, in a clean clone, at the exact head.
// Reported: an agent said so; nobody has checked.
// Pending: a required check that has no observed result at the current head.
export type Grade = "observed" | "reported" | "pending";

export interface Evidence {
  itemId: string;
  claim: string;            // a required check's command, or a free-text report
  grade: Exclude<Grade, "pending">;
  head: string;
  passed: boolean | null;   // null for reports
  by: string;
  at: string;
  changedPaths?: string[] | null;  // observed checks record what the item actually changes
  outputTail?: string;
  // Where an observed check ran: "sandbox" is a Cloudflare container started by
  // the Worker; "runner" is Atelier's CLI on the caller's machine. Only the
  // Worker's own code can record "sandbox"; anything posted to the API is "runner".
  where?: "sandbox" | "runner";
  // Main's head when an observed check was recorded, read by the Worker from
  // Artifacts. A merged check ran on the merge of `head` with that commit
  // rather than on `head` alone, so it is bound to both revisions: it is
  // stale once main moves on, and it never satisfies a required check at the
  // head, which the head's own run does.
  mainHead?: string;
  merged?: boolean;
  // An observed record that the check does not apply at this head: its paths
  // match none of the changed paths Atelier measured. It carries no result.
  notApplicable?: boolean;
}

// One finding of an automatic review, as parseVerdict (src/review/verdict.ts)
// reads it from the reviewer's reply. `blocking` is a correctness, security
// or data loss fault, which holds a change back; `follow-up` never does. A
// review may carry findings even when it approves, as the follow-ups.
export interface Finding {
  file: string;
  line: number | null;
  severity: "blocking" | "follow-up";
  text: string;
}

export interface Review {
  itemId: string;
  by: string;
  head: string;
  approve: boolean;
  note: string;
  at: string;
  findings?: Finding[];
}

export type ChangeClass = "direct" | "coordinated" | "protected";
export type AgentRole = "assessor" | "consultant" | "designer" | "executor" | "planner" | "reconciler";
export interface AgentPolicy {
  available: boolean;
  eligible_roles: AgentRole[];
  preferred_roles?: AgentRole[];
}
export interface ExecutionPolicy {
  allowed_classes: ChangeClass[];
  direct: { enabled: boolean; allowed_path_patterns: string[] };
  protected_path_patterns: string[];
}

// A check that applies only when an item changes a path its globs match.
export interface CheckPaths {
  command: string;
  paths: string[];
}

export interface ProjectPolicy {
  agents?: Record<string, AgentPolicy>;
  execution?: ExecutionPolicy;
  checks: string[];         // commands that must pass, observed, before acceptance
  checkClasses?: CheckDeclaration[];  // how each check is known to be read-only (src/checks.ts)
  checkPaths?: CheckPaths[];          // checks that apply only when the change touches these paths
  // The ship order as the policy records it (cli/ship.mjs shipPolicy, sent at
  // init and sync): the commands its runs execute, whose files changeClass
  // guards like a check's, and the approval kinds it needs, which the inbox
  // reads to say a merged revision is not delivered (src/actions.ts).
  shipRuns?: string[];
  shipKinds?: string[];
  protected: string[];      // globs whose changes need an independent assessor
  eligible?: string[];      // harness families allowed to act (e.g. "claude"); empty or absent means any
  refuseOverlap?: boolean;  // refuse a claim whose scope overlaps another live item
  approval?: string;
  sandboxOnly?: boolean;    // only checks observed in a Cloudflare sandbox count
}

// Reject malformed policy at the boundary instead of silently widening access.
export function parseAgents(value: unknown): Record<string, AgentPolicy> {
  const roles = ["assessor", "consultant", "designer", "executor", "planner", "reconciler"];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuleError("bad_policy", "agents must be an object", 400);
  const entries = Object.entries(value).map(([name, a]) => {
    if (!a || typeof a.available !== "boolean" || !Array.isArray(a.eligible_roles)
      || !a.eligible_roles.every((r: unknown) => typeof r === "string" && roles.includes(r))
      || (a.preferred_roles !== undefined && (!Array.isArray(a.preferred_roles) || !a.preferred_roles.every((r: unknown) => typeof r === "string" && roles.includes(r))))) {
      throw new RuleError("bad_policy", `invalid roles for agent ${name}`, 400);
    }
    return [name, { available: a.available, eligible_roles: a.eligible_roles, ...(a.preferred_roles ? { preferred_roles: a.preferred_roles } : {}) }];
  });
  return Object.fromEntries(entries);
}

export function parseExecution(value: unknown): ExecutionPolicy {
  const v = value as ExecutionPolicy | null;
  const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every((s) => typeof s === "string");
  if (!v || !strings(v.allowed_classes) || !v.allowed_classes.every((c) => ["direct", "coordinated", "protected"].includes(c))
    || !v.direct || typeof v.direct.enabled !== "boolean" || !strings(v.direct.allowed_path_patterns) || !strings(v.protected_path_patterns)) {
    throw new RuleError("bad_policy", "invalid execution policy", 400);
  }
  return { allowed_classes: [...v.allowed_classes], direct: { enabled: v.direct.enabled, allowed_path_patterns: [...v.direct.allowed_path_patterns] }, protected_path_patterns: [...v.protected_path_patterns] };
}

// The actor that stands for the project owner. A deployment names its own with
// OWNER_ACTOR; "owner" is the default.
export const DEFAULT_OWNER = "owner";

// The longest actor a task can be handed to, as harness/model. The actor
// pattern holds the same limit, so an over-long name is invalid wherever an
// actor is checked, and a handoff names the limit in its refusal.
export const ACTOR_MAX = 200;

// harness/model. A model may carry a ":profile" suffix, as the AI Studio's
// oMLX profile ids do; the harness may not, so a runner name (kind:name) and
// an actor never read alike.
const ACTOR = new RegExp(`^(?=.{1,${ACTOR_MAX}}$)[a-z0-9][a-z0-9._-]*(\\/[a-z0-9][a-z0-9._:-]*)?$`, "i");

export function validActor(actor: string): boolean {
  return ACTOR.test(actor);
}

// Holding a workspace permits plain Git pushes before Atelier observes a head.
// Keep every holder and push actor even after handoff or release.
export function pushActors(events: { actor: string; kind: string; data: Record<string, unknown> }[]): string[] {
  const actors = new Set<string>();
  let holder: string | null = null;
  for (const event of events) {
    if (event.kind === "item.claimed") holder = event.actor;
    if (event.kind === "item.handoff") {
      if (typeof event.data.from === "string") actors.add(event.data.from);
      holder = typeof event.data.to === "string" ? event.data.to : null;
    }
    if (event.kind === "item.released") holder = null;
    if (holder) actors.add(holder);
    // A push the queue saw is logged under atelier/events, which is no
    // contributor: it counts as the holder's. Seen while nobody holds the
    // item, it was made with a write token an earlier holder had before the
    // release revoked it, and every holder is listed already, so it adds no one.
    if (event.kind === "push.observed") {
      const by = event.actor === "atelier/events" ? holder : event.actor;
      if (by) actors.add(by);
    }
  }
  return [...actors];
}

export function assertHandoffTarget(actor: string, owner: string): void {
  if (!validActor(actor) || !actor.includes("/") || actor === owner) {
    throw new RuleError("bad_actor", "handoff needs harness/model and cannot name the project owner", 400);
  }
}

export function assertReviewAllowed(item: Item, proved: boolean): void {
  if (proved && item.state === "accepted") throw new RuleError("accepted", "only the owner token may reopen accepted work by reviewing", 403);
}

// "claude-code/opus-5.5" → "opus-5.5". The model, not the harness, is what
// makes a second opinion independent; the same model in another harness is not.
// This is the model as the actor spells it, for display; independence
// compares modelKey.
export function modelOf(actor: string): string {
  const slash = actor.indexOf("/");
  return slash === -1 ? actor : actor.slice(slash + 1);
}

// The model an actor runs, as review independence compares it. Letter case
// and a ":profile" suffix (the AI Studio's oMLX profiles) do not make another
// model, so the name is lowercased and cut at its first colon. A name the
// model registry knows, as a model's id or one of its aliases, becomes that
// model's id: "claude-code/Opus-5.5:fast" and "antigravity/claude-opus-5-5"
// both give "opus-5.5". A name the registry does not know is compared as it
// is after lowercasing and cutting.
const bareModel = (model: string) => model.toLowerCase().split(":")[0];
const REGISTERED = new Map(MODEL_PROFILES.flatMap((p) => [p.id, ...(p.aliases ?? [])].map((name) => [bareModel(name), bareModel(p.id)] as const)));

export function modelKey(actor: string): string {
  const model = bareModel(modelOf(actor));
  return REGISTERED.get(model) ?? model;
}

// Whether two actor names stand for one agent: the same harness, in any
// letter case, running the same model by modelKey. The same model in another
// harness is another agent, though not another model.
export function sameActor(a: string, b: string): boolean {
  const harness = (actor: string) => (actor.includes("/") ? actor.slice(0, actor.indexOf("/")).toLowerCase() : "");
  return harness(a) === harness(b) && modelKey(a) === modelKey(b);
}

// Everyone an item's work came from, as review independence counts them:
// every holder and push actor pushActors() recorded, and its current owner.
export function contributorsOf(item: { owner: string | null; pushActors?: readonly string[] }): string[] {
  return [...new Set([...(item.pushActors ?? []), ...(item.owner ? [item.owner] : [])])];
}

// The family independence compares: its model's, read from the model's name
// by modelKey, never from the harness, a profile suffix or a family an owner
// typed into the pool.
export const actorFamily = (actor: string): PoolFamily => familyOf(modelKey(actor));

// Null when `reviewer` is of a recognised family that no contributor shares;
// otherwise the rule it fails. A contributor of unrecognised family fails
// every reviewer, because no family can be shown to differ from one that is
// not recognised.
export function familyRefusal(reviewer: string, contributors: readonly string[]): string | null {
  const unknown = contributors.find((c) => actorFamily(c) === "other");
  if (unknown) return `contributor ${unknown}'s family is not recognised from its name`;
  const family = actorFamily(reviewer);
  if (family === "other") return "family not recognised from its name";
  const same = contributors.find((c) => actorFamily(c) === family);
  return same ? `same family as contributor ${same} (${family})` : null;
}

// Minimal glob: `**` crosses directories, `*` does not, everything else literal.
// Case-sensitive, as Git's paths are; `matchesFolded` is the matcher that is not.
// A newline is a path character like any other to Git, so `**` crosses one
// (the s flag), as `*` and `?` already do.
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "s");
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

// One spelling for every name that macOS's default disk (APFS, case-insensitive)
// treats as the same file. APFS compares names after canonical decomposition
// and full Unicode case folding, so `claude.md` is `CLAUDE.md`, a decomposed
// `café` is the precomposed one, and `AGENTſ.md` (long s), `ﬁle` (ligature) and
// `straße` are `AGENTS.md`, `file` and `strasse`. Lower, upper, then lower
// case again gives that folding in JavaScript: the middle step turns `ſ` into
// `S` and `ß` into `SS`, the first turns `ẞ` into `ß`. Final sigma (U+03C2) is
// the one lowercase mapping that depends on context, so it becomes plain sigma
// (U+03C3), as case folding does. This agrees with APFS for every code point
// that has a case mapping or a decomposition, except dotless `ı`, which this
// folds to `i` and APFS keeps apart: an error on the cautious side.
export function foldPath(path: string): string {
  return path.normalize("NFD").toLowerCase().toUpperCase().toLowerCase().replace(/\u03c2/g, "\u03c3").normalize("NFC");
}

// The matcher for the guarded set: protected globs, the default protected
// files and the files checks execute. On the owner's Mac a path that differs
// from a guarded one only by letter case or Unicode form is written to the
// guarded file, so it counts as guarded. A path matching as written always
// counts, so folding only ever adds to the set.
export function matchesFolded(path: string, globs: string[]): boolean {
  const folded = foldPath(path);
  return matchesAny(path, globs) || globs.some((g) => globToRegExp(foldPath(g)).test(folded));
}

// Groups of paths that Git keeps apart and macOS stores as one file, so a
// checkout on a Mac writes one over the other. The directories of each path
// are compared too. A group is reported where the clash arises: `Docs/a.md`
// and `docs/a.md` differ in a parent directory, and the group of `Docs` and
// `docs` names that already.
export function pathCollisions(paths: string[]): string[][] {
  const all = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    parts.forEach((_, i) => all.add(parts.slice(0, i + 1).join("/")));
  }
  const groups = new Map<string, string[]>();
  for (const path of all) {
    const key = foldPath(path);
    groups.set(key, [...(groups.get(key) ?? []), path]);
  }
  const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
  return [...groups.values()].filter((group) => group.length > 1 && new Set(group.map(parent)).size < group.length);
}

// Two scopes overlap when a literal prefix of one could fall inside the other.
// Conservative on purpose: a false overlap costs a glance, a missed one a conflict.
export function scopesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true; // unscoped means "anything"
  const stem = (g: string) => g.split(/[*?]/)[0];
  for (const x of a) {
    for (const y of b) {
      const sx = stem(x), sy = stem(y);
      if (sx.startsWith(sy) || sy.startsWith(sx)) return true;
    }
  }
  return false;
}

// Durable Object RPC keeps an error's message and drops its other fields, so
// the status and code travel inside the message and `parseRuleError` unpacks them.
export class RuleError extends Error {
  code: string;
  detail: string;
  status: number;
  constructor(code: string, detail: string, status = 409) {
    super(`${status}|${code}|${detail}`);
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

export function parseRuleError(err: unknown): { status: number; code: string; detail: string } | null {
  const m = err instanceof Error ? /^(\d{3})\|([a-z_]+)\|([\s\S]*)$/.exec(err.message) : null;
  return m ? { status: Number(m[1]), code: m[2], detail: m[3] } : null;
}

export function assertClaimable(item: Item, actor: string): void {
  if (!validActor(actor)) throw new RuleError("bad_actor", `"${actor}" is not harness/model`, 400);
  assertNotBlocked(item);
  if (item.state === "merged" || item.state === "abandoned" || item.state === "accepted") {
    throw new RuleError("closed", `${item.id} is ${item.state}`);
  }
  if (item.owner && item.owner !== actor) {
    throw new RuleError("owned", `${item.id} is owned by ${item.owner}; ask for a handoff`);
  }
}

// Role policy takes precedence over legacy harness eligibility. Taking work
// needs the executor role; planning a plan needs the planner role.
export function assertEligible(actor: string, policy: ProjectPolicy, owner = DEFAULT_OWNER, role: AgentRole = "executor"): void {
  if (policy.agents) {
    if (!hasRole(actor, policy, role)) throw new RuleError("ineligible", `${actor} needs an available agent with the ${role} role`, 403);
    return;
  }
  if (actor === owner || !policy.eligible?.length) return;
  const harness = actor.split("/")[0];
  if (!policy.eligible.some((k) => harness === k || harness.startsWith(`${k}-`))) {
    throw new RuleError("ineligible", `${harness} is not an eligible agent here (eligible: ${policy.eligible.join(", ")})`, 403);
  }
}

// ControlPlane names agents separately from the harness that runs a model.
export function agentOf(actor: string, agents: Record<string, AgentPolicy>): string | null {
  const [harness, named] = actor.toLowerCase().split("/");
  if (!named) return null;
  // The model by modelKey, so a profile suffix or another name for the same
  // model never maps the actor to another agent.
  const model = modelKey(actor);
  const fixed = harness === "claude-code" ? "claude" : harness === "codex" ? "codex"
    : harness === "zcode" || (harness === "opencode" && model.startsWith("glm")) ? "glm" : null;
  const family = familyOf(model);
  const names: Record<string, string> = { anthropic: "claude", openai: "gpt", zai: "glm", google: "gemini", meta: "llama" };
  if (fixed) return Object.hasOwn(agents, fixed) ? fixed : null;
  // A ControlPlane policy's "antigravity" agent means Gemini through
  // Antigravity (its CLI is agy). Antigravity also serves other vendors'
  // models, and those are matched by their own family, like any harness.
  if (harness === "antigravity" && family === "google" && Object.hasOwn(agents, "antigravity")) return "antigravity";
  const name = names[family] ?? (family === "other" ? model.match(/^[a-z]+/)?.[0] : family);
  if (name && Object.hasOwn(agents, name)) return name;
  return family !== "other" && Object.hasOwn(agents, family) ? family : null;
}

export function hasRole(actor: string, policy: ProjectPolicy, role: AgentRole): boolean {
  if (!policy.agents) return true;
  const name = agentOf(actor, policy.agents);
  return name !== null && policy.agents[name].available && policy.agents[name].eligible_roles.includes(role);
}

export function countingReviews(reviews: Review[], head: string | null, policy: ProjectPolicy, owner = DEFAULT_OWNER): Review[] {
  return latestReviews(reviews, head).filter((r) => r.by === owner || hasRole(r.by, policy, "assessor"));
}

export function measuredPaths(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((p) => typeof p === "string") ? value : null;
}

// The guarded set is matched whatever the letter case or Unicode form, since
// the owner's Mac writes such a variant to the guarded file. The direct
// allow-list, like an item's scope, is matched as written: it grants an
// exemption from review, so a variant path falls outside it and needs the
// review, which is the safe side of the comparison.
// The ship files' folder, guarded in every project: a change to what the
// owner's ship runs is a change to code the owner executes with the owner's
// environment, and an item cannot add a ship file either.
export const SHIP_FILES = ["docs/atelier/**"];

export function changeClass(paths: string[], policy: ProjectPolicy): ChangeClass | null {
  if (!paths.length) return null;
  const guarded = [...policy.protected, ...checkFiles(policy.checks), ...(policy.execution?.protected_path_patterns ?? []), ...SHIP_FILES, ...checkFiles(policy.shipRuns ?? [])];
  if (paths.some((p) => matchesFolded(p, guarded))) return "protected";
  const direct = policy.execution?.direct;
  return direct?.enabled && paths.every((p) => matchesAny(p, direct.allowed_path_patterns)) ? "direct" : "coordinated";
}

export function classRequirement(kind: ChangeClass): string {
  if (kind === "protected") return "Protected change: needs one review from another model family";
  if (kind === "coordinated") return "Coordinated change: needs one review from another agent";
  return "Direct change: needs no review";
}

// What the gate says is missing when a change in a project without an
// execution policy lacks its independent review. Such a project has no
// change classes to name, so the blocker names the protected path instead.
export const PROTECTED_NEED = "touches a protected path; needs approval from a model of another family than every contributor";

// Whether one review is the independent review a change needs. The project
// owner's approval never is: the owner decides by accepting, and the
// decision is not also the second opinion. A reviewer must be a
// harness/model actor that is not any contributor under another spelling.
// A protected change, in every project, needs a model of a recognised family
// that no contributor shares (familyRefusal); a coordinated change in a
// governed project needs any other agent.
export function independentApproval(r: Review, kind: "protected" | "coordinated", contributors: readonly string[], owner = DEFAULT_OWNER): boolean {
  if (!r.approve || sameActor(r.by, owner) || !validActor(r.by) || !r.by.includes("/")) return false;
  if (contributors.some((actor) => sameActor(r.by, actor))) return false;
  return kind === "coordinated" || familyRefusal(r.by, contributors) === null;
}

// The owner's override that stands at the item's current head, if any. One
// recorded at another head, or by anyone but the owner, or without a reason,
// is not.
export function overrideAt(item: Pick<Item, "head" | "reviewOverride">, owner = DEFAULT_OWNER): ReviewOverride | null {
  const o = item.reviewOverride;
  return o && item.head && o.head === item.head && o.by === owner && o.reason.trim() ? o : null;
}

// A blocked task answers every move with the same refusal: the reason it is
// blocked, and the command that lets it go on. Claims, pushes, reviews,
// submission, handoff and release all stop here; abandon does not, so the
// owner can still close it.
export function assertNotBlocked(item: Item): void {
  if (item.state !== "blocked") return;
  const reason = item.blocked?.reason ?? "no reason recorded";
  throw new RuleError("blocked", `${item.id} is blocked: ${reason}. Run atelier unblock ${item.id} first`);
}

// Only a task that is waiting, in progress or in review can be blocked: an
// accepted one is the owner's to merge or send back, and a closed one is
// closed. One already blocked keeps its first reason; unblock it to change it.
export function assertBlockable(item: Item): void {
  if (item.state === "blocked") {
    throw new RuleError("already_blocked", `${item.id} is already blocked: ${item.blocked?.reason ?? "no reason recorded"}. Run atelier unblock ${item.id} to lift that, then block it again with the new reason`);
  }
  if (item.state !== "open" && item.state !== "claimed" && item.state !== "submitted") {
    throw new RuleError("closed", `${item.id} is ${item.state}; only an open, claimed or submitted task can be blocked`);
  }
}

export const REASON_MAX = 500;
export const FIELD_MAX = 300;
export const FIELD_LIST_MAX = 20;

// A line of the owner's text as stored: control characters as spaces,
// trimmed. Empty means absent.
const line = (v: unknown): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "");

// The reason a block records. A missing, blank or over-long reason is
// refused, not cut or filled in, because it is what the owner reads in the
// inbox to decide what to do.
export function blockReason(value: unknown): string {
  const reason = line(value);
  if (!reason) throw new RuleError("block_reason", "a block needs a reason: atelier block ID \"what it is waiting on\"", 400);
  if (reason.length > REASON_MAX) throw new RuleError("block_reason", `a block's reason is at most ${REASON_MAX} characters`, 400);
  return reason;
}

// The item fields a request sets, checked at the boundary: each list is
// strings with something in each, at most FIELD_LIST_MAX of them; the gate is
// one line or null. A field that is not sent is left out, so the Ledger
// keeps the item's value for it.
export function itemFields(input: Record<string, unknown>): ItemFields {
  const list = (v: unknown, field: string): string[] => {
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || !line(s))) throw new RuleError("bad_field", `${field} must be a list of strings with something in each`, 400);
    if (v.length > FIELD_LIST_MAX) throw new RuleError("bad_field", `${field} holds at most ${FIELD_LIST_MAX} entries`, 400);
    const entries = v.map(line);
    if (entries.some((s) => s.length > FIELD_MAX)) throw new RuleError("bad_field", `each ${field} entry is at most ${FIELD_MAX} characters`, 400);
    return entries;
  };
  const out: ItemFields = {};
  if (input.nonGoals !== undefined) out.nonGoals = list(input.nonGoals, "nonGoals");
  if (input.stopWhen !== undefined) out.stopWhen = list(input.stopWhen, "stopWhen");
  if (input.nextGate !== undefined) {
    if (input.nextGate !== null && typeof input.nextGate !== "string") throw new RuleError("bad_field", "nextGate must be text or null", 400);
    const gate = line(input.nextGate);
    if (gate.length > FIELD_MAX) throw new RuleError("bad_field", `nextGate is at most ${FIELD_MAX} characters`, 400);
    out.nextGate = gate || null;
  }
  return out;
}

export const OVERRIDE_REASON_MAX = 500;

// The reason an override records: text, control characters as spaces,
// trimmed. A missing, blank or over-long reason is refused, not cut or
// filled in, because it is the record of why the owner overrode the review.
export function overrideReason(value: unknown): string {
  const reason = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  if (!reason) throw new RuleError("override_reason", "an override of the independent review needs a reason", 400);
  if (reason.length > OVERRIDE_REASON_MAX) throw new RuleError("override_reason", `an override's reason is at most ${OVERRIDE_REASON_MAX} characters`, 400);
  return reason;
}

// The override the owner may record at an item's head, and what it waives.
// It is refused when the gate at that head is not missing an independent
// review, as when one has been given or the change needs none: an override
// there would waive nothing, and recording one would blur what the owner
// decided. Whatever else the gate asks still applies once it is recorded.
export function reviewOverrideFor(
  item: Item, policy: ProjectPolicy, evidence: Evidence[], reviews: Review[], owner: string, reason: unknown, at: string,
): { override: ReviewOverride; waived: string; contributors: string[] } {
  const text = overrideReason(reason);
  const g = gate({ ...item, reviewOverride: null }, policy, evidence, reviews, owner);
  if (!item.head || !g.needsAssessor) {
    const where = item.head ? ` at ${item.head.slice(0, 8)}` : "";
    throw new RuleError("override_unneeded", `${item.id}${where} is not missing an independent review, so there is nothing to override${g.ready ? "; accept it without an override" : `: ${g.blockers.join("; ")}`}`);
  }
  return { override: { head: item.head, by: owner, reason: text, at }, waived: g.requirement ?? PROTECTED_NEED, contributors: contributorsOf(item) };
}

// Live items held by someone else whose scope overlaps this one. Items of
// one plan are not counted against each other (samePlan).
export function overlappingLive(item: Item, items: Item[], actor: string): Item[] {
  return items.filter(
    (o) => o.id !== item.id && (o.state === "claimed" || o.state === "submitted") && o.owner !== actor && !samePlan(item, o) && scopesOverlap(item.scope, o.scope),
  );
}

export function assertClaimAllowed(item: Item, items: Item[], policy: ProjectPolicy, actor: string, owner = DEFAULT_OWNER, role: AgentRole = "executor"): void {
  assertClaimable(item, actor);
  assertEligible(actor, policy, owner, role);
  if (policy.refuseOverlap && item.owner !== actor) {
    const clash = overlappingLive(item, items, actor);
    if (clash.length) {
      const names = clash.map((o) => `${o.id} (${o.owner})`).join(", ");
      throw new RuleError("overlap", `${item.id}'s scope overlaps live ${names}; this project refuses overlapping claims${item.scope.length ? "" : ", and an unscoped item overlaps everything"}`);
    }
  }
}

export function assertOwner(item: Item, actor: string): void {
  if (item.owner !== actor) {
    throw new RuleError("not_owner", `${actor} does not own ${item.id} (owner: ${item.owner ?? "nobody"})`, 403);
  }
}

// Whether a required check applies to a change. A check without paths
// applies to every change. One with paths applies exactly when a changed
// path matches one of them, whatever the letter case or Unicode form
// (matchesFolded), so a variant spelling of a path still needs the check.
// Null while the changed paths are not yet measured.
export function checkApplies(policy: Pick<ProjectPolicy, "checkPaths">, command: string, changed: string[] | null): boolean | null {
  const paths = policy.checkPaths?.find((c) => c.command === command)?.paths;
  if (!paths?.length) return true;
  if (changed === null) return null;
  return changed.some((p) => matchesFolded(p, paths));
}

// The evidence picture at one head: every required check that applies, or
// may apply while the changed paths are unmeasured, is observed-pass,
// observed-fail, or pending; a check whose paths the change does not touch is
// listed as not applicable and never blocks. Reports are listed but never
// satisfy a check.
export interface EvidenceView {
  checks: { claim: string; grade: Grade; passed: boolean | null; where?: "sandbox" | "runner"; mainHead?: string }[];
  notApplicable: string[];
  reports: Evidence[];
  changedPaths: string[] | null;  // null until an observed check has measured them
}

// Whether an observed result counts as a check at the head: a merged check
// does not, since it ran on another tree, and under sandboxOnly a check run
// on someone's machine is still shown but does not count.
const countsAtHead = (policy: ProjectPolicy, e: Evidence) => e.grade === "observed" && !e.merged && (!policy.sandboxOnly || e.where === "sandbox");

export function evidenceAt(policy: ProjectPolicy, evidence: Evidence[], head: string | null): EvidenceView {
  const atHead = head ? evidence.filter((e) => e.head === head) : [];
  const counts = (e: Evidence) => countsAtHead(policy, e);
  const latest = (claim: string) =>
    atHead.filter((e) => counts(e) && !e.notApplicable && e.claim === claim).sort((a, b) => a.at.localeCompare(b.at)).pop();
  const measured = atHead.filter((e) => counts(e) && measuredPaths(e.changedPaths) !== null).sort((a, b) =>
    Number(a.where === "sandbox") - Number(b.where === "sandbox") || a.at.localeCompare(b.at)).pop();
  const changedPaths = measured?.changedPaths ?? null;
  const applies = (claim: string) => checkApplies(policy, claim, changedPaths) !== false;
  const checks = policy.checks.filter(applies).map((claim) => {
    const e = latest(claim);
    return e
      ? { claim, grade: "observed" as Grade, passed: e.passed, where: e.where ?? "runner", ...(e.mainHead ? { mainHead: e.mainHead } : {}) }
      : { claim, grade: "pending" as Grade, passed: null };
  });
  return {
    checks,
    notApplicable: policy.checks.filter((claim) => !applies(claim)),
    reports: atHead.filter((e) => e.grade === "reported"),
    changedPaths,
  };
}

// The checks on the would-be merge at one head: for each required check, the
// latest merged run at this head that counts, with the main head it merged
// with. A run is stale once main has moved past that commit; a check with no
// merged run is pending. Only the head's own moves retire a run outright,
// since a merged run is bound to the head it names. A check that does not
// apply to the change (checkApplies) is left out, as it is from the head's
// own checks: a merged run of it is not needed either.
export interface MergedCheckView {
  checks: { claim: string; grade: Grade; passed: boolean | null; where?: "sandbox" | "runner"; mainHead?: string; stale: boolean; at?: string; by?: string }[];
  run: boolean;   // whether any merged check has been run at this head
}

export function mergedChecksAt(policy: ProjectPolicy, evidence: Evidence[], head: string | null, mainNow: string | null): MergedCheckView {
  const runs = head ? evidence.filter((e) => e.head === head && e.merged && e.grade === "observed" && !e.notApplicable && (!policy.sandboxOnly || e.where === "sandbox")) : [];
  const changed = evidenceAt(policy, evidence, head).changedPaths;
  const checks = policy.checks.filter((claim) => checkApplies(policy, claim, changed) !== false).map((claim) => {
    const e = runs.filter((e) => e.claim === claim).sort((a, b) => a.at.localeCompare(b.at)).pop();
    return e
      ? { claim, grade: "observed" as Grade, passed: e.passed, where: e.where ?? "runner", mainHead: e.mainHead, stale: !!mainNow && e.mainHead !== mainNow, at: e.at, by: e.by }
      : { claim, grade: "pending" as Grade, passed: null, stale: false };
  });
  return { checks, run: runs.length > 0 };
}

// A failing merged check blocks acceptance only where the head's own passing
// run no longer speaks for the merge: main had moved on from the head that
// run recorded by the time the merged check ran, so the merged run names
// another main head. The comparison is with the head's own run the merged
// run followed, and a head's own run made after it does not clear the
// failure: that run passes on the head's tree and says nothing about the
// merge (PAVI's decision of 2026-10-06, t178). Only a later merged run that
// passes, or a new head, clears it. A merged check is never required, so a
// pending one blocks nothing, and a failing one run against the same main as
// the head's own check before it is shown and not counted. The latest merged
// run per check decides. While the head's own check fails, it is the blocker.
export function mergedBlockers(policy: ProjectPolicy, evidence: Evidence[], head: string | null): string[] {
  const out: string[] = [];
  for (const m of mergedChecksAt(policy, evidence, head, null).checks) {
    if (m.grade !== "observed" || m.passed || !m.mainHead || !m.at) continue;
    const own = evidence.filter((e) => e.head === head && e.claim === m.claim && !e.notApplicable && countsAtHead(policy, e)).sort((a, b) => a.at.localeCompare(b.at));
    if (!own.at(-1)?.passed) continue;
    // The head's own run the merged one followed says which main the head's
    // check saw. With none before it, the latest run's main head is all the
    // record holds. A run that names no main head cannot say main moved.
    const ranAt = m.at, seen = own.filter((e) => e.at <= ranAt).at(-1) ?? own.at(-1)!;
    if (!seen.mainHead || (seen.at <= ranAt && seen.mainHead === m.mainHead)) continue;
    out.push(`\`${m.claim}\` failed on the merge with main at ${m.mainHead.slice(0, 8)}, which moved after this revision's own checks passed; run atelier check --merged again, or bring main into the workspace`);
  }
  return out;
}

// A check runs from the item's own head, so an item could weaken the check it
// is graded by. What a check executes is therefore protected: a script it runs
// directly or through an interpreter; the recipe files make and just run; the
// manifest a package manager or build tool runs scripts from, whose scripts an
// item could otherwise rewrite, with the configuration that changes what it
// runs; and the local binary npx and its kin would run. Files a check merely
// reads, such as the code under test, are not, and nor is test configuration.
const INTERPRETERS = new Set(["node", "sh", "bash", "zsh", "python", "python3", "deno", "bun", "tsx", "ruby", "perl"]);
// What each package manager runs scripts from, and the configuration that
// can change what it runs: npm's script shell, pnpm's install hooks, yarn's
// committed release and plugins, bun's preloads.
// The tables are Maps, so a check line holding a word such as constructor
// or __proto__ finds nothing rather than Object.prototype.
const PACKAGE_MANAGERS = new Map<string, string[]>(Object.entries({
  npm: ["package.json", ".npmrc"],
  pnpm: ["package.json", ".npmrc", ".pnpmfile.cjs"],
  yarn: ["package.json", ".yarnrc", ".yarnrc.yml", ".yarn/plugins/**", ".yarn/releases/**"],
  bun: ["package.json", "bunfig.toml"],
}));
// Build tools whose manifest names code they run: cargo's build scripts and
// runner configuration, swift's package manifest, an Xcode project's or
// workspace's build phases and schemes.
const BUILD_TOOLS = new Map<string, string[]>(Object.entries({
  cargo: ["**/Cargo.toml", "**/build.rs", ".cargo/config", ".cargo/config.toml"],
  swift: ["**/Package.swift", "**/Package@swift-*.swift"],
  xcodebuild: ["**/*.xcodeproj/**", "**/*.xcworkspace/**", "**/Package.swift", "**/Package@swift-*.swift"],
}));
// The recipe files make and just read from the working directory, the files
// those can include, and the options that name another file or directory.
const RECIPES = new Map<string, { files: string[]; included: string; file: string[]; dir: string[] }>(Object.entries({
  make: { files: ["Makefile", "makefile", "GNUmakefile"], included: "**/*.mk", file: ["-f", "--file", "--makefile"], dir: ["-C", "--directory"] },
  just: { files: ["justfile", "Justfile", ".justfile"], included: "**/*.just", file: ["-f", "--justfile"], dir: ["-d", "--working-directory"] },
}));

// Words a shell puts before a command, and wrappers that run the command
// after them: skipped to find the command, with each wrapper's own options
// (those that take a value are listed) and, for timeout, its duration.
const SHELL_WORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "time", "exec", "command", "builtin", "nohup"]);
const WRAPPERS = new Map<string, { valued: string[]; args?: number }>(Object.entries({
  env: { valued: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"] },
  "/usr/bin/env": { valued: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"] },
  "cross-env": { valued: [] },
  sudo: { valued: ["-u", "-g", "-h", "-p", "-r", "-t", "-U", "-C", "-D", "-R", "-T"] },
  doas: { valued: ["-u", "-C"] },
  nice: { valued: ["-n", "--adjustment"] },
  timeout: { valued: ["-s", "-k", "--signal", "--kill-after"], args: 1 },
  "xvfb-run": { valued: ["-s", "-e", "-f", "-p", "-n", "-w", "--server-args", "--error-file", "--auth-file", "--server-num", "--wait"] },
}));
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

export function checkFiles(checks: string[]): string[] {
  const files = new Set<string>();
  // A path inside the repository, as Git names it.
  const inside = (path: string) => !path.startsWith("/") && !path.startsWith("../") && path !== "..";
  const add = (path: string) => { if (inside(path)) files.add(path.replace(/^\.\//, "")); };
  const assignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
  // The value of one of the named options at words[i]: the word after it, or
  // what follows = in the option itself; null when words[i] is none of them.
  const option = (words: string[], i: number, names: string[]): string | null => {
    const [name, inline] = words[i].split(/=(.*)/s);
    return names.includes(name) ? inline ?? words[i + 1] ?? null : null;
  };
  // The index of the command word from `from` on: past environment
  // assignments, the shell's own words and wrappers with their options.
  const commandAt = (words: string[], from: number): number => {
    for (let i = from; i < words.length; i++) {
      const word = words[i];
      if (assignment(word) || SHELL_WORDS.has(word)) continue;
      const wrapper = WRAPPERS.get(word);
      if (!wrapper) return i;
      let args = wrapper.args ?? 0;
      while (i + 1 < words.length) {
        const next = words[i + 1];
        if (next.startsWith("-")) { i += wrapper.valued.includes(next) && !next.includes("=") ? 2 : 1; }
        else if (args > 0) { i++; args--; }
        else break;
      }
    }
    return -1;
  };
  // Every command position of a segment: its command, and the command of
  // the string a shell's -c runs, through the same wrappers.
  const commands = (words: string[]): number[] => {
    const out: number[] = [];
    for (let at = commandAt(words, 0); at !== -1; ) {
      out.push(at);
      if (!SHELLS.has(words[at])) break;
      let inner = -1;
      for (let j = at + 1; j < words.length; j++) {
        const w = words[j];
        if (!w.startsWith("-")) break;
        if (!w.startsWith("--") && w.includes("c")) { inner = j + 1; break; }
        if (w === "-o") j++;
      }
      at = inner === -1 ? -1 : commandAt(words, inner);
    }
    return out;
  };
  // The manager's files, and the same under the directory its --prefix, -C,
  // --dir or --cwd option names, where it then reads them.
  const managerFiles = (words: string[], at: number, manager: string) => {
    const own = PACKAGE_MANAGERS.get(manager) ?? [];
    for (const file of own) files.add(file);
    for (let i = at + 1; i < words.length; i++) {
      const dir = option(words, i, ["--prefix", "-C", "--dir", "--cwd"]);
      if (dir !== null && inside(dir)) for (const file of own) add(`${dir.replace(/\/?$/, "/")}${file}`);
    }
  };
  // A directory an option names, normalised as Git names a changed path: "."
  // and empty segments dropped, ".." resolved against what precedes it. Null
  // when it climbs out of the repository, where nothing it names is guarded.
  // A directory outside the repository (an absolute path) names no file the
  // item can edit, so it guards nothing.
  const normalDir = (dir: string): string | null => {
    if (dir.startsWith("/")) return null;
    const parts: string[] = [];
    for (const part of dir.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") { if (!parts.pop()) return null; continue; }
      parts.push(part);
    }
    return parts.join("/");
  };
  for (const cmd of checks) {
    // Each command of a line, as the shell separates them, a newline included.
    for (const segment of cmd.split(/[;&|()\n\r]+/)) {
      const words = segment.split(/[\s<>"'`]+/).filter(Boolean);
      // A path run directly, in any command position: bin/check, scripts/verify.
      for (const at of commands(words)) if (words[at].includes("/")) add(words[at]);
      // A runner's name counts wherever it stands in the line, as a wrapper, a
      // shell's -c string or shell syntax may put it anywhere: a word that is
      // one errs toward protecting what it runs.
      words.forEach((word, i) => {
        const prev = words[i - 1];
        if (word.startsWith("-")) return;
        if (word.startsWith("./") || /\.sh$/.test(word) || (prev && INTERPRETERS.has(prev) && /[./]/.test(word))) add(word);
        if (PACKAGE_MANAGERS.has(word)) managerFiles(words, i, word);
        for (const file of BUILD_TOOLS.get(word) ?? []) files.add(file);
        if (word === "deno" && words[i + 1] === "task") ["deno.json", "deno.jsonc"].forEach((file) => files.add(file));
        // npx, bunx and a package manager's dlx, exec or x run a local binary
        // by its name, resolved through the manager's own files.
        const viaManager = PACKAGE_MANAGERS.has(prev) && ["dlx", "exec", "x"].includes(word);
        if (word === "npx" || word === "bunx" || viaManager) {
          const manager = word === "npx" ? "npm" : word === "bunx" ? "bun" : prev;
          for (const file of PACKAGE_MANAGERS.get(manager) ?? []) files.add(file);
          let j = i + 1;
          while (j < words.length && words[j].startsWith("-")) j += ["-p", "--package", "-c", "--call"].includes(words[j]) ? 2 : 1;
          // The binary's name: a scoped package's own name, without a version.
          const bin = words[j]?.split("/").pop()?.replace(/(?!^)@.*$/, "");
          if (bin && !words[j].startsWith(".")) files.add(`node_modules/.bin/${bin}`);
        }
        const recipe = RECIPES.get(word);
        if (recipe) {
          let dir: string | null = "", named: string | null = null;
          for (let j = i + 1; j < words.length; j++) {
            const d = option(words, j, recipe.dir), f = option(words, j, recipe.file);
            if (d !== null) dir = normalDir(d);
            if (f !== null) named = f;
          }
          if (dir !== null) for (const file of named !== null ? [named] : recipe.files) add(file.startsWith("/") ? file : dir ? `${dir}/${file}` : file);
          files.add(recipe.included);
        }
      });
    }
  }
  return [...files].sort();
}

export interface Gate {
  changeClass?: ChangeClass | null;
  requirement?: string;
  ready: boolean;
  blockers: string[];
  needsAssessor: boolean;
  outOfScope: string[];
  overridden?: ReviewOverride;  // set when the owner's override stands in for a missing independent review
}

export function gate(item: Item, policy: ProjectPolicy, evidence: Evidence[], reviews: Review[], owner = DEFAULT_OWNER): Gate {
  reviews = countingReviews(reviews, item.head, policy, owner);
  const blockers: string[] = [];
  if (item.state !== "submitted") blockers.push(`state is ${item.state}, not submitted`);
  if (!item.head) blockers.push("no verified push");
  const view = evidenceAt(policy, evidence, item.head);
  for (const c of view.checks) {
    if (c.grade === "pending") blockers.push(`\`${c.claim}\` not yet observed at this head`);
    else if (!c.passed) blockers.push(`\`${c.claim}\` failed when observed`);
  }
  blockers.push(...mergedBlockers(policy, evidence, item.head));
  if (view.changedPaths === null) blockers.push("changed paths not yet observed");
  const changed = view.changedPaths ?? [];
  const kind = view.changedPaths === null ? null : changeClass(changed, policy);
  const governed = policy.execution !== undefined;
  if (governed && view.changedPaths?.length === 0) blockers.push("nothing to merge");
  const requirement = kind ? classRequirement(kind) : view.changedPaths === null ? "Change class pending: changed paths not yet observed" : "Nothing to merge";
  let needsAssessor = false;
  let overridden: ReviewOverride | null = null;
  if (governed && kind && !policy.execution!.allowed_classes.includes(kind)) blockers.push(`${kind} changes are not allowed by this project's execution policy`);
  // A protected change needs an independent review in every project, and a
  // coordinated one does under an execution policy. Families and agents are
  // compared by modelKey and sameActor, so a contributor's model under
  // another letter case, profile or registered name is never independent of
  // itself. Without a qualifying approval, the owner's override at this head
  // stands in for it; the owner's approval does not.
  if (kind === "protected" || (governed && kind === "coordinated")) {
    const contributors = contributorsOf(item);
    if (!reviews.some((r) => independentApproval(r, kind, contributors, owner))) {
      overridden = overrideAt(item, owner);
      if (!overridden) {
        needsAssessor = true;
        blockers.push(governed ? requirement : PROTECTED_NEED);
      }
    }
  }
  const rejected = reviews.filter((r) => r.head === item.head && !r.approve);
  for (const r of rejected) blockers.push(`rejected by ${r.by}: ${r.note || "no note"}`);
  // Scope is matched as written: a path in another letter case is reported
  // outside it, which shows the variant rather than hiding it.
  const outOfScope = item.scope.length ? changed.filter((p) => !matchesAny(p, item.scope)) : [];
  return {
    ready: blockers.length === 0, blockers, needsAssessor, outOfScope,
    ...(governed ? { changeClass: kind, requirement } : {}),
    ...(overridden ? { overridden } : {}),
  };
}

// "What needs the project owner now?" Only things a person must decide or
// unblock rank high; failing checks are the item owner's problem and rank
// below anything awaiting the project owner.
export interface InboxEntry {
  project: string;
  itemId: string;
  title: string;
  kind: "accept" | "assess" | "merge" | "ship" | "blocked" | "stale" | "overlap" | "scope" | "failing" | "approve-plan" | "plan-blocked";
  reason: string;
  weight: number;
}

// The weights of a plan's own entries, which the Ledger adds beside
// inboxFor's (src/plans/state.ts): approving a proposed split, and deciding
// for a blocked plan.
export const PLAN_INBOX_WEIGHTS = { "approve-plan": 95, "plan-blocked": 85 } as const;

const STALE_HOURS = 12;

export function inboxFor(
  project: string,
  items: Item[],
  policy: ProjectPolicy,
  evidence: Evidence[],
  reviews: Review[],
  now: Date,
  owner = DEFAULT_OWNER,
): InboxEntry[] {
  const out: InboxEntry[] = [];
  const live = items.filter((i) => i.state === "claimed" || i.state === "submitted");
  for (const item of items) {
    const ev = evidence.filter((e) => e.itemId === item.id);
    const rv = reviews.filter((r) => r.itemId === item.id);
    const base = { project, itemId: item.id, title: item.title };
    // Where the owner's override stands in for the independent review, the
    // entry says so and gives its reason. An accepted item is read as
    // accept() reads it, as if still submitted.
    const overrode = (g: Gate) => (g.overridden ? `, with the independent review overridden by the project owner: ${g.overridden.reason}` : "");
    // A part is reported through its plan (the Ledger's planView), so it
    // never appears as an accept, assess, failing, scope or stale entry. An
    // accepted part still asks to be merged.
    const part = item.kind === "part";
    if (item.state === "accepted") {
      const g = gate({ ...item, state: "submitted" }, policy, ev, rv, owner);
      out.push({ ...base, kind: "merge", reason: `accepted${overrode(g)}; run \`atelier merge\` in the project checkout`, weight: 90 });
      continue;
    }
    // A blocked task waits on the owner to clear what blocks it, so it ranks
    // with the decisions, below a missing review and above a scope change.
    if (item.state === "blocked") {
      const b = item.blocked;
      out.push({ ...base, kind: "blocked", reason: `blocked by ${b?.by ?? "nobody"}: ${b?.reason ?? "no reason recorded"}; run \`atelier unblock ${item.id}\` when it can go on`, weight: 70 });
      continue;
    }
    if (item.state === "submitted" && !part) {
      const g = gate(item, policy, ev, rv, owner);
      if (g.ready) {
        out.push({ ...base, kind: "accept", reason: `all checks observed passing at this head${overrode(g)}`, weight: 100 });
      } else if (g.needsAssessor) {
        out.push({ ...base, kind: "assess", reason: `${g.requirement ?? PROTECTED_NEED}; ask a reviewer who qualifies, or accept with an override and its reason`, weight: 80 });
      } else if (g.blockers.some((b) => b.includes("failed"))) {
        out.push({ ...base, kind: "failing", reason: g.blockers.find((b) => b.includes("failed"))!, weight: 20 });
      }
      if (g.outOfScope.length) {
        out.push({ ...base, kind: "scope", reason: `changes outside its scope: ${g.outOfScope.slice(0, 3).join(", ")}`, weight: 60 });
      }
    }
    if (item.state === "claimed" && !part) {
      const last = new Date(item.lastPushAt ?? item.updatedAt);
      const hours = (now.getTime() - last.getTime()) / 3_600_000;
      if (hours > STALE_HOURS) {
        out.push({ ...base, kind: "stale", reason: `${item.owner} has not pushed for ${Math.floor(hours)}h; hand it off or release it`, weight: 50 });
      }
    }
  }
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      if (!samePlan(live[i], live[j]) && scopesOverlap(live[i].scope, live[j].scope)) {
        out.push({
          project, itemId: live[i].id, title: live[i].title, kind: "overlap",
          reason: `scope overlaps ${live[j].id} (${live[j].owner ?? "unowned"})`, weight: 40,
        });
      }
    }
  }
  return out.sort((a, b) => b.weight - a.weight);
}

// Repo names: letters, digits, . _ - ; must start alphanumeric; ≤ 63 here to be safe.
export function repoName(project: string, itemId?: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  const name = itemId ? `${clean(project)}--${clean(itemId)}` : clean(project);
  if (!name || name.length > 63) throw new RuleError("bad_name", `cannot make a repo name from "${project}"`, 400);
  return name;
}

// Local cache cleanup requires proof that no unpublished work will be lost.
// A merged item's proof is its accepted head; an abandoned item, which never
// merges, is proved by the last head Atelier recorded for it, so its workspace
// goes only when it still sits at that head with nothing else in it.
export function gcWorkspaceReason(
  item: Pick<Item, "state" | "head" | "acceptedHead"> | undefined,
  head: string, dirty: boolean, extraCommits: boolean,
): string | null {
  if (item?.state !== "merged" && item?.state !== "abandoned") return "item is neither merged nor abandoned";
  const abandoned = item!.state === "abandoned";
  const proof = abandoned ? item!.head : item!.acceptedHead;
  if (!proof || head !== proof) return abandoned ? "HEAD is not the last head Atelier recorded" : "HEAD is not the merged head";
  if (dirty) return "contains changed or untracked files";
  if (extraCommits) return abandoned ? "contains commits outside the recorded history" : "contains commits outside the merged history";
  return null;
}

export const GC_CHECK_AGE_MS = 24 * 60 * 60 * 1000;

export function gcCheckReason(startedAt: unknown, running: boolean, now: number): string | null {
  if (running) return "check process may still be running";
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt > now) return "invalid check age";
  if (now - startedAt < GC_CHECK_AGE_MS) return "check is less than 24 hours old";
  return null;
}

export function assertRevision(item: Item, expected: string): void {
  if (!/^[a-f0-9]{40,64}$/.test(expected)) throw new RuleError("missing_revision", "refresh the task and choose a revision before acting", 400);
  if (expected !== item.head) throw new RuleError("stale_head", "this task changed since you opened it; refresh and review the new revision");
}

export function assertLive(item: Item): void {
  assertNotBlocked(item);
  if (!["claimed", "submitted"].includes(item.state)) throw new RuleError("closed", `${item.id} is ${item.state}`);
}

export function latestReviews(reviews: Review[], head: string | null): Review[] {
  const latest = new Map<string, Review>();
  for (const r of reviews.filter((r) => r.head === head).sort((a, b) => a.at.localeCompare(b.at))) latest.set(r.by, r);
  return [...latest.values()];
}

export const stateLabel: Record<ItemState, string> = {
  open: "Ready to start", claimed: "Working", submitted: "In review", accepted: "Ready to merge", merged: "Merged", abandoned: "Closed", blocked: "Blocked",
};

// A reason as one sentence of a longer text: ended with a full stop unless
// it already ends a sentence.
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

export function decisionFor(item: Item, policy: ProjectPolicy, evidence: Evidence[], reviews: Review[], owner = DEFAULT_OWNER) {
  const g = gate(item, policy, evidence, reviews, owner);
  const view = evidenceAt(policy, evidence, item.head);
  const passed = view.checks.filter((c) => c.grade === "observed" && c.passed).length;
  const failed = view.checks.some((c) => c.grade === "observed" && !c.passed);
  if (item.state === "merged") return { title: "Merged into the project", detail: "The accepted revision is in the project baseline. Publishing and deployment are separate actions.", action: "none", tone: "go", passed };
  if (item.state === "abandoned") return { title: "Task closed", detail: "The history and evidence remain available.", action: "none", tone: "", passed };
  if (item.state === "blocked") {
    const b = item.blocked;
    return { title: "Blocked", detail: `${b?.by ?? "Nobody"} blocked it: ${sentence(b?.reason ?? "no reason recorded")} It keeps its owner and workspace, and nothing moves until it is unblocked.`, action: "none", tone: "ask", passed };
  }
  if (item.state === "accepted") {
    const overridden = gate({ ...item, state: "submitted" }, policy, evidence, reviews, owner).overridden;
    const detail = overridden
      ? `You accepted it with the independent review overridden: ${sentence(overridden.reason)} Run the revision-bound command below in your local checkout.`
      : "Approval is recorded. Run the revision-bound command below in your local checkout.";
    return { title: "Ready to merge", detail, action: "merge", tone: "go", passed };
  }
  if (failed) return { title: "Checks need attention", detail: "The task owner must fix the failing checks and finish again.", action: "none", tone: "bad", passed };
  if (item.state === "submitted" && mergedBlockers(policy, evidence, item.head).length) return { title: "Checks need attention", detail: "Main has moved since this revision's checks passed, and the required checks fail on its merge with main. The task owner must bring main into the workspace, fix the result and finish again; running the revision's own checks again does not clear it, only a passing merged run or a new revision.", action: "none", tone: "bad", passed };
  // The owner's approval is recorded but is not the independent review, so
  // the page asks for a qualifying reviewer, and offers the override only
  // when the missing review is all that blocks, since it waives nothing else.
  if (item.state === "submitted" && g.needsAssessor) {
    const need = g.requirement ? `${g.requirement}.` : "This task changes protected files and needs an approval from a model of another family than every contributor.";
    const override = g.blockers.length === 1 ? " If no reviewer qualifies, you can accept with an override and say why." : "";
    return { title: "Waiting for an independent review", detail: `${need} Your own approval does not count as that review.${override}`, action: "review", tone: "ask", passed };
  }
  if (item.state === "submitted" && g.ready) {
    const detail = g.overridden
      ? `Required checks passed for this revision, and you overrode the independent review: ${sentence(g.overridden.reason)} Accept it to prepare the local merge.`
      : "Required checks passed for this revision. Accept it to prepare the local merge.";
    return { title: "Ready to accept", detail, action: "accept", tone: "go", passed };
  }
  if (countingReviews(reviews, item.head, policy, owner).some((r) => !r.approve)) return { title: "Changes requested", detail: "The task owner must address the review. The reviewer can approve the revision after the concern is resolved.", action: "none", tone: "ask", passed };
  return { title: stateLabel[item.state], detail: item.state === "open" ? "An agent can claim this task to start work." : "The task owner is preparing the work and its evidence. No decision is needed yet.", action: "none", tone: "", passed };
}

export interface PushNotice { repo: string; ref: string; after: string }
export function pushNotice(value: unknown, namespace = "atelier"): PushNotice | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { type?: string; source?: { namespace?: string; repoName?: string }; payload?: { ref?: string; after?: string } };
  if (v.type !== "cf.artifacts.repo.pushed" || v.source?.namespace !== namespace) return null;
  const { ref, after } = v.payload ?? {};
  if (!v.source.repoName || !ref?.startsWith("refs/heads/") || !after || !/^[a-f0-9]{40,64}$/.test(after) || /^0+$/.test(after)) return null;
  return { repo: v.source.repoName, ref, after };
}
