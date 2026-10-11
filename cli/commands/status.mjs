// atelier status. Its forms, flags and help are declared in src/usage/commands/status.ts.
import { formatLocal, formatPolicyDisagreements, formatStatus, formatStatusBrief, projectInbox, statusJson } from "../status.mjs";
import { formatStrays } from "../strays.mjs";
import { formatSlots, slotStatus } from "../load.mjs";
import { OWNER, OWNER_NAME, P, actor, args, call, cfg, checkoutStatus, die, formatStanding, landingLease, localStanding, localStrays, liveHere, liveText, pointToGuide, project, registeredHere, request, server, tokenExpiryWarningsText, wsConfig } from "../atelier.mjs";

import { readInstructions } from "../review-notice.mjs";
import { reviewDisagreements } from "../../src/review-notice.ts";

// The owner's queue: decisions waiting, tasks in progress, tasks waiting for a runner.
export default async function statusCommand() {
  if (args.brief) {
    const name = args.project ?? wsConfig("project") ?? registeredHere().name;
    if (!name) die("--brief reports on one project: add --project NAME");
    const as = await actor(OWNER);
    // What cannot be read is said in the brief, not fatal to it.
    const soft = (promise) => promise.catch(() => null);
    const [standing, version, queue, usage, lease] = await Promise.all([
      call("GET", `${P(name)}/standing`, undefined, as),
      soft(fetch(server() + "/api/version").then((r) => (r.ok ? r.json() : null))),
      soft(request("GET", "/queue", undefined, as)),
      soft(request("GET", "/usage", undefined, as)),
      landingLease(name, as),
    ]);
    const text = formatStatusBrief({ standing, version, queue, lease, usage });
    if (args.json) return console.log(JSON.stringify({ brief: text.split("\n") }, null, 2));
    console.log(text);
    pointToGuide([name]);
    return;
  }
  if (args.project !== undefined) {
    const name = args.project;
    const as = await actor(OWNER);
    const standing = await call("GET", `${P(name)}/standing`, undefined, as);
    const checkout = await checkoutStatus(name, as);
    const local = await localStanding(name, as);
    const live = liveHere(name);
    const path = cfg.projects?.[name]?.path;
    const instructions = path ? readInstructions(path) : [];
    const record = instructions.length ? await request("GET", P(name), undefined, as).catch(() => null) : null;
    const mismatches = record?.project?.policy ? reviewDisagreements(record.project.policy, instructions) : [];
    const testSlots = await slotStatus();
    const strays = localStrays();
    if (args.json) return console.log(JSON.stringify({ project: standing, checkout, testSlots, processes: live, ...(mismatches.length ? { mismatches } : {}), ...(local ? { local } : {}), ...(strays.length ? { strayTests: strays } : {}) }, null, 2));
    console.log(tokenExpiryWarningsText(formatStanding(standing, OWNER_NAME, server()) + "\n\n" + checkout + (local ? "\n\n" + formatLocal(local) : "") + (strays.length ? "\n\n" + formatStrays(strays) : "") + (mismatches.length ? "\n\n" + formatPolicyDisagreements(mismatches) : "") + "\n\n" + formatSlots(testSlots) + "\n\n" + liveText(live)));
    pointToGuide([name]);
    return;
  }
  const known = await call("GET", "/projects", undefined, OWNER);
  const chosen = known;
  // A project whose notices the server could not read is passed as not read
  // (projectInbox), so the listing says so instead of the read failing.
  const notices = await request("GET", "/inbox?unread=1", undefined, OWNER).catch(() => null);
  // The runner queue and the offers each runner last asked with, so the
  // waiting section can say when a queued job — a review routed to a model
  // no live runner offers, say — can never be claimed, not merely waits
  // (t240), and the Runners section can list what each offers (t246).
  // Either read failing leaves the listing as it was.
  const [queue, offers] = await Promise.all([
    request("GET", "/queue", undefined, OWNER).catch(() => null),
    request("GET", "/runners", undefined, OWNER).catch(() => null),
  ]);
  // A project whose tasks cannot be read is listed as not read (null items),
  // as `atelier inbox` lists it, and the others are still shown.
  const views = await Promise.all(chosen.map(async (p) => {
    const read = await request("GET", P(p.name), undefined, OWNER).catch(() => null);
    // Where the project's recorded policy and its instructions disagree (t422).
    const path = cfg.projects?.[p.name]?.path;
    const mismatches = read?.project?.policy && path ? reviewDisagreements(read.project.policy, readInstructions(path)) : [];
    // The policy comes along so the listing can say a project runs in
    // single-family mode (formatStatus).
    return { name: p.name, title: p.title, items: Array.isArray(read?.items) ? read.items : null, inbox: projectInbox(notices, p.name), mismatches, policy: p.policy ?? null };
  }));
  if (args.json) return console.log(JSON.stringify(statusJson(views, server(), Array.isArray(offers) ? offers : null), null, 2));
  const strays = formatStrays(localStrays());
  console.log(tokenExpiryWarningsText(formatStatus(views, { queue, offers, server: server() }) + (strays ? "\n\n" + strays : "")));
  console.log(liveText(liveHere()));
  console.log(formatSlots(await slotStatus()));
  pointToGuide(chosen.map((p) => p.name));
}
