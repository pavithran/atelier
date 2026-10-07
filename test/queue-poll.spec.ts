import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { coreHold, OFFER_LIVE_MS, OFFER_REFRESH_MS, type RunnerOffer } from "../src/dispatch/rules.ts";

// The cost of a runner's poll of POST /queue (t277): the runner's offer is
// rewritten on the index only when it changed or once OFFER_REFRESH_MS has
// passed (askQueue in src/ledger.ts), each project is read in one call
// (queued), and the route says where its time went in a server-timing header.

const TOKEN = "queue-poll-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const A = "codex/gpt-6-astra";
const H0 = "0".repeat(40);
const H1 = "a".repeat(40);

function call(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

const seenAt = async (runner: string) => (await index().runnerOffers()).find((o) => o.runner === runner)?.at;

it("an unchanged offer is rewritten at most once per refresh window, a changed one at once", async () => {
  const offer: RunnerOffer = { runner: "home:steady", kind: "home", jobs: [], agents: [{ agent: "opencode", models: ["glm-5.3"] }] };
  const t0 = Date.parse("2026-10-07T12:00:00.000Z");
  const at = (ms: number) => new Date(t0 + ms).toISOString();
  await index().askQueue(offer, at(0));
  expect(await seenAt(offer.runner)).toBe(at(0));
  // Polls within the window leave the row as it was.
  await index().askQueue(offer, at(30_000));
  await index().askQueue(offer, at(OFFER_REFRESH_MS - 1));
  expect(await seenAt(offer.runner)).toBe(at(0));
  // Once the window has passed, the next poll refreshes when it last asked.
  await index().askQueue(offer, at(OFFER_REFRESH_MS));
  expect(await seenAt(offer.runner)).toBe(at(OFFER_REFRESH_MS));
  // A changed offer is written at once, inside the window.
  const more = { ...offer, jobs: ["review"] };
  await index().askQueue(more, at(OFFER_REFRESH_MS + 1000));
  expect((await index().runnerOffers()).find((o) => o.runner === offer.runner)).toEqual({ ...more, at: at(OFFER_REFRESH_MS + 1000) });
  // An ask with no offer (the owner's GET) writes nothing.
  await index().askQueue(null, at(OFFER_LIVE_MS));
  expect(await seenAt(offer.runner)).toBe(at(OFFER_REFRESH_MS + 1000));
  // The window is far inside the time an offer stays live.
  expect(OFFER_REFRESH_MS * 10).toBeLessThan(OFFER_LIVE_MS);
});

it("a runner polling the queue twice with the same offer is recorded once, and the poll reports its timing", async () => {
  const offer = { runner: "home:twice", agents: [{ agent: "opencode", models: ["glm-5.3"] }] };
  const first = await call("POST", "/queue", offer);
  expect(first.status, await first.clone().text()).toBe(200);
  expect(first.headers.get("server-timing")).toMatch(/^index;dur=\d+, projects;dur=\d+;desc="\d+", total;dur=\d+$/);
  const recorded = await seenAt("home:twice");
  expect(recorded).toBeDefined();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await call("POST", "/queue", offer);
  expect(second.status).toBe(200);
  expect(await seenAt("home:twice")).toBe(recorded);
  // A changed offer is recorded on the next poll.
  await call("POST", "/queue", { ...offer, jobs: ["review"] });
  expect((await index().runnerOffers()).find((o) => o.runner === "home:twice")?.jobs).toEqual(["review"]);
});

it("queued reads the waiting tasks, their push actors and their core-file holds as the whole item list says", async () => {
  const name = "queue-poll-holds";
  const coreFiles = ["src/ledger.ts"];
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [], coreFiles }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, "owner");
  await index().registerProject(record);
  // A live item holding the core file, and one merged that holds nothing.
  const live = await L.newItem("Live work", ["src/**"], "owner");
  await L.claim(live.id, A);
  await L.setFork(live.id, `${name}--${live.id}`, H0, A);
  // Dispatched tasks: one the live item holds, one elsewhere, and one that
  // was claimed, pushed to and released, so it carries push actors.
  const held = await L.newItem("Core edit", ["src/ledger.ts"], "owner");
  const free = await L.newItem("Elsewhere", ["docs/**"], "owner");
  const pushed = await L.newItem("Pushed then released", ["docs/a.md"], "owner");
  for (const id of [held.id, free.id, pushed.id]) await L.dispatch(id, "owner", { to: "home", agent: "opencode" });
  await L.claim(pushed.id, "opencode/glm-5.3", { runner: "home:studio", kind: "home" });
  await L.setFork(pushed.id, `${name}--${pushed.id}`, H0, "opencode/glm-5.3");
  await L.recordPush(pushed.id, "opencode/glm-5.3", H1, H1);
  await L.release(pushed.id, "opencode/glm-5.3", "handing back");

  const items = await L.items();
  const expected = items
    .filter((i) => i.state === "open" && !i.owner && i.dispatch)
    .sort((a, b) => a.dispatch!.at.localeCompare(b.dispatch!.at))
    .map((i) => { const h = coreHold(i, items, coreFiles); return h ? { ...i, held: h } : i; });
  const { waiting, reviews } = await L.queued();
  expect(waiting).toEqual(expected);
  expect(reviews).toEqual([]);
  expect(waiting.map((i) => i.id)).toEqual([held.id, free.id, pushed.id]);
  expect(waiting.find((i) => i.id === held.id)?.held).toMatchObject({ id: live.id, core: "src/ledger.ts" });
  expect(waiting.find((i) => i.id === pushed.id)?.pushActors).toContain("opencode/glm-5.3");
});
