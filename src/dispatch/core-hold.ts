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
