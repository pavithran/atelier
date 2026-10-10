// atelier status. Its forms, flags and help are declared in src/usage/commands/status.ts.
import { formatLocal, formatStatus, formatStatusBrief, statusJson } from "../status.mjs";
import { formatStrays } from "../strays.mjs";
import { OWNER, OWNER_NAME, P, actor, args, call, checkoutStatus, die, formatStanding, landingLease, localStanding, localStrays, pointToGuide, project, registeredHere, request, server, tokenExpiryWarningsText, wsConfig } from "../atelier.mjs";

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
    const strays = localStrays();
    if (args.json) return console.log(JSON.stringify({ project: standing, checkout, ...(local ? { local } : {}), ...(strays.length ? { strayTests: strays } : {}) }, null, 2));
    console.log(tokenExpiryWarningsText(formatStanding(standing, OWNER_NAME, server()) + "\n\n" + checkout + (local ? "\n\n" + formatLocal(local) : "") + (strays.length ? "\n\n" + formatStrays(strays) : "")));
    pointToGuide([name]);
    return;
  }
  const known = await call("GET", "/projects", undefined, OWNER);
  const chosen = known;
  const inbox = await call("GET", "/inbox", undefined, OWNER);
  // The runner queue and the offers each runner last asked with, so the
  // waiting section can say when a queued job — a review routed to a model
  // no live runner offers, say — can never be claimed, not merely waits
  // (t240), and the Runners section can list what each offers (t246).
  // Either read failing leaves the listing as it was.
  const [queue, offers] = await Promise.all([
    request("GET", "/queue", undefined, OWNER).catch(() => null),
    request("GET", "/runners", undefined, OWNER).catch(() => null),
  ]);
  const views = await Promise.all(chosen.map(async (p) => {
    const { items } = await call("GET", P(p.name), undefined, OWNER);
    return { name: p.name, title: p.title, items, inbox };
  }));
  if (args.json) return console.log(JSON.stringify(statusJson(views, server()), null, 2));
  const strays = formatStrays(localStrays());
  console.log(tokenExpiryWarningsText(formatStatus(views, { queue, offers, server: server() }) + (strays ? "\n\n" + strays : "")));
  pointToGuide(chosen.map((p) => p.name));
}
