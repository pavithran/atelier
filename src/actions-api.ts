// The routes for protected actions (src/actions.ts), under
// /api/projects/P/actions, and the project page's two forms:
//
//   GET  actions               the approvals, newest first, and the latest runs
//   POST actions               approve {kind, commit, note?, expires?}
//   POST actions/ID/withdraw   withdraw an active approval {note?}
//   POST actions/consume       use the approval for {kind, commit}: one approval, one run
//   POST actions/runs          record a step a ship ran
//
// Every route is the project owner's. An agent token reaches none of them,
// since agentRoute (src/tokens.ts) lists no such route, and each one here
// refuses any actor but the owner, as accept does.

import type { Ledger } from "./ledger.ts";
import { cleanApprovalInput } from "./actions.ts";
import { RuleError } from "./rules.ts";

type LedgerStub = DurableObjectStub<Ledger>;

// Whether a revision is on the project's main line as Atelier holds it: true,
// false, or null when the history read stopped before it could tell.
export type MainLine = (commit: string) => Promise<boolean | null>;

function owner(actor: string, ownerActor: string): void {
  if (actor !== ownerActor) throw new RuleError("not_project_owner", "only the project owner approves, withdraws or runs a protected action", 403);
}

// The checks come before Artifacts is read, so a refusal for the actor or the
// request's shape costs no read and names its own reason.
async function approve(L: LedgerStub, body: Record<string, unknown>, actor: string, ownerActor: string, onMainLine: MainLine) {
  owner(actor, ownerActor);
  const { commit } = cleanApprovalInput(body);
  const held = await onMainLine(commit);
  if (held === null) throw new RuleError("ancestry_unverified", `Atelier could not find ${commit.slice(0, 8)} in the part of the main line's history it reads; approve a recent revision, such as the head atelier ship --dry-run names`, 409);
  if (!held) throw new RuleError("not_on_main_line", `${commit.slice(0, 8)} is not on the project's main line as Atelier holds it in the baseline; approve a revision the baseline holds, such as the head atelier ship --dry-run names`, 409);
  return await L.approveAction(body, actor);
}

export async function actionsApi(L: LedgerStub, method: string, rest: string[], body: Record<string, unknown>, actor: string, ownerActor: string, onMainLine: MainLine): Promise<{ status: number; data: unknown }> {
  owner(actor, ownerActor);
  if (rest.length === 0 && method === "GET") {
    const [approvals, runs] = await Promise.all([L.actionApprovals(), L.actionRuns(20)]);
    return { status: 200, data: { approvals, runs } };
  }
  if (method === "POST" && rest.length === 0) return { status: 201, data: await approve(L, body, actor, ownerActor, onMainLine) };
  if (method === "POST" && rest.length === 1 && rest[0] === "consume") return { status: 200, data: await L.consumeAction(body, actor) };
  if (method === "POST" && rest.length === 1 && rest[0] === "runs") return { status: 201, data: await L.recordActionRun(body, actor) };
  if (method === "POST" && rest.length === 2 && rest[1] === "withdraw") return { status: 200, data: await L.withdrawAction(rest[0], actor, body.note) };
  throw new RuleError("not_found", "no such route", 404);
}

// The project page's forms: approve at the head the page showed, and
// withdraw. The answer is the same as the API's, refusals included.
export async function actionForm(L: LedgerStub, verb: string | undefined, form: FormData, ownerActor: string, onMainLine: MainLine): Promise<void> {
  const field = (name: string) => String(form.get(name) ?? "");
  if (verb === "approve") {
    await approve(L, { kind: field("kind"), commit: field("head"), note: field("note"), expires: field("expires") || undefined }, ownerActor, ownerActor, onMainLine);
    return;
  }
  if (verb === "withdraw") {
    await L.withdrawAction(field("id"), ownerActor, field("note"));
    return;
  }
  throw new RuleError("not_found", "Unknown action.", 400);
}
