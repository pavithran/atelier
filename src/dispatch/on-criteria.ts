import type { Decision } from "../decisions.ts";
import { RuleError, type Item } from "../rules.ts";

interface Context {
  decisions: readonly Decision[];
  items: () => Item[];
  approved: (id: string) => boolean;
  dispatchedBefore: (id: string) => boolean;
  held: (item: Item) => boolean;
  dispatch: (id: string, agent: string, model: string, reason: string) => void;
}

// The decision supplies the builder. A revised task that was dispatched
// before waits for another explicit dispatch, rather than starting twice.
export function dispatchOnCriteria(c: Context): void {
  const decision = c.decisions.find(d => !d.withdrawn && d.standing?.key === "dispatch-on-criteria");
  const target = decision?.standing?.value;
  if (!decision || !target || target === "off") return;
  const slash = target.indexOf("/");
  for (const item of c.items()) {
    if (item.kind || item.state !== "open" || item.owner || item.dispatch || c.dispatchedBefore(item.id) || !c.approved(item.id) || c.held(item)) continue;
    try {
      c.dispatch(item.id, target.slice(0, slash), target.slice(slash + 1), `standing decision ${decision.id}: dispatch-on-criteria = ${target}`);
    } catch (error) {
      // A policy or model refusal keeps the approved task waiting. Storage
      // failures still fail the call, and its transaction rolls back.
      if (!(error instanceof RuleError)) throw error;
    }
  }
}
