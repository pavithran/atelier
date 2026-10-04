// Handoff notes, as a pure function over an item and its ledger events. The
// note restates what the ledger recorded, newest fact first, and invents
// nothing: only events speak.

import type { Item } from "../rules.ts";
import type { LedgerEvent } from "../ledger.ts";

export interface NoteFact {
  at: string;
  text: string;
}

// Each fact is one line; the caller renders or tests them in order.
export function noteFacts(item: Item, events: LedgerEvent[]): NoteFact[] {
  const facts: NoteFact[] = [];
  const mine = events
    .filter((e) => e.itemId === item.id)
    .sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
  for (const e of mine) {
    const head = typeof e.data.head === "string" ? e.data.head.slice(0, 8) : null;
    switch (e.kind) {
      case "item.claimed":
        facts.push({ at: e.at, text: `${e.actor} claimed the item` });
        break;
      case "item.handoff":
        facts.push({ at: e.at, text: `handed off from ${e.data.from ?? e.actor} to ${e.data.to ?? "?"}` });
        break;
      case "push.observed":
        if (head) facts.push({ at: e.at, text: `pushed head ${head}` });
        break;
      case "evidence.observed":
        if (head) facts.push({ at: e.at, text: `observed check ${JSON.stringify(e.data.claim ?? "")} at ${head}: ${e.data.passed ? "passed" : "failed"}` });
        break;
      case "evidence.reported":
        facts.push({ at: e.at, text: `${e.actor} reported ${JSON.stringify(e.data.claim ?? "")}` });
        break;
      case "review.approved":
        facts.push({ at: e.at, text: `${e.actor} approved${e.data.note ? `: ${JSON.stringify(e.data.note)}` : ""}` });
        break;
      case "review.rejected":
        facts.push({ at: e.at, text: `${e.actor} requested changes${e.data.note ? `: ${JSON.stringify(e.data.note)}` : ""}` });
        break;
    }
  }
  return facts.reverse(); // newest first
}

export function handoffNotes(item: Item, events: LedgerEvent[]): string {
  const facts = noteFacts(item, events);
  const lines = [`Handoff notes for ${item.id} (${item.title})`];
  for (const f of facts) lines.push(`- ${f.at} ${f.text}`);
  if (facts.length === 0) lines.push("- the ledger has no recorded facts for this item");
  return lines.join("\n");
}