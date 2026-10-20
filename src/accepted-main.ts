// Where accepted work stands against main (t60): the read that feeds
// acceptedAgainstMain (src/rules.ts). History is only read, never changed,
// and no check runs. `holds` is the history search: true, false, or null when
// it could not answer; a search that throws is the same as null, so one fork
// that cannot be read leaves that task "unknown" and the others read.
import { acceptedAgainstMain, type AcceptedAgainstMain, type Item } from "./rules.ts";

// How many accepted tasks are read; the rest are "unknown" without a read,
// so a status stays quick.
export const ACCEPTED_READS = 10;

export async function readAccepted(
  items: Pick<Item, "id" | "title" | "state" | "fork" | "acceptedHead">[], main: string | null,
  holds: (fork: string, head: string, main: string) => Promise<boolean | null>,
): Promise<AcceptedAgainstMain[]> {
  const found = new Map<string, boolean | null>();
  const accepted = items.filter((i) => i.state === "accepted" && i.acceptedHead);
  await Promise.all(accepted.slice(0, ACCEPTED_READS).map(async (i) => {
    try { found.set(i.id, main && i.fork ? await holds(i.fork, i.acceptedHead!, main) : null); } catch { found.set(i.id, null); }
  }));
  return acceptedAgainstMain(items, main, found);
}
