import type { Item } from "../rules.ts";

// Who holds a core file. A task holds its core files for its whole life: from
// its first claim until it merges or is abandoned, so a task that submitted,
// was accepted, was rejected back to open, or was blocked still holds them. An
// open task never claimed holds nothing. A plan's part that integrated is
// finished work and holds nothing either, as holdGraph counts it done.
//
// "Claimed at least once" is read from the item's recorded item.claimed
// events (Ledger.items sets everClaimed on each item from them); this module
// only decides from that fact. The state "claimed" itself implies a claim, so
// an item built without the fact (a stuck report's snapshot) still holds
// while it is claimed.
const ENDED = new Set(["merged", "abandoned", "integrated"]);

export function holdsCore(item: Pick<Item, "state"> & { everClaimed?: boolean }): boolean {
  if (ENDED.has(item.state)) return false;
  return item.state === "claimed" || item.everClaimed === true;
}

// When the hold lifts, in words.
export const holdEnds = (id: string): string => `${id} merges or is abandoned`;

// A fix round: the task has a pushed head and its latest review at that head
// rejected it (t677). Finishing it is how a held task gets out, so the
// core-file hold never holds its build dispatch. The Ledger sets rejectedAt
// only for the current head, so a rejection of an older head, an approval and
// no review all leave it unset. The task may arrive without the fact (a claim
// reads it by id), so the list it sits in is read too.
export function isFixRound(item: Pick<Item, "id" | "head" | "rejectedAt">, items: readonly Pick<Item, "id" | "rejectedAt">[]): boolean {
  const rejected = item.rejectedAt ?? items.find((i) => i.id === item.id)?.rejectedAt;
  return !!item.head && rejected === item.head;
}
