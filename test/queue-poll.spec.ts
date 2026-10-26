import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
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
    .map((i) => {
      const h = coreHold(i, items, coreFiles);
      return h ? { ...i, held: { ...h, blockers: [h], chains: [{ path: [i.id, h.id], deadlock: false }], since: expect.any(String), elapsedMs: expect.any(Number), warning: false } } : i;
    });
  const { waiting, reviews } = await L.queued();
  expect(waiting).toEqual(expected);
  expect(reviews).toEqual([]);
  expect(waiting.map((i) => i.id)).toEqual([held.id, free.id, pushed.id]);
  expect(waiting.find((i) => i.id === held.id)?.held).toMatchObject({ id: live.id, core: "src/ledger.ts" });
  expect(waiting.find((i) => i.id === pushed.id)?.pushActors).toContain("opencode/glm-5.3");
});

it("the queue attaches, in words, why a dispatch is held, refused an overlap or not taken", async () => {
  const name = "queue-why";
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [], coreFiles: ["src/ledger.ts"], refuseOverlap: true }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, "owner");
  await index().registerProject(record);
  // One live item both reaches the core file and overlaps the dispatched scope.
  const live = await L.newItem("Live work", ["src/**"], "owner");
  // A task the core file holds and the policy refuses; one the policy refuses
  // alone (its scope overlaps but reaches no core file); one neither holds.
  const held = await L.newItem("Core edit", ["src/ledger.ts"], "owner");
  const refused = await L.newItem("Also src", ["src/index.ts"], "owner");
  const free = await L.newItem("Docs", ["docs/**"], "owner");
  // Dispatched before the live item is claimed: a dispatch made after it
  // would itself be refused (t405), so the overlap arises only this way.
  for (const id of [held.id, refused.id, free.id]) await L.dispatch(id, "owner", { to: "home", agent: "opencode" });
  await L.claim(live.id, A);
  await L.setFork(live.id, `${name}--${live.id}`, H0, A);
  // A live runner offers opencode, and has failed the free task twice; a
  // fourth task names a model no live runner offers.
  const now = new Date().toISOString();
  await index().putRunnerOffer({ runner: "home:why", kind: "home", agents: [{ agent: "opencode", models: ["glm-5.3"] }] }, now);
  // Reported in the same instant: the newer report is still the last named.
  for (const outcome of ["stalled", "timed-out"] as const) {
    await index().putRun({ actor: "opencode/glm-5.3", role: "build", outcome, project: name, item: free.id, detail: "", runner: "home:why", at: now });
  }
  const nobody = await L.newItem("Elsewhere", ["video/**"], "owner");
  await L.dispatch(nobody.id, "owner", { to: "home", agent: "codex", model: "gpt-6" });

  const { waiting } = await L.queued();
  const byId = new Map(waiting.map((i) => [i.id, i]));
  expect(byId.get(held.id)?.held).toMatchObject({ id: live.id, core: "src/ledger.ts" });
  expect(byId.get(held.id)?.overlap).toMatchObject({ id: live.id });
  expect(byId.get(refused.id)?.held).toBeUndefined();
  expect(byId.get(refused.id)?.overlap).toMatchObject({ id: live.id });
  expect(byId.get(free.id)?.held).toBeUndefined();
  expect(byId.get(free.id)?.overlap).toBeUndefined();

  // The owner's GET carries the reasons in words, ready for status and show.
  const all = await (await call("GET", "/queue")).json() as { project: string; item: { id: string; why?: { kind: string; line: string }[] } }[];
  const kinds = (id: string) => (all.find((q) => q.project === name && q.item.id === id)?.item.why ?? []).map((r) => r.kind);
  expect(kinds(held.id)).toContain("held");
  expect(kinds(held.id)).toContain("overlap");
  expect(kinds(refused.id)).toContain("overlap");
  expect(kinds(refused.id)).not.toContain("held");
  expect(kinds(free.id)).not.toContain("held");
  expect(kinds(free.id)).not.toContain("overlap");
  expect(kinds(free.id)).toEqual(["skipped"]);
  expect(kinds(nobody.id)).toEqual(["unoffered"]);
  const line = (id: string, kind: string) => (all.find((q) => q.project === name && q.item.id === id)?.item.why ?? []).find((r) => r.kind === kind)?.line ?? "";
  expect(line(free.id, "skipped")).toBe(`Skipped by home:why after 2 failed runs under this dispatch (the last timed-out); that runner passes it by until it is dispatched again, it has a new head or the runner restarts: fix the cause, then atelier dispatch ${free.id} --to home --agent opencode.`);
  expect(line(nobody.id, "unoffered")).toMatch(new RegExp(`^No live runner can take it: .*atelier dispatch ${nobody.id} --agent H --model M`));
  expect(line(refused.id, "overlap")).toMatch(new RegExp(`^Overlap refused: ${live.id} \\(claimed by ${A}\\) holds a scope`));
  const heldLine = (all.find((q) => q.project === name && q.item.id === held.id)?.item.why ?? []).find((r) => r.kind === "held")?.line ?? "";
  expect(heldLine).toMatch(/^Held: waits on .*; offered once .* submits or is released, or at once with atelier dispatch .* --overlap-ok\.$/);

  // A runner on the owner's token names itself; its refused claim is kept
  // with the refusal's own code and words.
  const claim = await worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${refused.id}/claim`, {
    method: "POST", body: "{}",
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "opencode/glm-5.3", "x-atelier-runner": "home:why", "content-type": "application/json" },
  }), testEnv);
  expect(claim.status).toBeGreaterThanOrEqual(400);
  const { error, detail } = await claim.json() as { error: string; detail: string };
  const after = await (await call("GET", "/queue")).json() as typeof all;
  const refusedLine = (after.find((q) => q.project === name && q.item.id === refused.id)?.item.why ?? []).find((r) => r.kind === "refused")?.line ?? "";
  expect(refusedLine).toBe(`Claim refused: home:why claimed it as opencode/glm-5.3 and was refused (${error}: ${detail.slice(0, 300)}); that runner passes it by until it changes, so once that is fixed, dispatch it again with atelier dispatch ${refused.id} --to home --agent opencode.`);
});

// The queue's overlap reason is the claim's own test (overlappingLive): an
// accepted item still holds its scope, so the queue names it where the claim
// refuses, and an item the dispatch's claimant already holds refuses neither.
it("the queue's overlap reason refuses exactly where the claim does, accepted items and the claimant's own included", async () => {
  const name = "queue-why-accepted";
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [], refuseOverlap: true }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, "owner");
  await index().registerProject(record);
  const live = await L.newItem("Accepted work", ["src/**"], "owner");
  const other = await L.newItem("Also src", ["src/index.ts"], "owner");
  const own = await L.newItem("Same claimant", ["src/rules.ts"], "owner");
  await L.dispatch(other.id, "owner", { to: "home", agent: "opencode" });
  await L.dispatch(own.id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  await L.claim(live.id, A);
  await runInDurableObject(L, async (_instance, state) => {
    state.storage.sql.exec("UPDATE items SET state = 'accepted' WHERE id = ?", live.id);
  });
  const { waiting } = await L.queued();
  const byId = new Map(waiting.map((i) => [i.id, i]));
  expect(byId.get(other.id)?.overlap).toMatchObject({ id: live.id, state: "accepted" });
  // The claim refuses it as the queue said.
  const refusal = await L.claim(other.id, "opencode/glm-5.3", { runner: "home:why", kind: "home" }).then(() => null, (e: unknown) => String((e as Error).message));
  expect(refusal).toMatch(/overlap\|.*overlaps live/);
  // The claimant that holds the accepted item is not refused against it.
  expect(byId.get(own.id)?.overlap).toBeUndefined();
  await expect(L.claim(own.id, A, { runner: "home:why", kind: "home" })).resolves.toMatchObject({ item: { id: own.id, owner: A } });
});
