import { RuleError, validActor } from "./rules.ts";

export interface AgentToken {
  id: string;
  hash: string;
  actor: string;
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
  const actor = input.actor;
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
  return { actor, ...(projects !== undefined ? { projects: [...new Set(projects as string[])] } : {}),
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
    if (method === "GET") return ["owners", "standing", "items", "baseline-head"].includes(section);
    return section === "baseline-token" && method === "POST" && body.scope !== "write";
  }
  if (section !== "items" || !id) return false;
  if (method === "GET") return parts.length === 4 || parts.length === 5 && ["brief", "diff", "job-brief"].includes(verb) || parts.length === 6 && verb === "sandbox";
  return method === "POST" && parts.length === 5 && ["claim", "read-token", "base-token", "push", "evidence", "sandbox", "review", "review-claim", "review-release", "submit", "handoff", "release", "plan", "integrated", "integration-failed", "refreshed", "refresh-failed", "block", "unblock"].includes(verb);
}
