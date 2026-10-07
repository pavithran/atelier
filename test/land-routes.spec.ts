import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { ROUTE_LEVEL } from "../src/route-level.ts";
import { LANDING_LEASE_EXPIRY_MS } from "../src/landing-lease.ts";
import type { Ledger, LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { parseRuleError, type Evidence, type ProjectPolicy } from "../src/rules.ts";

// The server side of atelier land (t187): the project's landing lease on the
// Ledger (one landing at a time, refused with who holds it and since when, a
// closed task's lease no longer guards anything, a lease the holder stops
// renewing lapses and is taken over, t214), the review request for an
// ordinary task outside a plan (routed to a named reviewer or picked from the
// pool, claimable, answered by a verdict), the land.* events that record
// each step's duration for the integration record (t186), and GET /api/version
// answering without a token, since the commit of a public repository and a
// route level are not secret and a session checks them before it signs in.

const H0 = "0".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra";
const policy: ProjectPolicy = { checks: ["npm test"], protected: ["src/**"] };

const AT = "2026-10-06T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex")];

function ledger(project: string) {
  return env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
}

async function setup(project: string, protect = policy) {
  const L = ledger(project);
  await L.setProject({ name: project, repo: `${project}--baseline`, policy: protect, createdAt: new Date().toISOString() }, "owner");
  return L;
}

type L = ReturnType<typeof ledger>;

async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code, err.message).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

const events = async (L: L, id?: string) => (await L.events(id)) as unknown as LedgerEvent[];

// A claimed, pushed, checked and submitted task whose change touches a
// protected path (or the paths given), so the gate needs an independent
// review of it unless they are not protected.
async function submittedTask(L: L, id: string, head: string, changedPaths = ["src/land.ts"]) {
  await L.claim(id, OPUS, RUNNER);
  await L.setFork(id, `fork-${id}`, H0, OPUS);
  await L.recordPush(id, OPUS, head, head);
  await L.addEvidence({
    itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths,
  } satisfies Evidence);
  await L.submit(id, OPUS);
}

it("the project's landing lease holds one landing, names who holds it and since when, and lets a closed task's lease go", async () => {
  const L = await setup("land-lease");
  const a = (await L.newItem("First", [], "owner")).id;
  const b = (await L.newItem("Second", [], "owner")).id;
  await L.beginProjectLanding(a, "owner");
  const held = await L.readProjectLanding();
  expect(held).toMatchObject({ item: a, holder: "owner" });
  expect(Date.parse(held!.at)).toBeGreaterThan(0);
  await refusal(L.beginProjectLanding(b, "owner"), "landing_lease", new RegExp(`^owner has been landing ${a} since \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC; one landing runs at a time`));
  // The same task takes its own lease again, to resume after a stop.
  await L.beginProjectLanding(a, "owner");
  await L.cancelProjectLanding(a, "owner");
  await L.beginProjectLanding(b, "owner");
  // A lease whose task has closed no longer guards anything.
  await L.abandon(b, "owner", "not wanted", null);
  await L.beginProjectLanding(a, "owner");
  await refusal(L.beginProjectLanding(a, "someone"), "not_project_owner", /only the project owner lands/);
  await refusal(L.beginProjectLanding("t99", "owner"), "no_item", /no item t99/);
});

it("a lease lapses when not renewed for the expiry: the holder renews it, the next landing takes a lapsed one over and is told whose, and a cancel says which task held it", async () => {
  const L = await setup("land-lease-expiry");
  const a = (await L.newItem("First", [], "owner")).id;
  const b = (await L.newItem("Second", [], "owner")).id;
  const taken = await L.beginProjectLanding(a, "owner");
  expect(taken.expired).toBeNull();
  const held = (await L.readProjectLanding())!;
  expect(held.renewedAt).toBe(held.at);
  // The renewal moves renewedAt on and nothing else; only the holder's task renews.
  const renewed = await L.renewProjectLanding(a, "owner");
  expect(renewed).toMatchObject({ item: a, holder: "owner", at: held.at });
  expect(Date.parse(renewed.renewedAt!)).toBeGreaterThanOrEqual(Date.parse(held.at));
  await refusal(L.renewProjectLanding(b, "owner"), "no_lease", new RegExp(`held for ${a}, not ${b}`));
  await refusal(L.renewProjectLanding(a, "someone"), "not_project_owner", /only the project owner lands/);
  // Renewed within the expiry, the lease still refuses another landing.
  const stale = new Date(Date.now() - LANDING_LEASE_EXPIRY_MS + 60_000).toISOString();
  await runInDurableObject(L, async (_instance: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = 'landing-lease'`, JSON.stringify({ item: a, holder: "owner", at: held.at, renewedAt: stale }));
  });
  await refusal(L.beginProjectLanding(b, "owner"), "landing_lease", new RegExp(`has been landing ${a} since .*atelier land ${a} --release-lease`));
  // Not renewed for the expiry, it lapses: the next landing takes it over
  // and is told whose lease lapsed.
  const lapsed = new Date(Date.now() - LANDING_LEASE_EXPIRY_MS).toISOString();
  await runInDurableObject(L, async (_instance: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = 'landing-lease'`, JSON.stringify({ item: a, holder: "owner", at: held.at, renewedAt: lapsed }));
  });
  const over = await L.beginProjectLanding(b, "owner");
  expect(over.expired).toMatchObject({ item: a, holder: "owner", at: held.at, renewedAt: lapsed });
  expect((await L.readProjectLanding())!).toMatchObject({ item: b });
  // A lapsed lease can no longer be renewed by the task that lost it.
  await refusal(L.renewProjectLanding(a, "owner"), "no_lease", new RegExp(`held for ${b}, not ${a}`));
  // A cancel from the landing that lost the lease, or aimed at it, leaves
  // the lease that took it over, naming whose it is; a cancel naming no
  // task is refused.
  await refusal(L.cancelProjectLanding(a, "owner"), "landing_lease", new RegExp(`^the landing lease is held for ${b}, not ${a}: owner has been landing ${b} since .*atelier land ${b} --release-lease`));
  await refusal(L.cancelProjectLanding("", "owner"), "bad_item", /names the task whose landing lease it releases/);
  expect((await L.readProjectLanding())!).toMatchObject({ item: b });
  // The cancel for the holder answers which task held the lease since when;
  // a second one, nothing.
  const cancelled = await L.cancelProjectLanding(b, "owner");
  expect(cancelled.held).toBe(true);
  expect(cancelled.lease).toMatchObject({ item: b, holder: "owner" });
  expect(await L.cancelProjectLanding(b, "owner")).toEqual({ held: false, lease: null });
  await refusal(L.renewProjectLanding(b, "owner"), "no_lease", /no landing lease is held/);
});

it("the lease is handed to the waiting landings in the order they queued, and a waiting landing that stops asking or has closed its task no longer counts (t249)", async () => {
  const L = await setup("land-lease-queue");
  const a = (await L.newItem("First", [], "owner")).id;
  const b = (await L.newItem("Second", [], "owner")).id;
  const c = (await L.newItem("Third", [], "owner")).id;
  await L.beginProjectLanding(a, "owner");
  // b queues, then c: the server keeps them in that order, one row each.
  const bQueued = await L.queueProjectLanding(b, "owner");
  expect(bQueued.waiting).toHaveLength(1);
  expect(bQueued.waiting[0]).toMatchObject({ item: b, holder: "owner" });
  const bAt = bQueued.waiting[0].at;
  await L.queueProjectLanding(c, "owner");
  const rows = await L.readLandingQueue();
  expect(rows.map((w) => w.item)).toEqual([b, c]);
  // An ask never takes: the lease stays a's, and the ask answers it.
  expect(bQueued.lease).toMatchObject({ item: a });
  expect((await L.queueProjectLanding(b, "owner")).lease).toMatchObject({ item: a });
  // Asking again refreshes the place, not the turn: b keeps the first row
  // and its queued time, only its last ask moves on.
  const refreshed = await L.readLandingQueue();
  expect(refreshed[0]).toMatchObject({ item: b, at: bAt });
  expect(Date.parse(refreshed[0].renewedAt!)).toBeGreaterThanOrEqual(Date.parse(bAt));
  // The lease frees; c's take lands first, however the polls land, and is
  // refused naming b, which queued first (c's own row is not in its way).
  await L.cancelProjectLanding(a, "owner");
  await refusal(L.beginProjectLanding(c, "owner"), "landing_lease", new RegExp(`^owner's landing of ${b} has been waiting for the lease since \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC, first of 1 landing queued for it; landings take the lease in the order they queued, so ${c} cannot take it ahead of them$`));
  // A landing without a wait behind it cannot jump the queue either.
  const d = (await L.newItem("Fourth", [], "owner")).id;
  await refusal(L.beginProjectLanding(d, "owner"), "landing_lease", new RegExp(`^owner's landing of ${b} has been waiting for the lease since .*first of 2 landings queued for it`));
  // b, first in the queue, takes it; its row leaves with the take and c stays.
  await L.beginProjectLanding(b, "owner");
  expect((await L.readLandingQueue()).map((w) => w.item)).toEqual([c]);
  expect((await L.readProjectLanding())!).toMatchObject({ item: b });
  // A waiting landing gives its place up: leave drops its row, so the next
  // take is not queued past it.
  await L.cancelProjectLanding(b, "owner");
  await L.queueProjectLanding(c, "owner", true);
  expect(await L.readLandingQueue()).toEqual([]);
  await L.beginProjectLanding(d, "owner");
  // A row whose landing stopped asking for the expiry no longer counts.
  await L.cancelProjectLanding(d, "owner");
  await L.queueProjectLanding(c, "owner");
  const freshRows = await L.readLandingQueue();
  const stale = new Date(Date.now() - LANDING_LEASE_EXPIRY_MS).toISOString();
  await runInDurableObject(L, async (_instance: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('landing-queue', ?)`, JSON.stringify(freshRows.map((w) => ({ ...w, renewedAt: stale }))));
  });
  await L.beginProjectLanding(d, "owner");
  expect(await L.readLandingQueue()).toEqual([]);
  // A row whose task has closed no longer counts either: its landing can
  // never take the lease.
  await L.cancelProjectLanding(d, "owner");
  await L.queueProjectLanding(c, "owner");
  await L.abandon(c, "owner", "not wanted", null);
  expect(await L.readLandingQueue()).toEqual([]);
  await refusal(L.queueProjectLanding("t99", "owner"), "no_item", /no item t99/);
  await refusal(L.queueProjectLanding(b, "someone"), "not_project_owner", /only the project owner lands/);
});

it("the landing-lease route takes, renews and cancels the lease for the owner, and a waiting landing asks and leaves through it", async () => {
  const project = "land-lease-route";
  const L = await setup(project);
  const a = (await L.newItem("First", [], "owner")).id;
  const b = (await L.newItem("Second", [], "owner")).id;
  const token = { ...env, ATELIER_TOKEN: "land-routes-token" } as typeof env;
  const post = (body: Record<string, unknown>) => worker.fetch(new Request(`https://atelier.test/api/projects/${project}/landing-lease`, {
    method: "POST", headers: { authorization: "Bearer land-routes-token", "content-type": "application/json", "x-atelier-actor": "owner" }, body: JSON.stringify(body),
  }), token);
  const took = await post({ item: a });
  expect(took.status).toBe(200);
  expect(await took.json()).toMatchObject({ item: { id: a }, expired: null });
  const renewed = await post({ item: a, renew: true });
  expect(renewed.status).toBe(200);
  expect(await renewed.json()).toMatchObject({ lease: { item: a, holder: "owner" } });
  // A waiting landing's ask answers the lease and the queue as the server
  // sees them, refreshing its place; a leave gives the place up.
  const asked = await post({ item: b, queued: true });
  expect(asked.status).toBe(200);
  expect(await asked.json()).toMatchObject({ lease: { item: a }, waiting: [{ item: b, holder: "owner" }] });
  const left = await post({ item: b, queued: true, leave: true });
  expect(await left.json()).toMatchObject({ lease: { item: a }, waiting: [] });
  expect(await L.readLandingQueue()).toEqual([]);
  const other = await post({ cancel: true, item: "t99" });
  expect(other.status).toBe(409);
  expect(await L.readProjectLanding()).toMatchObject({ item: a });
  const cancelled = await post({ cancel: true, item: a });
  expect(await cancelled.json()).toMatchObject({ held: true, lease: { item: a } });
  expect(await L.readProjectLanding()).toBeNull();
});

it("a merge is refused while another task's landing holds the project's lease, and goes on once the lease no longer guards it (t232)", async () => {
  const L = await setup("land-merge-race");
  const a = (await L.newItem("Landing", [], "owner")).id;
  const b = (await L.newItem("Beside it", [], "owner")).id;
  const aHead = "9".repeat(40), bHead = "e".repeat(40);
  await submittedTask(L, a, aHead, ["docs/a.md"]);
  await submittedTask(L, b, bHead, ["docs/b.md"]);
  await L.accept(a, "owner", aHead);
  await L.accept(b, "owner", bHead);
  // With no landing in progress, a merge begins (and is set back here).
  await L.beginLanding(b, "owner", bHead);
  await L.cancelLanding(b, "owner");
  // a's landing holds the project's lease: b cannot merge beside it, and
  // b's acceptance stands untouched.
  await L.beginProjectLanding(a, "owner");
  await refusal(L.beginLanding(b, "owner", bHead), "landing_lease", new RegExp(`^owner has been landing ${a} since .*one landing runs at a time in this project, so ${b} cannot merge beside it.*then atelier merge ${b} again$`));
  expect(await L.item(b)).toMatchObject({ state: "accepted", acceptedHead: bHead });
  // The lease lapsed (a's landing slept, t232): it guards nothing, so the
  // merge goes on (and is set back here).
  const held = (await L.readProjectLanding())!;
  await runInDurableObject(L, async (_instance: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = 'landing-lease'`, JSON.stringify({ ...held, renewedAt: new Date(Date.now() - LANDING_LEASE_EXPIRY_MS).toISOString() }));
  });
  await L.beginLanding(b, "owner", bHead);
  await L.cancelLanding(b, "owner");
  // Renewed within the expiry again, the lease refuses b once more; the
  // task whose landing holds it merges under it, and once that task has
  // merged, the lease no longer guards anything and b's merge goes on.
  await L.beginProjectLanding(a, "owner");
  await refusal(L.beginLanding(b, "owner", bHead), "landing_lease", new RegExp(`has been landing ${a} since`));
  await L.beginLanding(a, "owner", aHead);
  expect(await L.merged(a, "owner", "f".repeat(40), true, aHead)).toMatchObject({ state: "merged" });
  await L.beginLanding(b, "owner", bHead);
  expect(await L.merged(b, "owner", "7".repeat(40), true, bHead)).toMatchObject({ state: "merged" });
});

it("a submitted task with a protected change gets a review request, named or picked, that a verdict answers", async () => {
  const L = await setup("land-review");
  const id = (await L.newItem("Landing", [], "owner")).id;
  const head = "a".repeat(40);
  await submittedTask(L, id, head);
  // With no pool to pick from, the owner names the reviewer.
  await refusal(L.requestReview(id, "owner", null, []), "no_reviewer", /no reviewer of another family/);
  const asked = await L.requestReview(id, "owner", GPT, POOL);
  expect(asked).toMatchObject({ needed: true, requested: true, reviewer: GPT, head });
  expect(asked.at).toBeTruthy();
  expect((await events(L, id)).find((e) => e.kind === "review.requested")).toMatchObject({ actor: "owner", data: { head, reviewer: GPT, via: "land" } });
  // The request is open in the queue, routed to the named reviewer.
  const [waiting] = await L.reviewWaiting();
  expect(waiting).toMatchObject({ id, dispatch: { job: "review", agent: "codex", model: "gpt-6-astra" } });
  // A contributor cannot be named; the owner alone asks.
  await refusal(L.requestReview(id, "owner", OPUS, POOL), "self_review", /contributed to/);
  await refusal(L.requestReview(id, OPUS, null, POOL), "not_project_owner", /only the project owner asks/);
  // A runner claims it: the claim carries the need as the gate reads it, with
  // no plan account, and a review at the head answers the request.
  const claim = await L.claimReview(id, GPT, RUNNER) as unknown as { head: string; need: { basis: string; changeClass: string }; plan: null };
  expect(claim.head).toBe(head);
  expect(claim.need).toMatchObject({ basis: "protected", changeClass: "protected" });
  expect(claim.plan).toBeNull();
  // Asking again while the request is live returns it as it stands, not duplicated.
  const again = await L.requestReview(id, "owner", null, POOL);
  expect(again).toMatchObject({ needed: true, requested: false, reviewer: GPT, head });
  // Naming another reviewer while that request stands is refused, not ignored.
  await refusal(L.requestReview(id, "owner", "antigravity/gemini-3.1-pro", POOL), "review_requested", /already requested from codex\/gpt-6-astra/);
  expect(await L.requestReview(id, "owner", GPT, POOL)).toMatchObject({ requested: false, reviewer: GPT });
  expect(await L.reviewWaiting()).toEqual([]);
  expect((await L.reviewRequests(id)).at(-1)).toMatchObject({ head, state: "claimed", claimedBy: GPT });
  await L.addReview({ itemId: id, by: GPT, head, approve: true, note: "Independently reviewed", at: new Date().toISOString() });
  expect(await L.reviewWaiting()).toEqual([]);
  // With the independent approval counted, no review is needed.
  const after = await L.requestReview(id, "owner", null, POOL);
  expect(after).toMatchObject({ needed: false });
  expect(after.reason).toMatch(/the gate already counts an independent approval/);
});

it("a wanted review is requested for the named reviewer though the gate needs none, and the gate's own refusals stand", async () => {
  const L = await setup("land-wanted");
  const id = (await L.newItem("Docs", [], "owner")).id;
  const head = "d".repeat(40);
  await submittedTask(L, id, head, ["docs/note.md"]);
  // The gate needs no review of a change outside the protected paths.
  expect(await L.requestReview(id, "owner", GPT, POOL)).toMatchObject({ needed: false, reason: expect.stringMatching(/needs no review/) });
  // A contributor, an invalid actor, an unnamed reviewer and a stranger are still refused.
  await refusal(L.requestReview(id, "owner", OPUS, POOL, true), "self_review", /contributed to/);
  await refusal(L.requestReview(id, "owner", "gpt model", POOL, true), "bad_actor", /is not harness\/model/);
  await refusal(L.requestReview(id, "owner", null, POOL, true), "bad_request", /names its reviewer/);
  await refusal(L.requestReview(id, OPUS, GPT, POOL, true), "not_project_owner", /only the project owner asks/);
  expect(await L.reviewWaiting()).toEqual([]);
  // Asked for, the review is requested for the named reviewer, once.
  const asked = await L.requestReview(id, "owner", GPT, POOL, true);
  expect(asked).toMatchObject({ needed: true, requested: true, reviewer: GPT, head });
  expect((await events(L, id)).find((e) => e.kind === "review.requested")).toMatchObject({ data: { head, reviewer: GPT, via: "land", wanted: true } });
  expect(await L.requestReview(id, "owner", GPT, POOL, true)).toMatchObject({ needed: true, requested: false, reviewer: GPT, head });
  // The reviewer's claim carries a need, so its runner reviews rather than releases the request.
  const claim = await L.claimReview(id, GPT, RUNNER) as unknown as { need: { basis: string } | null };
  expect(claim.need).toMatchObject({ basis: "requested" });
  // A rejection at this head stops the gate, and a wanted review is refused with that reason.
  await L.addReview({ itemId: id, by: GPT, head, approve: false, note: "Wrong.", findings: [{ file: "docs/note.md", line: 1, severity: "blocking" as const, text: "It is wrong." }], at: new Date().toISOString() });
  await refusal(L.requestReview(id, "owner", GPT, POOL, true), "review_blocked", /rejected dddddddd/);
  // t240: once the owner has refuted every blocking finding of that rejection,
  // the same head is asked for a second opinion rather than refused — no
  // cosmetic new commit is needed. The re-review goes to the same reviewer
  // first, as a round-2 review.
  await L.addFinding(id, "owner", head, 1, "refuted", "docs/note.md:4 already says it.");
  const again = await L.requestReview(id, "owner", GPT, POOL, true);
  expect(again).toMatchObject({ needed: true, requested: true, reviewer: GPT, head });
  expect((await events(L, id)).find((e) => e.kind === "review.requested")).toMatchObject({ data: { head, reviewer: GPT, round: 2, via: "land", wanted: true } });
});

it("after a review claim lapses and a new reviewer is asked, a retry naming that reviewer finds the new request", async () => {
  const L = await setup("land-lapse");
  const id = (await L.newItem("Landing", [], "owner")).id;
  const head = "c".repeat(40);
  await submittedTask(L, id, head);
  const GEMINI = "antigravity/gemini-3.1-pro";
  await L.requestReview(id, "owner", GPT, POOL);
  await L.claimReview(id, GPT, RUNNER);
  // The claim lapses: it was taken two days ago.
  await runInDurableObject(L, async (_instance: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE review_requests SET claimedAt = ? WHERE item = ?`, new Date(Date.now() - 2 * 86_400_000).toISOString(), id);
  });
  expect(await L.requestReview(id, "owner", GEMINI, POOL)).toMatchObject({ requested: true, reviewer: GEMINI });
  expect(await L.requestReview(id, "owner", GEMINI, POOL)).toMatchObject({ requested: false, reviewer: GEMINI, head });
  await refusal(L.requestReview(id, "owner", GPT, POOL), "review_requested", /already requested from antigravity\/gemini-3.1-pro/);
});

it("the landing's steps are recorded as land.* events with their duration, and anything else is refused", async () => {
  const L = await setup("land-events");
  const id = (await L.newItem("Landing", [], "owner")).id;
  await L.landEvent(id, "owner", "merge", 1200, { fromMain: ["b".repeat(40)], conflicts: ["src/x.ts"], resolvedBy: "the project owner, by hand" });
  await L.landEvent(id, "owner", "submit", 300, {});
  await L.landEvent(id, "owner", "review", 9000, { verdict: "approve", reviewer: GPT, resolvedBy: GPT });
  const recorded = (await events(L, id)).filter((e) => e.kind.startsWith("land.")).sort((a, b) => a.seq - b.seq);
  expect(recorded.map((e) => [e.kind, e.data.ms])).toEqual([["land.merge", 1200], ["land.submit", 300], ["land.review", 9000]]);
  expect(recorded[0].data).toMatchObject({ fromMain: ["b".repeat(40)], conflicts: ["src/x.ts"], resolvedBy: "the project owner, by hand" });
  await refusal(L.landEvent(id, "owner", "deploy", 5, {}), "bad_step", /is not a step of a landing/);
  await refusal(L.landEvent(id, "owner", "merge", -5, {}), "bad_ms", /duration in milliseconds/);
  await refusal(L.landEvent(id, "owner", "merge", 5, { nonsense: true }), "bad_field", /nonsense is not a field/);
  await refusal(L.landEvent(id, OPUS, "merge", 5, {}), "not_project_owner", /only the project owner records/);
});

it("GET /api/version answers without a token, and every other /api route still needs one", async () => {
  const noToken = { ...env, ATELIER_TOKEN: "land-routes-token" } as typeof env;
  const version = await worker.fetch(new Request("https://atelier.test/api/version"), noToken);
  expect(version.status).toBe(200);
  expect(await version.json()).toMatchObject({ routeLevel: ROUTE_LEVEL });
  expect((await worker.fetch(new Request("https://atelier.test/api/projects"), noToken)).status).toBe(401);
});

it("a landing's review request asks the review tier beside it, and the acceptance withdraws a tier review still open without waiting for it", async () => {
  const SOL = "codex/gpt-6.1-sol", SONNET = "claude-code/sonnet-5.5", GEMINI = "antigravity/gemini-3.1-pro";
  const L = await setup("land-tier", { ...policy, reviewTier: [OPUS, GPT, SONNET, SOL] });
  const id = (await L.newItem("Landing", [], "owner")).id;
  const head = "a".repeat(40);
  await submittedTask(L, id, head);
  const asked = await L.requestReview(id, "owner", GPT, POOL);
  expect(asked).toMatchObject({ requested: true, reviewer: GPT });
  // The builder (OPUS) and the gate's reviewer (GPT) are skipped; SONNET,
  // of the builder's family, is asked.
  expect((await L.reviewWaiting()).map((i) => `${i.dispatch!.agent}/${i.dispatch!.model}`)).toEqual([GPT, SONNET]);
  // Asking again returns the gate's request, not the tier's, and makes no second tier request.
  expect(await L.requestReview(id, "owner", null, POOL)).toMatchObject({ requested: false, reviewer: GPT });
  expect((await L.reviewRequests(id)).filter((r) => r.tier)).toHaveLength(1);
  // The tier review is claimed; the gate's approval comes in and the task is
  // accepted at once, without waiting for it: its request is withdrawn.
  await L.claimReview(id, SONNET, RUNNER);
  await L.claimReview(id, GPT, RUNNER);
  await L.addReview({ itemId: id, by: GPT, head, approve: true, note: "Gate: fine.", at: new Date().toISOString() });
  await L.accept(id, "owner", head);
  expect((await L.reviewRequests(id)).find((r) => r.tier)).toMatchObject({ state: "withdrawn" });
  expect((await events(L, id)).find((e) => e.kind === "review.withdrawn")).toMatchObject({ data: { reviewer: SONNET, tier: true } });
  // The tier verdict arriving late is refused and does not reopen the accepted task.
  await refusal(L.addReview({ itemId: id, by: SONNET, head, approve: false, note: "Late.", at: new Date().toISOString() }), "tier_withdrawn", /no longer asked for/);
  expect(await L.item(id)).toMatchObject({ state: "accepted" });
  // Where every tier model built the change or reviews it for the gate, no tier review is asked.
  const solo = await setup("land-tier-none", { ...policy, reviewTier: [OPUS, GEMINI] });
  const t = (await solo.newItem("Solo", [], "owner")).id;
  await submittedTask(solo, t, head);
  await solo.requestReview(t, "owner", GEMINI, POOL);
  expect((await solo.reviewRequests(t)).filter((r) => r.tier)).toEqual([]);
});

it("a tier approval alone does not let the task be accepted", async () => {
  const L = await setup("land-tier-gate", { ...policy, reviewTier: ["claude-code/sonnet-5.5"] });
  const id = (await L.newItem("Landing", [], "owner")).id;
  const head = "b".repeat(40);
  await submittedTask(L, id, head);
  await L.requestReview(id, "owner", GPT, POOL);
  await L.claimReview(id, "claude-code/sonnet-5.5", RUNNER);
  await L.addReview({ itemId: id, by: "claude-code/sonnet-5.5", head, approve: true, note: "Tier: fine.", at: new Date().toISOString() });
  await refusal(L.accept(id, "owner", head), "not_ready", /another family/);
  // The gate's request still stands for GPT.
  expect((await L.reviewRequests(id)).find((r) => !r.tier)).toMatchObject({ state: "open" });
});
