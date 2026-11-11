// Status waits for submitted tasks whose current head has no review request.
export function submissionWaits(items, project) {
  return (items ?? []).filter(i => i.state === "submitted" && i.head && i.reviewAskedHead === null)
    .map(i => ({ id: i.id, head: i.head, reason: "submitted with no review asked for this head", command: `atelier land ${i.id} --reviewer H/M --project ${project}` }));
}

// The most event pages read looking for a second rejection's notice.
const NOTICE_PAGES = 20;

// Tasks still submitted at the head their second-rejection notice names, with
// no dispatch after it: the runner sends nothing after that notice (t521), so
// they wait on the orchestrator. `readPage(before)` resolves to
// { events, next }, newest first. Events are read only while a candidate is
// undecided; its newest notice or dispatch decides it. A read that fails or
// runs out of pages first leaves `unknown` set, never an empty list.
export async function secondRejectionWaits(items, project, readPage) {
  const open = new Map((items ?? []).filter(i => i.state === "submitted" && i.head).map(i => [i.id, i]));
  const waits = [];
  if (!open.size) return { waits, unknown: false };
  let before;
  for (let pages = 0; pages < NOTICE_PAGES; pages++) {
    let page;
    try { page = await readPage(before); } catch { return { waits, unknown: true }; }
    if (!Array.isArray(page?.events)) return { waits, unknown: true };
    for (const e of page.events) {
      const item = open.get(e.itemId);
      if (!item) continue;
      if (e.kind === "item.second_rejection_notice") {
        open.delete(item.id);
        if (e.data?.head === item.head) waits.push({ id: item.id, head: item.head, reason: `second rejection at ${String(item.head).slice(0, 8)}, nothing dispatched`, command: `atelier dispatch ${item.id} --project ${project}` });
      } else if (e.kind === "item.dispatched" || e.kind === "item.undispatched") open.delete(item.id);
    }
    if (!open.size) return { waits, unknown: false };
    if (page.next === null || page.next === undefined) return { waits, unknown: false };
    before = page.next;
  }
  return { waits, unknown: true };
}

export const secondRejectionUnknown = "second-rejection waits unknown: the project's events could not be read";
