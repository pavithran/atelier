// atelier show. Its forms, flags and help are declared in src/usage/commands/show.ts.
import { I, OWNER, RequestError, actor, args, call, die, formatBrief, formatReviews, itemArg, newestReviews, project, request, server } from "../atelier.mjs";

export default async function showCommand() {
  const name = project(), id = itemArg(), as = await actor(OWNER);
  const brief = await call("GET", `${I(name, id)}/brief`, undefined, as);
  // The brief sums the reviews at the current head into one line and carries
  // none of their findings. The item's own record holds every review at
  // every head; --reviews prints it in full and --json carries it, so a
  // session can read why a review rejected the task (t173).
  let d = {};
  try { d = await request("GET", I(name, id), undefined, as); }
  catch (error) {
    // Older servers may serve the brief without the detail route. Keep
    // that brief usable, but do not conceal authentication or server errors.
    if (!(error instanceof RequestError)) throw error;
    if (error.code !== 1 || error.message !== "not_found: no such route") die(error.message, error.code);
  }
  // Revert requests are historical links, not proof that the undo merged.
  // Keep them outside the server brief's five-line evidence limit.
  for (const event of d.events ?? []) {
    if (event.itemId !== id || !["item.reverts", "item.revert_requested"].includes(event.kind)) continue;
    const { itemId, mergeCommit } = event.data ?? {};
    if (!/^t[1-9]\d*$/.test(itemId ?? "") || !/^[a-f0-9]{40,64}$/.test(mergeCommit ?? "")) continue;
    const label = event.kind === "item.reverts" ? "Reverts" : "Revert requested in";
    brief.evidence.push(`${label} ${itemId} (recorded merge ${mergeCommit}): ${server()}/p/${encodeURIComponent(name)}/${itemId}`);
  }
  if (args.json) return console.log(JSON.stringify({ ...brief, reviews: newestReviews(d?.reviews ?? []), unparsable: newestReviews(d?.unparsable ?? []) }, null, 2));
  const text = formatBrief(name, id, brief, server());
  console.log(args.reviews ? `${text}\n\n${formatReviews(d?.reviews ?? [], d?.ownerActor, d?.unparsable ?? [])}` : text);
}
