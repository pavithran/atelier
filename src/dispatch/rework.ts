// Where a rejection goes (t521). On 2026-11-01 to 06, 131 of 146 pre-merge
// rejections were reworked and merged at a later head, and a session that
// judged each one first wrote about three records per merge. A rejection now
// goes straight back to the task's builder with the findings. A session is
// woken only when a person's judgment is the next step: a second rejection of
// the task, a finding the builder disputes, or a reply the reviewer could not
// put in a readable form twice. Pure: the runner reads the claim and acts.

export type Route =
  | { action: "dispatch"; agent: string; model: string }
  | { action: "wake"; reason: string; second?: true }
  | { action: "none" };

export interface RejectionInput {
  // The rejected round this verdict is: 1 for the first rejected head of the
  // task, 2 for the second (the review claim's `need.round`).
  round: number;
  // The task's builder as harness/model, or null when it has none.
  builder: string | null;
  // The task's kind; a plan's part is sent back by its plan (reworkPart).
  kind?: string | null;
  // The project owner's name, which is never a builder to dispatch.
  owner?: string;
}

export function routeRejection(input: RejectionInput): Route {
  if (input.kind === "part" || input.kind === "plan") return { action: "none" };
  // The ledger records this one's notice with the verdict, so the runner
  // only logs it (src/ledger.ts, noticeSecondRejection).
  if (input.round >= 2) return { action: "wake", second: true, reason: `this is the second rejection of the task (round ${input.round}), so a session decides what happens next; nothing was dispatched` };
  const slash = input.builder?.indexOf("/") ?? -1;
  if (!input.builder || slash < 1 || slash === input.builder.length - 1 || input.builder === (input.owner ?? "owner")) {
    return { action: "wake", reason: "the rejected task has no builder model to send it back to, so a session decides who reworks it" };
  }
  return { action: "dispatch", agent: input.builder.slice(0, slash), model: input.builder.slice(slash + 1) };
}

// A reply that states no verdict is asked of the reviewer once more; a second
// one cannot be retried by the pipeline (PAVI's Q2), so it wakes a session.
export function unparsableRoute(attempt: number): "retry" | "wake" {
  return attempt <= 1 ? "retry" : "wake";
}

// The builder records a dispute as the reason of its own block of the task,
// which keeps the task waiting: `atelier block ID "disputes finding N: WHY"`.
const DISPUTE = /^disputes finding (\d+): \S/;

export function disputeReason(index: number, why: string): string {
  if (!Number.isInteger(index) || index < 1) throw new Error("a dispute names the finding by its position, from 1");
  const text = why.replace(/\s+/g, " ").trim();
  if (!text) throw new Error("a dispute says why the finding is wrong");
  return `disputes finding ${index}: ${text}`;
}

export function isDispute(reason: unknown): boolean {
  return typeof reason === "string" && DISPUTE.test(reason.trim());
}

// The finding a dispute names, by its position from 1, or null.
export function disputedFinding(reason: unknown): number | null {
  const m = typeof reason === "string" ? DISPUTE.exec(reason.trim()) : null;
  return m ? Number(m[1]) : null;
}

// The note a rejected task's dispatch carries to its builder, cut to fit.
export function reworkNote(id: string, head: string, findings: readonly { file?: string; line?: number; severity: string; text: string }[], summary: string, max = 1800): string {
  const lines = findings.filter((f) => f.severity === "blocking").map((f, i) => `${i + 1}. ${f.file ?? "?"}${f.line ? `:${f.line}` : ""} ${f.text}`);
  const note = `Rejected at ${head.slice(0, 8)}: ${summary.replace(/\s+/g, " ").trim()} ${lines.join(" ")} To dispute a finding: atelier block ${id} "disputes finding N: why".`.replace(/\s+/g, " ");
  return note.length > max ? `${note.slice(0, max - 1)}…` : note;
}
