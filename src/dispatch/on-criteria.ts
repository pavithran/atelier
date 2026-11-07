import type { Decision } from "../decisions.ts";
import { RuleError, type Item } from "../rules.ts";
import { buildersOf } from "../standing.ts";

interface Context {
  decisions: readonly Decision[];
  items: () => Item[];
  hasCriteria: (item: Item) => boolean;
  dispatchedBefore: (id: string) => boolean;
  held: (item: Item) => boolean;
  // The builders at work: claimed a task, or already queued one.
  busy: () => string[];
  dispatch: (id: string, agent: string, model: string, reason: string) => void;
  // The mark that a task waits for a builder. The dispatch clears it in its
  // own transaction, so a crash before the dispatch leaves it set.
  wait: (id: string, wait: BuildWait | null) => void;
}

// Why a task filed with criteria has not been dispatched: the builder it
// waits for, or none when every listed builder is refused by a rule.
export interface BuildWait {
  for: string | null;
  reason: string;
  since: string;
}

// The standing instruction (dispatch-on-criteria, in src/standing.ts) lists
// the project's builders in order. A task with criteria is dispatched to the
// first builder that is free and that the project's rules allow, as soon as
// it is filed, and the criteria review runs beside the build. A task with no
// criteria is not dispatched. When no builder is free the task waits and names
// the first it waits for. A task that was dispatched before waits for another
// explicit dispatch, rather than starting twice.
export function dispatchOnCriteria(c: Context): void {
  const decision = c.decisions.find(d => !d.withdrawn && d.standing?.key === "dispatch-on-criteria");
  const builders = decision?.standing ? buildersOf(decision.standing.value) : [];
  if (!decision || !builders.length) return;
  const busy = new Set(c.busy().map(b => b.toLowerCase()));
  for (const item of c.items()) {
    if (item.kind || item.state !== "open" || item.owner || item.dispatch || c.dispatchedBefore(item.id) || !c.hasCriteria(item) || c.held(item)) continue;
    let waitsFor: string | null = null;
    let reason = "";
    let sent = false;
    for (const builder of builders) {
      const free = !busy.has(builder.toLowerCase());
      if (!free) { waitsFor ??= builder; reason ||= `${builder} is at work on another task`; continue; }
      const slash = builder.indexOf("/");
      try {
        c.dispatch(item.id, builder.slice(0, slash), builder.slice(slash + 1), `standing decision ${decision.id}: dispatch-on-criteria = ${decision.standing!.value}`);
        busy.add(builder.toLowerCase());
        sent = true;
        break;
      } catch (error) {
        // A policy or model refusal passes over this builder; storage
        // failures still fail the call, and its transaction rolls back.
        if (!(error instanceof RuleError)) throw error;
        reason ||= `${builder} is refused: ${error.detail ?? error.message}`;
      }
    }
    if (!sent) c.wait(item.id, { for: waitsFor, reason: reason || "no builder is listed", since: new Date().toISOString() });
  }
}
