// Which stuck episodes the developer is told about. An episode is due once it
// has been open for NOTICE_AFTER_MS since it first opened and no notice of it
// has been recorded. A notice is recorded only after the channel accepted the
// message, so a failed send is due again on the next tick. The key includes
// the episode number, so a recurrence after clearing is a new episode and is
// told again. Pure: the Ledger keeps the transitions and the sent notices.
import { keyOf, type Transition } from "./episodes.ts";

export const NOTICE_AFTER_MS = 60 * 60_000;

export const noticeKey = (t: Pick<Transition, "project" | "item" | "cause" | "episode">) => `${keyOf(t)}#${t.episode}`;

// `transitions` are one project's, oldest first; `sent` the notice keys
// already recorded. Returns the opened transitions due now, oldest first.
export function dueNotices(transitions: readonly Transition[], sent: ReadonlySet<string>, now: number): Transition[] {
  const open = new Map<string, Transition>();
  for (const t of transitions) {
    if (t.kind === "opened") open.set(keyOf(t), t); else open.delete(keyOf(t));
  }
  return [...open.values()].filter((t) => now - Date.parse(t.at) >= NOTICE_AFTER_MS && !sent.has(noticeKey(t)));
}
