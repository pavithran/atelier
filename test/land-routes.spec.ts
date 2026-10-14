import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { ROUTE_LEVEL, SERVER_CAPABILITIES } from "../src/route-level.ts";
import { LANDING_LEASE_EXPIRY_MS } from "../src/landing-lease.ts";
import { LAND_JSON_MAX } from "../src/ledger.ts";
import type { ReviewClaim, Ledger, LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { parseRuleError, type Evidence, type ProjectPolicy } from "../src/rules.ts";
import MERGE_STEPS from "./fixtures/land/merge-steps.json";

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
const NAMED_POOL = [...POOL, entry("gemini-3.1-pro", "antigravity")];

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
  await refusal(L.beginProjectLanding(a, "someone"), "not_project_owner", /only the developer lands/);
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
  await refusal(L.renewProjectLanding(a, "someone"), "not_project_owner", /only the developer lands/);
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
  await refusal(L.queueProjectLanding(b, "someone"), "not_project_owner", /only the developer lands/);
});

it("the landing-lease route takes, renews and cancels the lease for the owner, and a waiting landing asks and leaves through it", async () => {
  const project = "land-lease-route";
  const L = await setup(project);
  const a = (await L.newItem("First", [], "owner")).id;
  const b = (await L.newItem("Second", [], "owner")).id;
  const TOKEN = "land-routes-token";
  const token = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
  const post = (body: Record<string, unknown>) => worker.fetch(new Request(`https://atelier.test/api/projects/${project}/landing-lease`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-atelier-actor": "owner" }, body: JSON.stringify(body),
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

// t550 pre-review finding: the landing Workflow left the lease to lapse
// while it waited for the merge, so a queued landing took it, merged and
// moved main, and the first head was then merged into that main unchecked.
// The main a landing confirms under the lease is recorded with its head,
// and the merge of that head into any other main is refused.
it("the merge of a head into a main other than the one its landing confirmed under the lease is refused (t550)", async () => {
  const L = await setup("land-main-moved");
  const a = (await L.newItem("Landing", [], "owner")).id;
  const b = (await L.newItem("Beside it", [], "owner")).id;
  const aHead = "9".repeat(40), bHead = "e".repeat(40), M1 = "1".repeat(40), M2 = "2".repeat(40);
  await submittedTask(L, a, aHead, ["docs/a.md"]);
  await submittedTask(L, b, bHead, ["docs/b.md"]);
  // Only the lease's holder confirms main, and only a commit hash.
  await refusal(L.confirmLeaseMain(a, "owner", M1), "no_lease", /no landing lease is held/);
  await L.beginProjectLanding(a, "owner");
  await refusal(L.confirmLeaseMain(a, "owner", "main"), "bad_main", /commit hash/);
  await refusal(L.confirmLeaseMain(a, "someone", M1), "not_project_owner", /only the developer/);
  expect(await L.confirmLeaseMain(a, "owner", M1)).toEqual({ main: M1, head: aHead });
  await L.accept(a, "owner", aHead);
  // The lease lapses while a waits to merge; b takes it, merges and moves main to M2.
  const held = (await L.readProjectLanding())!;
  await runInDurableObject(L, async (_instance: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = 'landing-lease'`, JSON.stringify({ ...held, renewedAt: new Date(Date.now() - LANDING_LEASE_EXPIRY_MS).toISOString() }));
  });
  await L.beginProjectLanding(b, "owner");
  await L.accept(b, "owner", bHead);
  await L.beginLanding(b, "owner", bHead, M1);
  await L.merged(b, "owner", M2, true, bHead);
  // a's merge into M2 is refused, naming both mains, and nothing is reserved.
  await refusal(L.beginLanding(a, "owner", aHead, M2), "main_moved", new RegExp(`main moved from 11111111 to 22222222 since ${a}'s landing confirmed it under the lease; ${a} at 99999999 was checked and reviewed against 11111111.*atelier land ${a} again`));
  expect(await L.item(a)).toMatchObject({ state: "accepted", acceptedHead: aHead });
  // Into the main it was confirmed against, the merge begins; once begun, a
  // resumed merge keeps its reservation whatever main reads now.
  await L.beginLanding(a, "owner", aHead, M1);
  await L.beginLanding(a, "owner", aHead, M2);
});

it("the landing-lease route's confirm reads main itself, refusing a main it does not hold and recording the one it does (t550)", async () => {
  const project = "land-confirm-route";
  const L = await setup(project);
  const a = (await L.newItem("First", [], "owner")).id;
  const aHead = "9".repeat(40), M1 = "1".repeat(40), M2 = "2".repeat(40);
  await submittedTask(L, a, aHead, ["docs/a.md"]);
  let top = M2;
  const ARTIFACTS = { get: async () => ({ log: async () => [{ hash: top }], [Symbol.dispose]() {} }) };
  const bindings = { ...env, ATELIER_TOKEN: "land-routes-token", ARTIFACTS } as unknown as typeof env;
  const post = (body: Record<string, unknown>) => worker.fetch(new Request(`https://atelier.test/api/projects/${project}/landing-lease`, {
    method: "POST", headers: { authorization: ["Bearer", "land-routes-token"].join(" "), "content-type": "application/json", "x-atelier-actor": "owner" }, body: JSON.stringify(body),
  }), bindings);
  expect((await post({ item: a })).status).toBe(200);
  const refused = await post({ item: a, confirm: true, main: M1 });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: "main_moved", detail: expect.stringMatching(/main is at 22222222, not 11111111/) });
  top = M1;
  const confirmed = await post({ item: a, confirm: true, main: M1 });
  expect(confirmed.status).toBe(200);
  expect(await confirmed.json()).toEqual({ confirmed: { main: M1, head: aHead } });
  await L.accept(a, "owner", aHead);
  await refusal(L.beginLanding(a, "owner", aHead, M2), "main_moved", /main moved from 11111111 to 22222222/);
});

it("a renewal from an executor older than review-first landing is told to update, not that it lost the lease (t550)", async () => {
  const L = await setup("land-old-executor");
  const id = (await L.newItem("Landing", [], "owner")).id;
  await L.setLandingWorkflow(id, "land-old-1", "owner");
  await L.setLandingWorkflowStage(id, "land-old-1", "workspace", 0);
  await refusal(L.renewProjectLanding(id, "owner", "land-old-1"), "no_lease", /holds no lease while main is merged, checked and reviewed \(t550\).*Update the atelier command/);
  // Without a landing Workflow at a stage before the lease, the refusal is as before.
  await refusal(L.renewProjectLanding(id, "owner"), "no_lease", /^no landing lease is held, so t\d+'s landing cannot renew it$/);
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
  // The request is open in the queue, routed to the named reviewer, under the
  // request number the ask returned (t353): the landing and the runner name
  // the same request, so a skip of it is counted against it alone.
  const [waiting] = await L.reviewWaiting();
  expect(waiting).toMatchObject({ id, dispatch: { job: "review", agent: "codex", model: "gpt-6-astra" } });
  expect(asked.request).toBe(waiting.request);
  expect(typeof asked.request).toBe("number");
  // A contributor cannot be named; the owner alone asks.
  await refusal(L.requestReview(id, "owner", OPUS, POOL), "self_review", /contributed to/);
  await refusal(L.requestReview(id, OPUS, null, POOL), "not_project_owner", /only the developer asks/);
  // A runner claims it: the claim carries the need as the gate reads it, with
  // no plan account, and a review at the head answers the request.
  const claim = await L.claimReview(id, GPT, RUNNER) as unknown as { request: number; head: string; need: { basis: string; changeClass: string }; plan: null };
  expect(claim.head).toBe(head);
  expect(claim.need).toMatchObject({ basis: "protected", changeClass: "protected" });
  expect(claim.plan).toBeNull();
  // Asking again while the request is live returns it as it stands, not duplicated.
  const again = await L.requestReview(id, "owner", null, POOL);
  expect(again).toMatchObject({ needed: true, requested: false, reviewer: GPT, head, request: asked.request });
  // Naming another reviewer while that request stands is refused, not ignored.
  await refusal(L.requestReview(id, "owner", "antigravity/gemini-3.1-pro", NAMED_POOL), "review_claimed", /already requested from codex\/gpt-6-astra, and a runner has claimed it, so it is not withdrawn/);
  expect(await L.requestReview(id, "owner", GPT, POOL)).toMatchObject({ requested: false, reviewer: GPT });
  expect(await L.reviewWaiting()).toEqual([]);
  expect((await L.reviewRequests(id)).at(-1)).toMatchObject({ head, state: "claimed", claimedBy: GPT });
  await L.addReview({ request: claim.request, itemId: id, criteria: await L.criteria(id), by: GPT, head, approve: true, note: "Independently reviewed", at: new Date().toISOString() });
  expect(await L.reviewWaiting()).toEqual([]);
  // With the independent approval counted, no review is needed.
  const after = await L.requestReview(id, "owner", null, POOL);
  expect(after).toMatchObject({ needed: false });
  expect(after.reason).toMatch(/the gate already counts an independent approval/);
});

// The owner's standing (src/models/pool.ts, standingRefusal) binds a named
// reviewer too: one paused, reserved or without the review role is refused
// with the reason, and nothing is requested or withdrawn.
it("a named reviewer the owner paused, reserved or kept from reviewing is refused with the reason", async () => {
  for (const [name, change, why] of [
    ["paused", { state: "paused", stateAt: AT, note: "AI Studio down" }, /codex\/gpt-6-astra is paused since 2026-10-06 \(the developer's standing\): AI Studio down/],
    ["reserved", { state: "reserved", stateAt: AT, note: "astra's credits" }, /codex\/gpt-6-astra is reserved since 2026-10-06 \(the developer's standing\): astra's credits/],
    ["build-only", { roles: ["build"] }, /codex\/gpt-6-astra is not a reviewer; its roles are build/],
  ] as const) {
    const L = await setup(`land-review-held-${name}`);
    const id = (await L.newItem("Landing", [], "owner")).id;
    await submittedTask(L, id, "a".repeat(40));
    const pool = POOL.map((e) => e.id === "gpt-6-astra" ? { ...e, ...change } : e);
    await refusal(L.requestReview(id, "owner", GPT, pool), "model_held", why);
    await refusal(L.requestReview(id, "owner", GPT, pool, true), "model_held", why);
    // A profile or another letter case names the same model, held the same.
    for (const named of [`${GPT}:high`, "CODEX/GPT-6-Astra:fast"]) {
      await refusal(L.requestReview(id, "owner", named, pool), "model_held", new RegExp(why.source.replace("codex\\/gpt-6-astra is", `${named.replace(/[/.]/g, "\\$&")} is`)));
    }
    expect(await L.reviewRequests(id), name).toEqual([]);
    expect((await events(L, id)).filter((e) => e.kind === "review.requested"), name).toEqual([]);
    // Back to available, the same name is asked.
    expect(await L.requestReview(id, "owner", GPT, POOL), name).toMatchObject({ requested: true, reviewer: GPT });
  }
});

// t353: a review request every live runner that offers its reviewer has
// skipped will never be claimed, since each runner keeps its skip until the
// request changes. The owner asking again, with the live offers, withdraws
// it and asks anew under a fresh number, which the runners serve again;
// without the offers, with a runner left to serve it, or once a runner has
// claimed it, the request stands as it was.
it("asking again for a review every runner that offers the reviewer has skipped withdraws the request and asks it anew under a new number", async () => {
  const name = "land-reask-skipped";
  const L = await setup(name);
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.registerProject({ name, repo: `${name}--baseline`, policy, createdAt: new Date().toISOString() });
  await index.putModel(POOL[1]);
  const id = (await L.newItem("Landing", [], "owner")).id;
  const head = "a".repeat(40);
  await submittedTask(L, id, head);
  const offer = (runner: string) => ({ runner, kind: "home" as const, jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() });
  const offers = [offer("home:studio"), offer("home:desk")];
  const first = await L.requestReview(id, "owner", GPT, POOL, false, false, undefined, offers);
  expect(first).toMatchObject({ needed: true, requested: true, reviewer: GPT, head });
  // With no skip recorded, asking again returns the request as it stands.
  expect(await L.requestReview(id, "owner", GPT, POOL, false, false, undefined, offers)).toMatchObject({ requested: false, request: first.request });
  // One runner's skip leaves the other to serve it: the request stands.
  await L.recordReviewSkip(id, first.request!, head, "home:studio", "owner", "no agent token");
  expect(await L.requestReview(id, "owner", GPT, POOL, false, false, undefined, offers)).toMatchObject({ requested: false, request: first.request });
  await L.recordReviewSkip(id, first.request!, head, "home:desk", "owner", "wrong agent");
  // Without the live offers nothing is known to have skipped: the request stands.
  expect(await L.requestReview(id, "owner", GPT, POOL)).toMatchObject({ requested: false, request: first.request });
  // With them, every runner that offers the reviewer has skipped: the request
  // is withdrawn, which is said by runner name, and asked anew under a new
  // number the runners have not skipped.
  const again = await L.requestReview(id, "owner", GPT, POOL, false, false, undefined, offers);
  expect(again).toMatchObject({ needed: true, requested: true, reviewer: GPT, head });
  expect(again.request).toBeGreaterThan(first.request!);
  expect(again.reason).toMatch(new RegExp(`The earlier request at this head \\(${first.request}\\) was withdrawn: every runner that offers codex/gpt-6-astra had skipped it \\(home:studio, home:desk\\)`));
  expect((await L.reviewRequests(id)).map((r) => r.state)).toEqual(["withdrawn", "open"]);
  expect((await events(L, id)).find((e) => e.kind === "review.withdrawn")).toMatchObject({
    actor: "owner",
    data: { head, reviewer: GPT, request: first.request, runners: ["home:studio", "home:desk"], reason: expect.stringMatching(/^every runner that offers codex\/gpt-6-astra skipped review request \d+ \(home:studio, home:desk\)/) },
  });
  // The queue offers the new request alone, and the earlier skips count for nothing against it.
  expect((await L.reviewWaiting()).map((w) => w.request)).toEqual([again.request]);
  expect(await L.reviewSkips(id, again.request!)).toEqual([]);
  // A request a runner has claimed is being served: skips of it, reported
  // late, renew nothing.
  await L.claimReview(id, GPT, RUNNER);
  await L.recordReviewSkip(id, again.request!, head, "home:studio", "owner", "late");
  await L.recordReviewSkip(id, again.request!, head, "home:desk", "owner", "late");
  expect(await L.requestReview(id, "owner", GPT, POOL, false, false, undefined, offers)).toMatchObject({ requested: false, request: again.request });
  expect((await L.reviewRequests(id)).map((r) => r.state)).toEqual(["withdrawn", "claimed"]);

  // The review-request route asks with the live offers the index holds, so a
  // landing run again over it renews a skipped request the same way.
  const b = (await L.newItem("Landing again", [], "owner")).id;
  const headB = "b".repeat(40);
  await submittedTask(L, b, headB);
  await index.putRunnerOffer({ runner: "home:studio", kind: "home", jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }] }, new Date().toISOString());
  const ownerToken = "land-routes-token";
  const token = { ...env, ATELIER_TOKEN: ownerToken } as typeof env;
  const ask = async () => (await worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${b}/review-request`, {
    method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json", "x-atelier-actor": "owner" }, body: JSON.stringify({ reviewer: GPT, wanted: true }),
  }), token)).json() as Promise<{ requested: boolean; request: number; reason: string }>;
  const asked = await ask();
  expect(asked).toMatchObject({ requested: true });
  expect(await ask()).toMatchObject({ requested: false, request: asked.request });
  await L.recordReviewSkip(b, asked.request, headB, "home:studio", "owner", "no agent token");
  const renewed = await ask();
  expect(renewed).toMatchObject({ requested: true });
  expect(renewed.request).toBeGreaterThan(asked.request);
  expect(renewed.reason).toMatch(/every runner that offers codex\/gpt-6-astra had skipped it \(home:studio\)/);
  expect((await L.reviewWaiting()).map((w) => [w.id, w.request])).toEqual([[b, renewed.request]]);
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
  await refusal(L.requestReview(id, OPUS, GPT, POOL, true), "not_project_owner", /only the developer asks/);
  expect(await L.reviewWaiting()).toEqual([]);
  // Asked for, the review is requested for the named reviewer, once.
  const asked = await L.requestReview(id, "owner", GPT, POOL, true);
  expect(asked).toMatchObject({ needed: true, requested: true, reviewer: GPT, head });
  expect((await events(L, id)).find((e) => e.kind === "review.requested")).toMatchObject({ data: { head, reviewer: GPT, via: "land", wanted: true } });
  expect(await L.requestReview(id, "owner", GPT, POOL, true)).toMatchObject({ needed: true, requested: false, reviewer: GPT, head });
  // The reviewer's claim carries a need, so its runner reviews rather than releases the request.
  const claim = await L.claimReview(id, GPT, RUNNER) as unknown as { request: number; need: { basis: string } | null };
  expect(claim.need).toMatchObject({ basis: "requested" });
  // A rejection at this head stops the gate, and a wanted review is refused with that reason.
  await L.addReview({ request: claim.request, itemId: id, criteria: await L.criteria(id), by: GPT, head, approve: false, note: "Wrong.", findings: [{ file: "docs/note.md", line: 1, severity: "blocking" as const, text: "It is wrong." }], at: new Date().toISOString() });
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

it("a standalone expired claim is reoffered within one queue poll with its routing intact", async () => {
  const GEMINI = "antigravity/gemini-3.1-pro";
  const L = await setup("land-lapse");
  const id = (await L.newItem("Landing", [], "owner")).id;
  const head = "c".repeat(40);
  await submittedTask(L, id, head);
  await L.requestReview(id, "owner", GPT, POOL);
  const reviewClaim2 = await L.claimReview(id, GPT, RUNNER) as unknown as ReviewClaim;
  // The claim lapses: it was taken two days ago.
  await runInDurableObject(L, async (_instance: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE review_requests SET claimedAt = ? WHERE item = ?`, new Date(Date.now() - 2 * 86_400_000).toISOString(), id);
  });
  const [offered] = await L.reviewWaiting();
  expect(offered.request).not.toBe(reviewClaim2.request);
  expect(offered.head).toBe(head);
  expect(offered.dispatch).toMatchObject({ agent: "codex", model: "gpt-6-astra" });
  expect(await L.requestReview(id, "owner", GPT, POOL)).toMatchObject({ requested: false, reviewer: GPT, request: offered.request });
  const successor = await L.claimReview(id, GPT, { runner: "home:replacement", kind: "home" }) as unknown as ReviewClaim;
  expect(successor.request).toBe(offered.request);
  expect(successor.criteria).toBe(reviewClaim2.criteria);
  // Once that replacement also expires, an explicit request may name a
  // different eligible reviewer, retaining main's named-reviewer behavior.
  await runInDurableObject(L, async (_instance: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE review_requests SET claimedAt = ? WHERE id = ?`, new Date(Date.now() - 2 * 86_400_000).toISOString(), successor.request);
  });
  expect(await L.requestReview(id, "owner", GEMINI, NAMED_POOL)).toMatchObject({ requested: true, reviewer: GEMINI });
  expect(await L.requestReview(id, "owner", GEMINI, NAMED_POOL)).toMatchObject({ requested: false, reviewer: GEMINI, head });
  // Once a runner claims it, naming another reviewer is refused (t627).
  await L.claimReview(id, GEMINI, RUNNER);
  await refusal(L.requestReview(id, "owner", GPT, POOL), "review_claimed", /already requested from antigravity\/gemini-3.1-pro, and a runner has claimed it, so it is not withdrawn/);
});

// micahapp t9 (t627): an unclaimed request for codex/gpt-6-astra at 02700476
// held the head; naming another reviewer was refused as already requested,
// review-release answered stale_request for every number, and only an empty
// commit let it go. The developer now withdraws it with a reason, or
// redirects it by naming another reviewer; a claimed request stays.
it("the developer withdraws an unclaimed review request with a reason and asks another reviewer at the same head (t627)", async () => {
  const GEMINI = "antigravity/gemini-3.1-pro";
  const L = await setup("land-withdraw");
  const id = (await L.newItem("Landing", [], "owner")).id;
  const head = "d".repeat(40);
  await submittedTask(L, id, head);
  const asked = await L.requestReview(id, "owner", GPT, POOL, true);
  // The developer alone withdraws, and only with a reason.
  await refusal(L.withdrawReviewRequest(id, OPUS, "no runner"), "not_project_owner", /only the developer withdraws/);
  await refusal(L.withdrawReviewRequest(id, "owner", "  "), "bad_reason", /needs a reason/);
  await refusal(L.withdrawReviewRequest(id, "owner", undefined), "bad_reason", /needs a reason/);
  await refusal(L.withdrawReviewRequest(id, "owner", "x".repeat(1001)), "too_long", /at most 1000/);
  await refusal(L.withdrawReviewRequest(id, "owner", "no runner", 99999), "no_request", /has no review request 99999/);
  const gone = await L.withdrawReviewRequest(id, "owner", "No runner serves  codex/gpt-6-astra");
  expect(gone).toEqual({ request: asked.request, head, reviewer: GPT, reason: "No runner serves codex/gpt-6-astra" });
  expect((await events(L, id)).find((e) => e.kind === "review.withdrawn")).toMatchObject({ actor: "owner", data: { head, reviewer: GPT, request: asked.request, reason: "No runner serves codex/gpt-6-astra" } });
  expect(await L.reviewWaiting()).toEqual([]);
  // Nothing stands now, so a second withdrawal finds nothing.
  await refusal(L.withdrawReviewRequest(id, "owner", "again"), "no_request", /nothing to withdraw/);
  // Another reviewer is asked at the same head, with no new commit.
  const next = await L.requestReview(id, "owner", GEMINI, NAMED_POOL, true);
  expect(next).toMatchObject({ needed: true, requested: true, reviewer: GEMINI, head });
  expect(next.withdrew).toBeUndefined();
  const [waiting] = await L.reviewWaiting();
  expect(waiting).toMatchObject({ id, request: next.request, dispatch: { agent: "antigravity", model: "gemini-3.1-pro" } });
  // A claimed request is being served, and is refused, by number too.
  await L.claimReview(id, GEMINI, RUNNER);
  await refusal(L.withdrawReviewRequest(id, "owner", "changed my mind"), "review_claimed", new RegExp(`request ${next.request}\\) is claimed by ${GEMINI}`));
  await refusal(L.withdrawReviewRequest(id, "owner", "changed my mind", next.request), "review_claimed", /is being served and is not withdrawn/);
  expect((await L.reviewRequests(id)).at(-1)).toMatchObject({ state: "claimed", claimedBy: GEMINI });
  // A request already withdrawn, named by number, is not withdrawn again.
  await refusal(L.withdrawReviewRequest(id, "owner", "again", asked.request), "no_request", /is withdrawn, so there is nothing to withdraw/);
});

it("naming another reviewer redirects an unclaimed review request, says so, and leaves it standing when the new ask is refused (t627)", async () => {
  const GEMINI = "antigravity/gemini-3.1-pro";
  const L = await setup("land-redirect");
  const id = (await L.newItem("Landing", [], "owner")).id;
  const head = "e".repeat(40);
  await submittedTask(L, id, head);
  const asked = await L.requestReview(id, "owner", GPT, POOL, true);
  // A refused new reviewer (a contributor) withdraws nothing.
  await refusal(L.requestReview(id, "owner", OPUS, POOL, true), "self_review", /contributed to/);
  expect((await L.reviewRequests(id)).at(-1)).toMatchObject({ state: "open" });
  // Nor does an ask the gate refuses after the redirect began: the check
  // failing at the head blocks the new request, and the old one stands.
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head, passed: false, by: OPUS, at: new Date().toISOString(), changedPaths: ["src/land.ts"] } satisfies Evidence);
  await refusal(L.requestReview(id, "owner", GEMINI, NAMED_POOL, true), "review_blocked", /failed at/);
  expect((await L.reviewRequests(id)).map((r) => r.state)).toEqual(["open"]);
  expect((await events(L, id)).some((e) => e.kind === "review.withdrawn")).toBe(false);
  // The same through the review-request route without `wanted`, where a
  // blocked gate answers normally (gpt-6-astra's review of t627, finding 2):
  // no replacement is asked, so the withdrawal rolls back with it.
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.registerProject({ name: "land-redirect", repo: "land-redirect--baseline", policy, createdAt: new Date().toISOString() });
  for (const m of NAMED_POOL) await index.putModel(m);
  const askToken = "land-redirect-ask-token";
  const askRes = await worker.fetch(new Request(`https://atelier.test/api/projects/land-redirect/items/${id}/review-request`, {
    method: "POST", headers: { authorization: `Bearer ${askToken}`, "content-type": "application/json", "x-atelier-actor": "owner" }, body: JSON.stringify({ reviewer: GEMINI }),
  }), { ...env, ATELIER_TOKEN: askToken } as typeof env);
  const unasked = await askRes.json() as Record<string, unknown>;
  expect(askRes.status, JSON.stringify(unasked)).toBe(200);
  expect(unasked).toMatchObject({ needed: false, reason: expect.stringMatching(new RegExp(`failed at eeeeeeee; the builder fixes that before a review; no review of antigravity/gemini-3.1-pro was asked, so request ${asked.request} for codex/gpt-6-astra stands$`)) });
  expect(unasked.withdrew).toBeUndefined();
  expect((await L.reviewRequests(id)).map((r) => r.state)).toEqual(["open"]);
  expect((await events(L, id)).some((e) => e.kind === "review.withdrawn")).toBe(false);
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: ["src/land.ts"] } satisfies Evidence);
  const next = await L.requestReview(id, "owner", GEMINI, NAMED_POOL, true);
  expect(next).toMatchObject({ needed: true, requested: true, reviewer: GEMINI, head, withdrew: [{ request: asked.request, reviewer: GPT }] });
  expect(next.request).not.toBe(asked.request);
  expect((await events(L, id)).find((e) => e.kind === "review.withdrawn")).toMatchObject({ actor: "owner", data: { head, reviewer: GPT, request: asked.request, reason: `the developer named ${GEMINI} to review it` } });
  const waiting = await L.reviewWaiting();
  expect(waiting.map((w) => w.request)).toEqual([next.request]);
  // Naming the same reviewer again keeps the request as it stands.
  expect(await L.requestReview(id, "owner", GEMINI, NAMED_POOL, true)).toMatchObject({ requested: false, reviewer: GEMINI, request: next.request });
  // The review-withdraw route is the developer's alone and needs a reason.
  const ownerToken = "land-withdraw-token";
  const token = { ...env, ATELIER_TOKEN: ownerToken } as typeof env;
  const post = async (actor: string, body: unknown) => {
    const res = await worker.fetch(new Request(`https://atelier.test/api/projects/land-redirect/items/${id}/review-withdraw`, {
      method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json", "x-atelier-actor": actor }, body: JSON.stringify(body),
    }), token);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  expect(await post(OPUS, { reason: "Stuck" })).toMatchObject({ status: 403, body: { error: "not_project_owner" } });
  expect(await post("owner", {})).toMatchObject({ status: 400, body: { error: "bad_reason" } });
  expect(await post("owner", { reason: "Stuck", request: "8" })).toMatchObject({ status: 400, body: { error: "bad_request" } });
  expect(await post("owner", { reason: "Stuck" })).toEqual({ status: 200, body: { withdrawn: true, request: next.request, head, reviewer: GEMINI, reason: "Stuck" } });
  expect(await L.reviewWaiting()).toEqual([]);
});

it("the landing's steps are recorded as land.* events with their duration, and anything else is refused", async () => {
  const L = await setup("land-events");
  const id = (await L.newItem("Landing", [], "owner")).id;
  await L.landEvent(id, "owner", "merge", 1200, { fromMain: ["b".repeat(40)], conflicts: ["src/x.ts"], resolvedBy: "the developer, by hand" });
  await L.landEvent(id, "owner", "submit", 300, {});
  await L.landEvent(id, "owner", "review", 9000, { verdict: "approve", reviewer: GPT, resolvedBy: GPT });
  const recorded = (await events(L, id)).filter((e) => e.kind.startsWith("land.")).sort((a, b) => a.seq - b.seq);
  expect(recorded.map((e) => [e.kind, e.data.ms])).toEqual([["land.merge", 1200], ["land.submit", 300], ["land.review", 9000]]);
  expect(recorded[0].data).toMatchObject({ fromMain: ["b".repeat(40)], conflicts: ["src/x.ts"], resolvedBy: "the developer, by hand" });
  await refusal(L.landEvent(id, "owner", "deploy", 5, {}), "bad_step", /is not a step of a landing/);
  await refusal(L.landEvent(id, "owner", "merge", -5, {}), "bad_ms", /duration in milliseconds/);
  await refusal(L.landEvent(id, "owner", "merge", 5, { nonsense: true }), "bad_field", /nonsense is not a field/);
  await refusal(L.landEvent(id, OPUS, "merge", 5, {}), "not_project_owner", /only the developer records/);
});

it("the time before the lease and the time holding it are recorded on the lease and release steps (t550)", async () => {
  const L = await setup("land-timing");
  const id = (await L.newItem("Landing", [], "owner")).id;
  await L.landEvent(id, "owner", "lease", 40, { head: "a".repeat(40), main: "b".repeat(40), beforeLease: 690_000.4, waited: 0 });
  await L.landEvent(id, "owner", "release", 52_000, { reason: "merged" });
  const recorded = (await events(L, id)).filter((e) => e.kind.startsWith("land.")).sort((a, b) => a.seq - b.seq);
  expect(recorded.map((e) => e.kind)).toEqual(["land.lease", "land.release"]);
  expect(recorded[0].data).toMatchObject({ ms: 40, head: "a".repeat(40), main: "b".repeat(40), beforeLease: 690_000, waited: 0 });
  expect(recorded[1].data).toMatchObject({ ms: 52_000, reason: "merged" });
  await refusal(L.landEvent(id, "owner", "lease", 5, { beforeLease: -1 }), "bad_field", /beforeLease must be a duration in milliseconds/);
  await refusal(L.landEvent(id, "owner", "lease", 5, { waited: "long" }), "bad_field", /waited must be a duration in milliseconds/);
});

it("a triage is recorded as its own land.triage step, by the project owner alone, and changes no review, round or gate decision (t475)", async () => {
  const L = await setup("land-triage");
  const id = (await L.newItem("Landing", ["src/**"], "owner")).id;
  const detail = async () => (await L.detail(id)) as unknown as { reviews: unknown[]; gate: unknown };
  const before = await detail();
  const binding = { head: "a".repeat(40), base: "b".repeat(40), criteria: "c".repeat(64) };
  await L.landEvent(id, "owner", "triage", 4000, { ...binding, outcome: "stopped", triager: GPT, statuses: ["1:met", "2:not-met"], reason: "criterion 2 not met" });
  await L.landEvent(id, "owner", "triage", 0, { ...binding, outcome: "overridden", triager: GPT, reason: "checked by hand" });
  await L.landEvent(id, "owner", "triage", 0, { ...binding, outcome: "bypassed", reason: "hotfix" });
  const recorded = (await events(L, id)).filter((e) => e.kind === "land.triage").sort((a, b) => a.seq - b.seq);
  expect(recorded.map((e) => [e.actor, e.data.outcome, e.data.head, e.data.base, e.data.criteria, e.data.reason])).toEqual([
    ["owner", "stopped", binding.head, binding.base, binding.criteria, "criterion 2 not met"],
    ["owner", "overridden", binding.head, binding.base, binding.criteria, "checked by hand"],
    ["owner", "bypassed", binding.head, binding.base, binding.criteria, "hotfix"],
  ]);
  expect(recorded[0].data).toMatchObject({ triager: GPT, statuses: ["1:met", "2:not-met"] });
  // Only the project owner records a triage, its bypass or its override.
  await refusal(L.landEvent(id, OPUS, "triage", 0, { ...binding, outcome: "bypassed", reason: "mine" }), "not_project_owner", /only the developer records/);
  await refusal(L.landEvent(id, "owner", "triage", 0, { ...binding, outcome: 3 }), "bad_field", /outcome must be text/);
  // Triage is not a review: the item's reviews and its gate are as they were.
  const after = await detail();
  expect(after.reviews).toEqual(before.reviews);
  expect(after.gate).toEqual(before.gate);
  expect((await events(L, id)).some((e) => e.kind.startsWith("review."))).toBe(false);
});

it("the merge steps atelier land posts reach the ledger whole through the land route: regenerated outputs, source conflicts, main's head and the route levels (t463)", async () => {
  const project = "land-merge-steps";
  const L = await setup(project);
  const id = (await L.newItem("Landing", [], "owner")).id;
  const TOKEN = "land-routes-token";
  const token = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
  // The bodies are what the CLI posted in test/land.test.mjs, which checks
  // them against this fixture, so a field it sends that the ledger refuses
  // fails here rather than as a warning in a real landing.
  const post = (body: Record<string, unknown>) => worker.fetch(new Request(`https://atelier.test/api/projects/${project}/items/${id}/land`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-atelier-actor": "owner" }, body: JSON.stringify(body),
  }), token);
  for (const [name, body] of Object.entries(MERGE_STEPS)) {
    const r = await post(body);
    expect(r.status, `${name}: ${await r.clone().text()}`).toBe(200);
  }
  const recorded = (await events(L, id)).filter((e) => e.kind === "land.merge").sort((a, b) => a.seq - b.seq);
  const without = ({ step: _step, ms: _ms, ...rest }: Record<string, unknown>) => rest;
  expect(recorded.map((e) => without(e.data))).toEqual(Object.values(MERGE_STEPS).map((b) => without(b)));
  expect(recorded[0].data.regenerated).toEqual([{ name: "fixtures", outputs: [{ path: "gen-fixtures.txt", matches: "neither side" }], log: "/tmp/merge-logs/fixtures.log", logSha: "f".repeat(64) }]);
  expect(recorded[1].data).toMatchObject({ failed: true, source: ["work.txt"], generated: ["gen-fixtures.txt"], mainHead: "0".repeat(40) });
  expect(recorded[2].data.routeLevel).toEqual({ base: 6, main: 7, task: 7, was: 7, set: 8 });
  // What the new fields take is checked, as every other field is.
  const bad = async (data: Record<string, unknown>, detail: RegExp) => refusal(L.landEvent(id, "owner", "merge", 5, data), "bad_field", detail);
  await bad({ routeLevel: { base: "6" } }, /routeLevel must be route levels/);
  await bad({ routeLevel: { other: 6 } }, /routeLevel must be route levels/);
  await bad({ regenerated: [{ name: "x", outputs: [{ path: "a", matches: "both" }], log: "l", logSha: "s" }] }, /regenerated must be a list of generators/);
  await bad({ regenerated: [{ name: "x", outputs: [], log: "l" }] }, /regenerated must be a list of generators/);
  await bad({ mainHead: 7 }, /mainHead must be text/);
  await bad({ source: "work.txt" }, /source must be a list/);
});

it("a merge step with more commits from main than its record has room for is cut to the first hashes with the count, not refused", async () => {
  const L = await setup("land-cut");
  const id = (await L.newItem("Landing", [], "owner")).id;
  // t293's landing (2026-10-08) merged 103 commits from main and the merge
  // step's record was refused whole as too long, so the step went
  // unrecorded. The record now keeps the first hashes and the count of the
  // whole list beside it, within the limit the ledger sets.
  const fromMain = Array.from({ length: 103 }, (_, i) => `${String(i).padStart(3, "0")}${"c".repeat(37)}`);
  await L.landEvent(id, "owner", "merge", 1200, { fromMain });
  const cut = ((await events(L, id)).find((e) => e.kind === "land.merge")?.data ?? {}) as { fromMain?: string[]; fromMainCount?: number };
  expect(cut.fromMainCount).toBe(103);
  expect(cut.fromMain?.length ?? 0).toBeLessThan(103);
  expect(cut.fromMain).toEqual(fromMain.slice(0, cut.fromMain?.length ?? 0));
  expect(JSON.stringify({ ...cut, ms: 0 }).length).toBeLessThanOrEqual(LAND_JSON_MAX);
  // A list that fits the limit is recorded whole, with no count beside it.
  await L.landEvent(id, "owner", "merge", 5, { fromMain: ["a".repeat(40), "b".repeat(40)] });
  const whole = ((await events(L, id)).filter((e) => e.kind === "land.merge")[0]?.data ?? {}) as { fromMain?: string[]; fromMainCount?: number };
  expect(whole.fromMain).toEqual(["a".repeat(40), "b".repeat(40)]);
  expect("fromMainCount" in whole).toBe(false);
});

it("GET /api/version answers without a token, and every other /api route still needs one", async () => {
  const noToken = { ...env, ATELIER_TOKEN: "land-routes-token" } as typeof env;
  const version = await worker.fetch(new Request("https://atelier.test/api/version"), noToken);
  expect(version.status).toBe(200);
  expect(await version.json()).toMatchObject({ routeLevel: ROUTE_LEVEL, capabilities: [...SERVER_CAPABILITIES] });
  expect((await worker.fetch(new Request("https://atelier.test/api/projects"), noToken)).status).toBe(401);
});

it("a landing's review request with an explicit --reviewer outside the tier asks the review tier beside it, and the acceptance withdraws a tier review still open without waiting for it", async () => {
  const SOL = "codex/gpt-6.1-sol", SONNET = "claude-code/sonnet-5.5", GEMINI = "antigravity/gemini-3.1-pro";
  const L = await setup("land-tier", { ...policy, reviewTier: [OPUS, SONNET, SOL] });
  const id = (await L.newItem("Landing", [], "owner")).id;
  const head = "a".repeat(40);
  await submittedTask(L, id, head);
  // The owner's --reviewer wins over the tier, and is outside it.
  const asked = await L.requestReview(id, "owner", GPT, POOL);
  expect(asked).toMatchObject({ requested: true, reviewer: GPT });
  // The builder (OPUS) is skipped; SONNET, of the builder's family, is asked.
  expect((await L.reviewWaiting()).map((i) => `${i.dispatch!.agent}/${i.dispatch!.model}`)).toEqual([GPT, SONNET]);
  // Asking again returns the gate's request, not the tier's, and makes no second tier request.
  expect(await L.requestReview(id, "owner", null, POOL)).toMatchObject({ requested: false, reviewer: GPT });
  expect((await L.reviewRequests(id)).filter((r) => r.tier)).toHaveLength(1);
  // The tier review is claimed; the gate's approval comes in and the task is
  // accepted at once, without waiting for it: its request is withdrawn.
  const reviewClaim3 = await L.claimReview(id, SONNET, RUNNER) as unknown as ReviewClaim;
  const reviewClaim4 = await L.claimReview(id, GPT, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: reviewClaim4.request, itemId: id, criteria: await L.criteria(id), by: GPT, head, approve: true, note: "Gate: fine.", at: new Date().toISOString() });
  await L.accept(id, "owner", head);
  expect((await L.reviewRequests(id)).find((r) => r.tier)).toMatchObject({ state: "withdrawn" });
  expect((await events(L, id)).find((e) => e.kind === "review.withdrawn")).toMatchObject({ data: { reviewer: SONNET, tier: true } });
  // The tier verdict arriving late is refused and does not reopen the accepted task.
  await refusal(L.addReview({ request: reviewClaim3.request, itemId: id, criteria: await L.criteria(id), by: SONNET, head, approve: false, note: "Late.", at: new Date().toISOString() }), "stale_request", /withdrawn or replaced/);
  expect(await L.item(id)).toMatchObject({ state: "accepted" });
  // Where every tier model built the change or reviews it for the gate, no tier review is asked.
  const solo = await setup("land-tier-none", { ...policy, reviewTier: [OPUS, GEMINI] });
  const t = (await solo.newItem("Solo", [], "owner")).id;
  await submittedTask(solo, t, head);
  await solo.requestReview(t, "owner", GEMINI, NAMED_POOL);
  expect((await solo.reviewRequests(t)).filter((r) => r.tier)).toEqual([]);
});

// t394: the acceptance records the family mode in force and each contributor
// with its company, and the merge's provenance note reads them from there:
// GPT's work done before a switch to Anthropic only stays GPT's in the note.
it("an acceptance records the family mode in force and each contributor's company for the provenance note", async () => {
  const SONNET = "claude-code/sonnet-5.5";
  const L = await setup("land-acceptance-family");
  const id = (await L.newItem("Landing", [], "owner")).id;
  const first = "d".repeat(40), head = "e".repeat(40);
  await L.claim(id, GPT, RUNNER);
  await L.setFork(id, `fork-${id}`, H0, GPT);
  await L.recordPush(id, GPT, first, first);
  await L.release(id, GPT, "Opus finishes it");
  await L.claim(id, OPUS, RUNNER);
  await L.recordPush(id, OPUS, head, first);
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: ["src/land.ts"] } satisfies Evidence);
  await L.submit(id, OPUS);
  await L.initProject({ name: "land-acceptance-family", repo: "land-acceptance-family--baseline", reset: false, familyMode: { single: "anthropic", by: "owner" } }, "owner");
  expect(await L.requestReview(id, "owner", null, [...POOL, entry("sonnet-5.5", "claude-code")])).toMatchObject({ reviewer: SONNET });
  const claim = await L.claimReview(id, SONNET, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: claim.request, itemId: id, criteria: await L.criteria(id), by: SONNET, head, approve: true, note: "Fine.", at: new Date().toISOString() });
  await L.accept(id, "owner", head);
  // What cli/provenance.mjs states (its own tests read these into the note).
  const family = (await L.detail(id) as unknown as { acceptanceFamily: { contributors: unknown[] } }).acceptanceFamily;
  expect(family).toEqual({ singleFamily: "anthropic", contributors: expect.arrayContaining([{ actor: GPT, company: "openai" }, { actor: OPUS, company: "anthropic" }]) });
  expect(family.contributors).toHaveLength(2);
  // A later return to the default does not change what the acceptance recorded.
  await L.initProject({ name: "land-acceptance-family", repo: "land-acceptance-family--baseline", reset: false, familyMode: { single: null, by: "owner" } }, "owner");
  expect((await L.detail(id) as unknown as { acceptanceFamily: { singleFamily: string | null } }).acceptanceFamily.singleFamily).toBe("anthropic");
});

it("a tier approval alone does not let the task be accepted", async () => {
  const L = await setup("land-tier-gate", { ...policy, reviewTier: ["claude-code/sonnet-5.5"] });
  const id = (await L.newItem("Landing", [], "owner")).id;
  const head = "b".repeat(40);
  await submittedTask(L, id, head);
  await L.requestReview(id, "owner", GPT, POOL);
  const reviewClaim5 = await L.claimReview(id, "claude-code/sonnet-5.5", RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: reviewClaim5.request, itemId: id, criteria: await L.criteria(id), by: "claude-code/sonnet-5.5", head, approve: true, note: "Tier: fine.", at: new Date().toISOString() });
  await refusal(L.accept(id, "owner", head), "not_ready", /another family/);
  // The gate's request still stands for GPT.
  expect((await L.reviewRequests(id)).find((r) => !r.tier)).toMatchObject({ state: "open" });
});

// t394: under single-family mode a landing picks a different model of the
// company, refuses a named reviewer of another company, and the review
// claim carries the mode so the brief can say so; the company's approval
// then clears the gate, which the owner's acceptance confirms.
it("under single-family mode a landing's review goes to a different model of the company, and no other company's model is named", async () => {
  const SONNET = "claude-code/sonnet-5.5";
  const pool = [...POOL, entry("sonnet-5.5", "claude-code")];
  const L = await setup("land-single-family", { ...policy, familyMode: { single: "anthropic", by: "owner", at: AT } });
  const id = (await L.newItem("Landing", [], "owner")).id;
  const head = "c".repeat(40);
  await submittedTask(L, id, head);
  // GPT, first in the pool's order, is passed over for being another company's; OPUS built it.
  await refusal(L.requestReview(id, "owner", GPT, pool), "single_family", /codex\/gpt-6-astra is not one of anthropic's models, and this project runs in single-family mode \(anthropic\)/);
  expect(await L.requestReview(id, "owner", null, pool)).toMatchObject({ requested: true, reviewer: SONNET });
  expect((await events(L, id)).find((e) => e.kind === "review.requested")).toMatchObject({ data: { reviewer: SONNET, via: "land" } });
  const claim = await L.claimReview(id, SONNET, RUNNER) as unknown as ReviewClaim;
  expect(claim.singleFamily).toBe("anthropic");
  expect(claim.need?.reason).toMatch(/needs an independent review/);
  await L.addReview({ request: claim.request, itemId: id, criteria: await L.criteria(id), by: SONNET, head, approve: true, note: "Fine.", at: new Date().toISOString() });
  await L.accept(id, "owner", head);
  expect(await L.item(id)).toMatchObject({ state: "accepted" });
  // With only the builder's company's one model, no reviewer can be shown independent, and the refusal says what to name.
  const alone = await setup("land-single-family-alone", { ...policy, familyMode: { single: "anthropic", by: "owner", at: AT } });
  const t = (await alone.newItem("Alone", [], "owner")).id;
  await submittedTask(alone, t, head);
  await refusal(alone.requestReview(t, "owner", null, POOL), "no_reviewer", /^no reviewer that is a different anthropic model from every contributor \(single-family mode\) is in the pool: /);
  // The claim under the default carries no mode.
  const plain = await setup("land-single-family-none");
  const p = (await plain.newItem("Plain", [], "owner")).id;
  await submittedTask(plain, p, head);
  expect(await plain.requestReview(p, "owner", null, pool)).toMatchObject({ reviewer: GPT });
  expect((await plain.claimReview(p, GPT, RUNNER) as unknown as { singleFamily: string | null }).singleFamily).toBeNull();
});

// t394, the review of e5cb758c: a dispatch that names no model leaves the
// runner's choice to the claim, which is refused for another company's model
// as a handoff to one is; a separate tier review is asked only of the
// company's tier models; and a landing that resumes on its standing request
// judges that request's reviewer by the same mode.
it("under single-family mode no other company's model claims, takes a handoff or is asked for the tier, and a landing resumes on its standing review", async () => {
  const SONNET = "claude-code/sonnet-5.5", SOL = "codex/gpt-6.1-sol", FABLE = "claude-code/fable-5.1";
  const single: ProjectPolicy = { ...policy, familyMode: { single: "anthropic", by: "owner", at: AT } };
  const L = await setup("land-single-family-guards", { ...single, reviewTier: [SOL, FABLE] });
  const id = (await L.newItem("Guards", [], "owner")).id;
  await L.dispatch(id, "owner", { to: "home" });
  await refusal(L.claim(id, GPT, RUNNER), "single_family", /^codex\/gpt-6-astra is not one of anthropic's models, and this project runs in single-family mode \(anthropic\)/);
  await refusal(L.dispatch(id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" }), "single_family", /^gpt-6-astra is not one of anthropic's models/);
  const head = "d".repeat(40);
  await submittedTask(L, id, head);
  await refusal(L.handoff(id, OPUS, GPT, "over to you"), "single_family", /^codex\/gpt-6-astra is not one of anthropic's models/);
  // The gate goes to SONNET, outside the tier; the tier's SOL comes first but is another company's, so FABLE is asked.
  expect(await L.requestReview(id, "owner", SONNET, [...POOL, entry("sonnet-5.5", "claude-code")])).toMatchObject({ requested: true, reviewer: SONNET });
  expect((await L.reviewWaiting()).map((i) => `${i.dispatch!.agent}/${i.dispatch!.model}`)).toEqual([SONNET, FABLE]);
  // The landing resumes on SONNET's open request: a different anthropic model is no refusal under the mode.
  const records = { project: "land-single-family-guards", sources: [], runs: [] };
  expect(await L.requestReview(id, "owner", null, POOL, false, false, records)).toMatchObject({ requested: false, reviewer: SONNET, head });
});

it("a landing's review goes to a tier model of another family first, and its one review serves the gate and the tier", async () => {
  const GEMINI = "antigravity/gemini-3.1-pro";
  // Without the tier, the pool's order would pick GEMINI for the gate.
  const pool = [...POOL, entry("gemini-3.1-pro", "antigravity")];
  const L = await setup("land-tier-first", { ...policy, reviewTier: [OPUS, GPT] });
  const id = (await L.newItem("Landing", [], "owner")).id;
  const head = "c".repeat(40);
  await submittedTask(L, id, head);
  expect(await L.requestReview(id, "owner", null, pool)).toMatchObject({ requested: true, reviewer: GPT });
  // No separate tier request: the gate's request, asked of a tier model, is the tier's too.
  expect((await L.reviewWaiting()).map((i) => `${i.dispatch!.agent}/${i.dispatch!.model}`)).toEqual([GPT]);
  expect((await L.reviewRequests(id)).filter((r) => r.tier)).toEqual([]);
  expect((await events(L, id)).find((e) => e.kind === "review.requested")).toMatchObject({ data: { reviewer: GPT, topTier: true } });
  const reviewClaim6 = await L.claimReview(id, GPT, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: reviewClaim6.request, itemId: id, criteria: await L.criteria(id), by: GPT, head, approve: true, note: "Gate and tier: fine.", at: new Date().toISOString() });
  expect((await L.reviewsFor(id))[0]).toMatchObject({ by: GPT, topTier: true });
  expect((await L.reviewsFor(id))[0].tier).toBeUndefined();
  await L.accept(id, "owner", head);
  expect(await L.item(id)).toMatchObject({ state: "accepted" });
  // Without a tier, the same pool asks GEMINI.
  const plain = await setup("land-tier-first-none");
  const t = (await plain.newItem("Plain", [], "owner")).id;
  await submittedTask(plain, t, head);
  expect(await plain.requestReview(t, "owner", null, pool)).toMatchObject({ reviewer: GEMINI });
});

it("an explicit --reviewer that is a tier model of another family serves the tier, and no separate tier request is made", async () => {
  const SONNET = "claude-code/sonnet-5.5";
  const L = await setup("land-tier-named", { ...policy, reviewTier: [OPUS, GPT, SONNET] });
  const id = (await L.newItem("Landing", [], "owner")).id;
  const head = "d".repeat(40);
  await submittedTask(L, id, head);
  expect(await L.requestReview(id, "owner", GPT, POOL)).toMatchObject({ requested: true, reviewer: GPT });
  expect((await L.reviewRequests(id)).filter((r) => r.tier)).toEqual([]);
  expect((await L.reviewWaiting()).map((i) => `${i.dispatch!.agent}/${i.dispatch!.model}`)).toEqual([GPT]);
});

it("the owner ports an unclaimed fork without claiming it, and is a contributor", async () => {
  const L = await setup("land-owner-port");
  const id = (await L.newItem("Port before dispatch", [], "owner")).id;
  await L.claim(id, OPUS);
  await L.setFork(id, "port-fork", H0, OPUS);
  await L.recordPush(id, OPUS, "1".repeat(40), null);
  await L.release(id, OPUS, "Ready for a port");
  const before = await L.item(id);
  await refusal(L.recordPush(id, GPT, "2".repeat(40), null), "closed", /open/);
  const port = await L.recordPush(id, "owner", "2".repeat(40), null, true);
  expect(port).toMatchObject({ owner: null, state: "open", head: "2".repeat(40), dispatch: before.dispatch });
  expect(port.pushActors).toContain("owner");
  expect((await events(L, id)).find(e => e.kind === "push.observed" && e.actor === "owner")).toMatchObject({ actor: "owner", data: { head: "2".repeat(40) } });
  await L.claim(id, GPT);
  expect((await L.item(id)).head).toBe(port.head);
  await refusal(L.recordPush(id, "owner", "3".repeat(40), null), "not_owner", /does not hold/);
  await L.release(id, GPT, "Blocked port");
  await L.block(id, "owner", "Needs input");
  await refusal(L.recordPush(id, "owner", "3".repeat(40), null), "blocked", /Needs input/);
});

it("an owner port is credited even if the fork notification recorded its head first", async () => {
  const L = await setup("land-owner-port-seen");
  const id = (await L.newItem("Port already observed", [], "owner")).id;
  await L.claim(id, OPUS);
  await L.setFork(id, "port-seen-fork", H0, OPUS);
  await L.recordPush(id, OPUS, "1".repeat(40), null);
  await L.release(id, OPUS, "Port follows");
  // The recorded head already matches, as when the notification wins the race.
  await L.recordPush(id, "owner", "1".repeat(40), null, true);
  await L.recordPush(id, "owner", "1".repeat(40), null, true);
  expect((await L.item(id)).pushActors).toContain("owner");
  expect((await events(L, id)).filter(e => e.kind === "push.observed" && e.actor === "owner")).toHaveLength(1);
});
