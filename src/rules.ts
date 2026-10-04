// Atelier's rules, as pure functions. Nothing here touches Cloudflare, so the
// whole policy can be tested with `node --test` and read in one place.

export type ItemState = "open" | "claimed" | "submitted" | "accepted" | "merged" | "abandoned";

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
  createdAt: string;
  updatedAt: string;
  lastPushAt: string | null;
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
  changedPaths?: string[];  // observed checks record what the item actually changes
  outputTail?: string;
  // Where an observed check ran: "sandbox" is a Cloudflare container started by
  // the Worker; "runner" is Atelier's CLI on the caller's machine. Only the
  // Worker's own code can record "sandbox"; anything posted to the API is "runner".
  where?: "sandbox" | "runner";
}

export interface Review {
  itemId: string;
  by: string;
  head: string;
  approve: boolean;
  note: string;
  at: string;
}

export interface ProjectPolicy {
  checks: string[];         // commands that must pass, observed, before acceptance
  protected: string[];      // globs whose changes need an independent assessor
  eligible?: string[];      // harness families allowed to act (e.g. "claude"); empty or absent means any
  refuseOverlap?: boolean;  // refuse a claim whose scope overlaps another live item
  approval?: string;
  sandboxOnly?: boolean;    // only checks observed in a Cloudflare sandbox count
}

// The actor that stands for the project owner. A deployment names its own with
// OWNER_ACTOR; "owner" is the default.
export const DEFAULT_OWNER = "owner";

const ACTOR = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/i;

export function validActor(actor: string): boolean {
  return ACTOR.test(actor);
}

// "claude-code/opus-5.5" → "opus-5.5". The model, not the harness, is what
// makes a second opinion independent; the same model in another harness is not.
export function modelOf(actor: string): string {
  const slash = actor.indexOf("/");
  return slash === -1 ? actor : actor.slice(slash + 1);
}

// Minimal glob: `**` crosses directories, `*` does not, everything else literal.
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
  return new RegExp(`^${out}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
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
  if (item.state === "merged" || item.state === "abandoned" || item.state === "accepted") {
    throw new RuleError("closed", `${item.id} is ${item.state}`);
  }
  if (item.owner && item.owner !== actor) {
    throw new RuleError("owned", `${item.id} is owned by ${item.owner}; ask for a handoff`);
  }
}

// "claude-code/opus-5.5" is eligible under "claude"; the project owner always is.
export function assertEligible(actor: string, policy: ProjectPolicy, owner = DEFAULT_OWNER): void {
  if (actor === owner || !policy.eligible?.length) return;
  const harness = actor.split("/")[0];
  if (!policy.eligible.some((k) => harness === k || harness.startsWith(`${k}-`))) {
    throw new RuleError("ineligible", `${harness} is not an eligible agent here (eligible: ${policy.eligible.join(", ")})`, 403);
  }
}

// Live items held by someone else whose scope overlaps this one.
export function overlappingLive(item: Item, items: Item[], actor: string): Item[] {
  return items.filter(
    (o) => o.id !== item.id && (o.state === "claimed" || o.state === "submitted") && o.owner !== actor && scopesOverlap(item.scope, o.scope),
  );
}

export function assertClaimAllowed(item: Item, items: Item[], policy: ProjectPolicy, actor: string, owner = DEFAULT_OWNER): void {
  assertClaimable(item, actor);
  assertEligible(actor, policy, owner);
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

// The evidence picture at one head: every required check is observed-pass,
// observed-fail, or pending; reports are listed but never satisfy a check.
export interface EvidenceView {
  checks: { claim: string; grade: Grade; passed: boolean | null; where?: "sandbox" | "runner" }[];
  reports: Evidence[];
  changedPaths: string[] | null;  // null until an observed check has measured them
}

export function evidenceAt(policy: ProjectPolicy, evidence: Evidence[], head: string | null): EvidenceView {
  const atHead = head ? evidence.filter((e) => e.head === head) : [];
  // Under sandboxOnly, a check run on someone's machine is still shown but does not count.
  const counts = (e: Evidence) => e.grade === "observed" && (!policy.sandboxOnly || e.where === "sandbox");
  const latest = (claim: string) =>
    atHead.filter((e) => counts(e) && e.claim === claim).sort((a, b) => a.at.localeCompare(b.at)).pop();
  const checks = policy.checks.map((claim) => {
    const e = latest(claim);
    return e
      ? { claim, grade: "observed" as Grade, passed: e.passed, where: e.where ?? "runner" }
      : { claim, grade: "pending" as Grade, passed: null };
  });
  const measured = atHead.filter((e) => counts(e) && e.changedPaths).sort((a, b) => a.at.localeCompare(b.at)).pop();
  return {
    checks,
    reports: atHead.filter((e) => e.grade === "reported"),
    changedPaths: measured?.changedPaths ?? null,
  };
}

// A check runs from the item's own head, so an item could weaken the check it
// is graded by. What a check executes is therefore protected: a script it runs
// directly or through an interpreter, and package.json when it goes through a
// package manager, whose scripts an item could otherwise rewrite. Files a check
// merely reads, such as the code under test, are not.
const INTERPRETERS = new Set(["node", "sh", "bash", "zsh", "python", "python3", "deno", "bun", "tsx", "ruby", "perl"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

export function checkFiles(checks: string[]): string[] {
  const files = new Set<string>();
  for (const cmd of checks) {
    const words = cmd.split(/[\s;&|()<>"'`]+/).filter(Boolean);
    words.forEach((word, i) => {
      const prev = words[i - 1];
      if (word.startsWith("-")) return;
      if (word.startsWith("./") || /\.sh$/.test(word) || (prev && INTERPRETERS.has(prev) && /[./]/.test(word))) {
        files.add(word.replace(/^\.\//, ""));
      }
      if (PACKAGE_MANAGERS.has(word)) files.add("package.json");
    });
  }
  return [...files].sort();
}

export interface Gate {
  ready: boolean;
  blockers: string[];
  needsAssessor: boolean;
  outOfScope: string[];
}

export function gate(item: Item, policy: ProjectPolicy, evidence: Evidence[], reviews: Review[], owner = DEFAULT_OWNER): Gate {
  reviews = latestReviews(reviews, item.head);
  const blockers: string[] = [];
  if (item.state !== "submitted") blockers.push(`state is ${item.state}, not submitted`);
  if (!item.head) blockers.push("no verified push");
  const view = evidenceAt(policy, evidence, item.head);
  for (const c of view.checks) {
    if (c.grade === "pending") blockers.push(`\`${c.claim}\` not yet observed at this head`);
    else if (!c.passed) blockers.push(`\`${c.claim}\` failed when observed`);
  }
  if (view.changedPaths === null) blockers.push("changed paths not yet observed");
  const changed = view.changedPaths ?? [];
  const guarded = [...policy.protected, ...checkFiles(policy.checks)];
  const touchesProtected = changed.some((p) => matchesAny(p, guarded));
  let needsAssessor = false;
  if (touchesProtected) {
    const ownerModel = item.owner ? modelOf(item.owner) : "";
    const independent = reviews.some(
      (r) => r.head === item.head && r.approve && (r.by === owner || (r.by.includes("/") && modelOf(r.by) !== ownerModel)),
    );
    if (!independent) {
      needsAssessor = true;
      blockers.push("touches a protected path; needs approval from a different model or the project owner");
    }
  }
  const rejected = reviews.filter((r) => r.head === item.head && !r.approve);
  for (const r of rejected) blockers.push(`rejected by ${r.by}: ${r.note || "no note"}`);
  const outOfScope = item.scope.length ? changed.filter((p) => !matchesAny(p, item.scope)) : [];
  return { ready: blockers.length === 0, blockers, needsAssessor, outOfScope };
}

// "What needs the project owner now?" Only things a person must decide or
// unblock rank high; failing checks are the item owner's problem and rank
// below anything awaiting the project owner.
export interface InboxEntry {
  project: string;
  itemId: string;
  title: string;
  kind: "accept" | "assess" | "merge" | "stale" | "overlap" | "scope" | "failing";
  reason: string;
  weight: number;
}

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
    if (item.state === "accepted") {
      out.push({ ...base, kind: "merge", reason: "accepted; run `atelier merge` in the project checkout", weight: 90 });
      continue;
    }
    if (item.state === "submitted") {
      const g = gate(item, policy, ev, rv, owner);
      if (g.ready) {
        out.push({ ...base, kind: "accept", reason: "all checks observed passing at this head", weight: 100 });
      } else if (g.needsAssessor) {
        out.push({ ...base, kind: "assess", reason: "touches a protected path; review it or assign a different model", weight: 80 });
      } else if (g.blockers.some((b) => b.includes("failed"))) {
        out.push({ ...base, kind: "failing", reason: g.blockers.find((b) => b.includes("failed"))!, weight: 20 });
      }
      if (g.outOfScope.length) {
        out.push({ ...base, kind: "scope", reason: `changes outside its scope: ${g.outOfScope.slice(0, 3).join(", ")}`, weight: 60 });
      }
    }
    if (item.state === "claimed") {
      const last = new Date(item.lastPushAt ?? item.updatedAt);
      const hours = (now.getTime() - last.getTime()) / 3_600_000;
      if (hours > STALE_HOURS) {
        out.push({ ...base, kind: "stale", reason: `${item.owner} has not pushed for ${Math.floor(hours)}h; hand it off or release it`, weight: 50 });
      }
    }
  }
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      if (scopesOverlap(live[i].scope, live[j].scope)) {
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
export function gcWorkspaceReason(
  item: Pick<Item, "state" | "acceptedHead"> | undefined,
  head: string, dirty: boolean, extraCommits: boolean,
): string | null {
  if (item?.state !== "merged") return "item is not confirmed merged";
  if (!item.acceptedHead || head !== item.acceptedHead) return "HEAD is not the merged head";
  if (dirty) return "contains changed, untracked or ignored files";
  if (extraCommits) return "contains commits outside the merged history";
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
  if (!["claimed", "submitted"].includes(item.state)) throw new RuleError("closed", `${item.id} is ${item.state}`);
}

export function latestReviews(reviews: Review[], head: string | null): Review[] {
  const latest = new Map<string, Review>();
  for (const r of reviews.filter((r) => r.head === head).sort((a, b) => a.at.localeCompare(b.at))) latest.set(r.by, r);
  return [...latest.values()];
}

export const stateLabel: Record<ItemState, string> = {
  open: "Ready to start", claimed: "Working", submitted: "In review", accepted: "Ready to merge", merged: "Merged", abandoned: "Closed",
};

export function decisionFor(item: Item, policy: ProjectPolicy, evidence: Evidence[], reviews: Review[], owner = DEFAULT_OWNER) {
  const g = gate(item, policy, evidence, reviews, owner);
  const view = evidenceAt(policy, evidence, item.head);
  const passed = view.checks.filter((c) => c.grade === "observed" && c.passed).length;
  const failed = view.checks.some((c) => c.grade === "observed" && !c.passed);
  if (item.state === "merged") return { title: "Merged into the project", detail: "The accepted revision is in the project baseline. Publishing and deployment are separate actions.", action: "none", tone: "go", passed };
  if (item.state === "abandoned") return { title: "Task closed", detail: "The history and evidence remain available.", action: "none", tone: "", passed };
  if (item.state === "accepted") return { title: "Ready to merge", detail: "Approval is recorded. Run the revision-bound command below in your local checkout.", action: "merge", tone: "go", passed };
  if (failed) return { title: "Checks need attention", detail: "The task owner must fix the failing checks and finish again.", action: "none", tone: "bad", passed };
  if (item.state === "submitted" && g.needsAssessor) return { title: "Your review is needed", detail: "This task changes protected files. Review the changes and approve this revision, or request changes.", action: "review", tone: "ask", passed };
  if (item.state === "submitted" && g.ready) return { title: "Ready to accept", detail: "Required checks passed for this revision. Accept it to prepare the local merge.", action: "accept", tone: "go", passed };
  if (latestReviews(reviews, item.head).some((r) => !r.approve)) return { title: "Changes requested", detail: "The task owner must address the review. The reviewer can approve the revision after the concern is resolved.", action: "none", tone: "ask", passed };
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
