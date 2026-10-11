import { matchesFolded, RuleError } from "./rules.ts";
import { refusalOf } from "./checks.ts";

// This policy and run are independent of leases, tasks' terminal state and
// executor type. Ledger writes every transition synchronously before replying.
export interface PrivacyPolicy {
  authors: { name: string; email: string }[];
  committers: { name: string; email: string }[];
  // Literal, case-sensitive substrings, checked in messages, paths and blobs.
  patterns: string[];
  forbiddenPaths: string[];
}
export interface PostMergeStep {
  name: string;
  command: string;
  class: "check" | "deploy" | "publish";
  when: "always" | { paths: string[] };
  protect: string[];
  timeoutMs: number;
  versionUrl?: string;
  destination?: string;
  ref?: string;
  privacy?: PrivacyPolicy;
}
export interface PostMergePolicy { version: 1; steps: PostMergeStep[]; approval: { by: string; at: string; reason: string } }
export interface Attempt {
  id: string; number: number; startedAt: string; deadline: string;
  outcome: "running" | "uncertain" | "failed" | "passed" | "waived";
  commandOutcome?: "passed" | "failed";
  publication?: { source: string; remote: string | null; commits: number };
  deployment?: { commit: string; routeLevel: number };
  retry?: { by: string; at: string; reason: string };
  output?: string; reason?: string; by?: string; endedAt?: string;
}
export interface PostMergeRun {
  id: string; members: string[]; before: string; after: string | null;
  policy: PostMergePolicy; createdAt: string;
  state: "reserved" | "pending" | "running" | "failed" | "uncertain" | "complete";
  paths: string[] | null;
  steps: { name: string; outcome: "pending" | "not_applicable" | "passed" | "waived"; attempts: Attempt[] }[];
}
const bad = (message: string): never => { throw new RuleError("bad_post_merge", message, 400); };
export const hash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{40,64}$/.test(s);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 200 && v.every(s => typeof s === "string" && !!s.trim() && s.length <= 2000);
export function parsePostMerge(value: unknown, actor: string, at: string): PostMergePolicy | null {
  if (value === null) return null;
  const v = value as PostMergePolicy;
  if (!v || v.version !== 1 || !Array.isArray(v.steps) || v.steps.length > 30) bad("postMerge needs version: 1 and at most 30 ordered steps; null clears it");
  if (!v.steps.length) return null;
  if (typeof v.approval?.reason !== "string" || !v.approval.reason.trim() || v.approval.reason.length > 2000) bad("post-merge steps require explicit owner approval with a reason");
  const names = new Set<string>();
  const steps = v.steps.map(s => {
    if (!s || !/^[a-zA-Z][\w-]{0,63}$/.test(s.name) || names.has(s.name)) bad("step names must be unique identifiers");
    names.add(s.name);
    if (typeof s.command !== "string" || !s.command.trim() || s.command.length > 4000 || s.command.includes("\0")) bad("each step needs a command");
    if (!["check", "deploy", "publish"].includes(s.class)) bad("each step needs an explicit check, deploy or publish class");
    if (s.when !== "always" && (!s.when || !strings(s.when.paths) || !s.when.paths.length)) bad("each step needs always or nonempty paths");
    if (!strings(s.protect) || !s.protect.length) bad("each step must declare the scripts and configuration it trusts in protect");
    if (!Number.isInteger(s.timeoutMs) || s.timeoutMs < 1000 || s.timeoutMs > 3600000) bad("timeoutMs must be 1000..3600000");
    if (s.class === "check" && refusalOf(s.command)) bad("post-merge checks must be read-only; deployment and publication need their own class");
    if (s.class === "deploy") {
      if (s.command !== "npm run deploy") bad("deploy steps run exactly npm run deploy");
      let url; try { url = new URL(s.versionUrl!); } catch { bad("deploy needs an HTTPS versionUrl ending in /version"); }
      if (url!.protocol !== "https:" || !url!.pathname.endsWith("/version") || url!.username || url!.password || url!.search || url!.hash) bad("deploy needs an HTTPS versionUrl ending in /version, without credentials or query");
    }
    if (s.class === "publish") {
      if (s.command !== "git push") bad("publish steps use the controlled git push, without shell arguments");
      let destination;
      try { destination = new URL(s.destination!); } catch { bad("publish needs a valid HTTPS destination"); }
      if (destination!.protocol !== "https:" || destination!.username || destination!.password || destination!.search || destination!.hash) bad("publish needs an explicit HTTPS destination without embedded credentials, query or fragment");
      if (typeof s.ref !== "string" || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(s.ref)) bad("publish needs an explicit refs/heads/ ref");
      const p = s.privacy;
      const identities = (a: unknown): boolean => Array.isArray(a) && a.length > 0 && a.length <= 100 && a.every(i => i && typeof i.name === "string" && !!i.name && typeof i.email === "string" && !!i.email && !/[\r\n\0]/.test(i.name + i.email));
      if (!p || !identities(p.authors) || !identities(p.committers) || !strings(p.patterns) || !strings(p.forbiddenPaths)) bad("publish privacy needs exact author/committer name-email pairs, literal patterns and forbiddenPaths globs");
    }
    return structuredClone(s);
  });
  return { version: 1, steps, approval: { by: actor, at, reason: v.approval.reason.trim() } };
}
export function reservePostMerge(policy: PostMergePolicy, members: string[], before: string, id: string, at: string): PostMergeRun {
  if (!hash(before)) bad("cannot reserve post-merge work without the observed default-branch SHA");
  return { id, members: [...members], before, after: null, policy: structuredClone(policy), createdAt: at, state: "reserved", paths: null, steps: policy.steps.map(s => ({ name: s.name, outcome: "pending", attempts: [] })) };
}
export function currentStep(run: PostMergeRun) { return run.steps.find(s => s.outcome === "pending"); }
export function expireAttempt(run: PostMergeRun, now: number): void {
  const a = currentStep(run)?.attempts.at(-1);
  if (a?.outcome === "running" && Date.parse(a.deadline) <= now) { a.outcome = "uncertain"; run.state = "uncertain"; }
}
export function preparePostMerge(run: PostMergeRun, paths: string[]): void {
  if (!run.after) bad("the merge must be recorded before steps can run");
  if (run.paths !== null) return;
  if (!Array.isArray(paths) || !paths.every(p => typeof p === "string" && !!p && !p.includes("\0"))) bad("the complete net diff is required");
  run.paths = [...new Set(paths)];
  run.steps.forEach((s, i) => { const when = run.policy.steps[i].when; if (s.outcome === "pending" && when !== "always" && !paths.some(p => matchesFolded(p, when.paths))) s.outcome = "not_applicable"; });
  run.state = currentStep(run) ? "pending" : "complete";
}
export function startAttempt(run: PostMergeRun, id: string, at: string): Attempt {
  expireAttempt(run, Date.parse(at));
  if (run.state !== "pending" || run.paths === null) throw new RuleError("post_merge_blocked", `run ${run.id} is ${run.state}; reconcile uncertain effects before retrying`, 409);
  const step = currentStep(run)!;
  const spec = run.policy.steps.find(s => s.name === step.name)!;
  const a: Attempt = { id, number: step.attempts.length + 1, startedAt: at, deadline: new Date(Date.parse(at) + spec.timeoutMs + 600000).toISOString(), outcome: "running" };
  step.attempts.push(a); run.state = "running"; return a;
}
// Redact before truncation so a boundary cannot expose part of a credential.
// The executor also supplies environment values; the server repeats generic
// redaction rather than trusting executor output to have been sanitized.
export function redactedOutput(output: unknown, secrets: string[] = []): string {
  if (typeof output !== "string") return "";
  let text = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[redacted]");
  text = text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted private key]")
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/(\b["']?[\w.-]{0,128}(?:token|password|passwd|secret|api[_-]?key|authorization|credential)[\w.-]{0,128}["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi, "$1[redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16})\b/g, "[redacted]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  const limit = 8192, marker = "\n[output truncated]";
  return text.length > limit ? text.slice(0, limit - marker.length) + marker : text;
}
export function recordCommand(run: PostMergeRun, id: string, passed: boolean, publication?: Attempt["publication"]): void {
  const a = currentStep(run)?.attempts.at(-1);
  if (!a || a.id !== id || a.outcome !== "running") throw new RuleError("stale_attempt", "command report is no longer current", 409);
  a.commandOutcome = passed ? "passed" : "failed";
  if (publication) {
    if (publication.source !== run.after || (publication.remote !== null && !hash(publication.remote)) || !Number.isInteger(publication.commits) || publication.commits < 0) bad("invalid publication observation");
    a.publication = publication;
  }
}
export function finishAttempt(run: PostMergeRun, id: string, passed: boolean, output: unknown, at: string, deployment?: Attempt["deployment"], commandOutcome?: Attempt["commandOutcome"]): void {
  const step = currentStep(run), a = step?.attempts.at(-1);
  if (!a || a.id !== id || a.outcome !== "running") throw new RuleError("stale_attempt", "attempt is no longer running; reconcile its external effect", 409);
  const spec = run.policy.steps.find(s => s.name === step!.name)!;
  if (passed && spec.class === "deploy" && (!deployment || deployment.commit !== run.after)) bad("deployment must be observed at the pinned SHA");
  Object.assign(a, { outcome: passed ? "passed" : "failed", output: redactedOutput(output, spec.privacy?.patterns), endedAt: at, ...(deployment ? { deployment } : {}), ...(commandOutcome ? { commandOutcome } : {}) });
  if (passed) step!.outcome = "passed";
  run.state = passed ? currentStep(run) ? "pending" : "complete" : "failed";
}
export function recoverPostMerge(run: PostMergeRun, action: string, reason: unknown, actor: string, at: string, resolution?: unknown, deployment?: Attempt["deployment"]): void {
  expireAttempt(run, Date.parse(at));
  const step = currentStep(run), a = step?.attempts.at(-1);
  if (!step) bad("no unresolved step");
  if (typeof reason !== "string" || !reason.trim() || reason.length > 2000) bad("recovery requires a reason, at most 2000 characters");
  if (action === "reconcile") {
    if (!a || !["running", "uncertain"].includes(a.outcome) || !["no-effect", "completed"].includes(String(resolution))) bad("reconcile needs a running/uncertain attempt and resolution no-effect or completed; confirm its executor has stopped");
    if (resolution === "completed" && run.policy.steps.find(s => s.name === step!.name)!.class === "deploy") {
      if (!deployment || deployment.commit !== run.after) bad("reconciling a deploy as completed requires independent version verification");
      a!.deployment = deployment;
    }
    a!.outcome = resolution === "completed" ? "passed" : "failed";
    Object.assign(a!, { reason, by: actor, endedAt: at });
    if (resolution === "completed") step!.outcome = "passed";
    run.state = resolution === "completed" ? currentStep(run) ? "pending" : "complete" : "failed";
    return;
  }
  // A recorded merge can be stranded before diff preparation (for example,
  // its before commit is unavailable). No command has started, so the owner
  // may waive each step without inventing a diff or an execution outcome.
  const reservedWaiver = run.state === "reserved" && !!run.after && action === "skip" && run.steps.every(s => s.attempts.every(a => a.outcome === "waived"));
  if (["running", "uncertain", "reserved"].includes(run.state) && !reservedWaiver) throw new RuleError("post_merge_uncertain", "stop the executor and reconcile its external effect before retry or skip", 409);
  if (action === "retry") {
    if (run.state !== "failed") bad("only a failed step can be retried");
    if (a) a.retry = { by: actor, at, reason: String(reason) };
    run.state = "pending";
  } else if (action === "skip") {
    step!.attempts.push({ id: crypto.randomUUID(), number: step!.attempts.length + 1, startedAt: at, deadline: at, endedAt: at, outcome: "waived", reason: String(reason), by: actor });
    step!.outcome = "waived"; run.state = currentStep(run) ? run.paths === null ? "reserved" : "pending" : "complete";
  } else bad("unknown post-merge recovery action");
}
