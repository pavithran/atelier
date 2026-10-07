import type { ModelEvidence, ModelProfile, TaskKind, Where } from "./registry.ts";
import type { ModelRecord } from "./record.ts";
import { tiebreak as share } from "./reliability.ts";

export interface Task { kind: TaskKind }
export interface Constraints { localOnly: boolean; allowedWhere: Where | "any" }
export interface Candidate {
  profile: ModelProfile;
  actor: string | null; // null until a home model's harness is configured
  score: number;
  tiebreak: number;     // orders equal scores only; one half without a reliability record
  reasons: string[];
}

// A candidate's reliability across every project (src/models/reliability.ts),
// keyed by actor: the share of outcomes in its favour, and the reason that
// says so. It never changes a score.
export interface Tiebreak { value: number; reason: string }
const NEUTRAL = share({ good: 0, bad: 0 });

const WEIGHTS = { "model-card": 1, benchmark: 3, "local-qualification": 10, "atelier-record": 100 };
const CODE_TASKS: readonly TaskKind[] = ["mechanical-edit", "feature", "refactor", "tests"];

function relevance(evidence: ModelEvidence, task: Task): string | null {
  if (evidence.taskKind === task.kind || evidence.taskKind === "general") return "task or general evidence";
  if ((evidence.taskKind === "repository" || evidence.taskKind === "tool-use") && CODE_TASKS.includes(task.kind)) {
    return "routing prior: repository and tool-use qualifications may inform code tasks";
  }
  // Objective answers and long-context retrieval do not establish any of these
  // task skills. Keep their claims in the registry without a routing bonus.
  return null;
}

// Use only the strongest relevant evidence weight, so repeated cards cannot
// outweigh qualification. Each observed pass, approval or merge adds 100;
// each failure or rejection subtracts 100. A net outcome outweighs qualification.
// Raw counts favor longer histories; claims and handoffs are neutral. These
// weights are routing priors, not measured quality. Equal scores go by the
// reliability tie-breaker, then model id, then actor name.
// Two candidates the ranking cannot tell apart: the same score and the same
// reliability tie-breaker, so only the model id and the actor name order them.
export function tied(a: Candidate, b: Candidate): boolean {
  return a.score === b.score && a.tiebreak === b.tiebreak;
}

export function route(task: Task, profiles: readonly ModelProfile[], record: ModelRecord, constraints: Constraints, tiebreaks: ReadonlyMap<string, Tiebreak> = new Map()): Candidate[] {
  const candidates: Candidate[] = [];
  for (const profile of profiles) {
    if (constraints.localOnly && (profile.where !== "home" || !profile.dataStaysLocal)) continue;
    if (constraints.allowedWhere !== "any" && profile.where !== constraints.allowedWhere) continue;
    let evidenceScore = 0;
    const reasons: string[] = [];
    for (const evidence of profile.evidence) {
      const fit = relevance(evidence, task);
      if (!fit) continue;
      evidenceScore = Math.max(evidenceScore, WEIGHTS[evidence.kind]);
      reasons.push(`${evidence.kind} from ${evidence.source} (${evidence.date ?? "date not supplied"}): ${evidence.claim}; ${fit}; weight ${WEIGHTS[evidence.kind]}`);
    }
    if (!reasons.length) reasons.push(`No task evidence for ${task.kind}; no evidence bonus.`);
    const actors = profile.harnesses.length ? profile.harnesses.map((harness) => `${harness}/${profile.id}`) : [null];
    for (const actor of actors) {
      let score = evidenceScore;
      const actorReasons = [...reasons];
      const r = actor === null ? undefined : record.get(actor);
      if (r) {
        const positive = r.checkPasses + r.reviewsApproved + r.merges;
        const negative = r.checkFailures + r.reviewsRejected;
        const adjustment = WEIGHTS["atelier-record"] * (positive - negative);
        score += adjustment;
        actorReasons.push(`atelier-record from Atelier ledger for ${actor}: ${r.checkPasses} observed check passes, ${r.checkFailures} failures, ${r.reviewsApproved} reviews approved, ${r.reviewsRejected} rejected, ${r.merges} merges; score adjustment ${adjustment}. All supplied task kinds combined.`);
        actorReasons.push(`Atelier ledger for ${actor}: ${r.itemsClaimed} items claimed, ${r.handoffsAway} handoffs away; no score adjustment.`);
      }
      if (actor === null) actorReasons.push("Harness assignment not supplied; configure a harness before dispatch.");
      const tie = actor === null ? undefined : tiebreaks.get(actor);
      if (tie) actorReasons.push(tie.reason);
      candidates.push({ profile, actor, score, tiebreak: tie?.value ?? NEUTRAL, reasons: actorReasons });
    }
  }
  return candidates.sort((a, b) => b.score - a.score || b.tiebreak - a.tiebreak || a.profile.id.localeCompare(b.profile.id) || (a.actor ?? "").localeCompare(b.actor ?? ""));
}
