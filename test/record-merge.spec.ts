import { env } from "cloudflare:workers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { setRetryBaseMs } from "../src/transient.ts";
import worker from "../src/index.ts";
import { renderItem } from "../src/ui.ts";
import { recordMergeCommand } from "../src/rules.ts";
import type { LedgerEvent } from "../src/ledger.ts";

// atelier record-merge (t653). Under the 2026-10-13 freeze the tasks
// t590-t651 were merged into local main by hand, outside atelier land and
// accept, so the ledger still showed them open or claimed. The developer
// records each afterwards: the merge commit main holds, the commit merged
// (its second parent) and the reviews as given. The record is refused for
// an agent, when main lacks the merge, and when its second parent is
// another commit; it says plainly that the merge was made outside Atelier.

const TOKEN = "record-merge-token";
const AT = "2026-10-14T00:00:00.000Z";
const BUILDER = "claude-code/opus-5.5", ASTRA = "codex/gpt-6-astra", ARGON = "antigravity/gemini-4-argon";
const BASE = "a".repeat(40), HEAD = "b".repeat(40), MERGE = "c".repeat(40), OTHER = "d".repeat(40), LATER = "e".repeat(40), SOLO = "f".repeat(40), FLAT = "9".repeat(40);
const T = "0".repeat(40);
beforeAll(() => setRetryBaseMs(1));
afterAll(() => setRetryBaseMs());

async function setup(name: string, policy: Record<string, unknown> = {}) {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const record = { name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: [], ...policy }, createdAt: AT };
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  // main: LATER (main moved on since) <- MERGE (BASE, HEAD) <- BASE; OTHER is
  // a merge the baseline holds but main does not; SOLO is a plain commit on main.
  let main = [
    { hash: LATER, parents: [MERGE], treeHash: T },
    { hash: MERGE, parents: [BASE, HEAD], treeHash: T },
    { hash: SOLO, parents: [BASE], treeHash: T },
    // A merge as a history-since baseline rebuilds it: one parent (t726).
    { hash: FLAT, parents: [BASE], treeHash: T },
    { hash: BASE, parents: [], treeHash: T },
  ];
  const elsewhere = [{ hash: OTHER, parents: [BASE, HEAD], treeHash: T }];
  const revoked: string[] = [];
  let revokeFails = false;
  // A pause in the baseline's reads: readCommit waits on it while it is set.
  let pause: Promise<void> | null = null, reading: () => void = () => {};
  const paused = new Promise<void>((ok) => { reading = ok; });
  let forkPause: Promise<void> | null = null, forking: () => void = () => {}, minted = 0;
  const forkStarted = new Promise<void>((ok) => { forking = ok; });
  let forkResume: () => void = () => {};
  const holdFork = () => { forkPause = new Promise<void>((ok) => { forkResume = () => { forkPause = null; ok(); }; }); return { started: forkStarted, resume: () => forkResume() }; };
  const artifacts = {
    get: async () => ({
      log: async () => main,
      readCommit: async (hash: string) => { if (pause) { reading(); await pause; } return [...main, ...elsewhere].find((c) => c.hash === hash) ?? null; },
      // A fork waits while forkPause is set, as Artifacts takes its time making one.
      fork: async () => { if (forkPause) { forking(); await forkPause; } return {}; },
      info: async () => ({ remote: "https://git.test/repo", defaultBranch: "main" }),
      createToken: async () => ({ id: `tok-${++minted}`, plaintext: "secret", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
      revokeToken: async (id: string) => { if (revokeFails) throw new Error("INTERNAL_ERROR: Artifacts is unavailable"); revoked.push(id); },
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
  const request = (method: string, path: string, token: string, actor: string, body: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "x-atelier-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body),
  }), { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS: artifacts } as typeof env);
  const call = (id: string, body: unknown, actor = "owner", token = TOKEN) => request("POST", `/projects/${name}/items/${id}/record-merge`, token, actor, body);
  const issue = async (body: unknown) => (await (await request("POST", "/tokens", TOKEN, "owner", body)).json() as { token: string }).token;
  let resume: () => void = () => {};
  const hold = () => { pause = new Promise<void>((ok) => { resume = () => { pause = null; ok(); }; }); return { paused, resume: () => resume() }; };
  return { L, call, issue, request, holdFork, revoked, hold, failRevoke: (fails: boolean) => { revokeFails = fails; }, dropMerge: () => { main = main.filter((c) => c.hash !== MERGE && c.hash !== LATER); } };
}
const reviews = [{ by: ASTRA, verdict: "approve", head: HEAD, at: "2026-10-13" }, { by: ARGON, verdict: "approve", head: HEAD }];
const refusal = async (r: Response, status: number, code: string, detail?: RegExp) => {
  const body = await r.json() as { error: string; detail: string };
  expect([r.status, body.error], body.detail).toEqual([status, code]);
  if (detail) expect(body.detail).toMatch(detail);
};

it("records a claimed task merged outside Atelier, with its merge, the commit merged and the reviews as given", async () => {
  const { L, call, revoked } = await setup("record-merge-ok");
  const item = await L.newItem("Built outside the gate", [], "owner");
  const { generation } = await L.claim(item.id, BUILDER);
  expect(await L.recordToken(item.id, BUILDER, generation, null, "tok-1")).toBe(true);
  await L.setFork(item.id, "record-merge-ok--t1", BASE, BUILDER);
  const r = await call(item.id, { mergeCommit: MERGE, head: HEAD, reviews, note: "merged under the freeze" });
  expect(r.status, await r.clone().text()).toBe(200);
  const got = await r.json() as { item: { state: string; owner: string | null; head: string; acceptedHead: string | null }; record: Record<string, unknown> };
  expect(got.item).toMatchObject({ state: "merged", owner: null, head: HEAD, acceptedHead: null });
  expect(got.record).toMatchObject({ mergeCommit: MERGE, commit: HEAD, reviews, note: "merged under the freeze", outside: true, by: "owner" });
  // The workspace token goes with the claim.
  expect(await L.tokenId(item.id)).toBeNull();
  expect(revoked).toEqual(["tok-1"]);
  const events = (await L.events(item.id)) as unknown as LedgerEvent[];
  expect(events.find((e) => e.kind === "item.merged")?.data).toEqual({ mergeCommit: MERGE, head: HEAD, observedOnBaseline: true, outside: true });
  expect(events.find((e) => e.kind === "item.merge_recorded")?.data).toMatchObject({ mergeCommit: MERGE, commit: HEAD, reviews, outside: true });
  // Nothing says it was accepted or reviewed through the gate.
  expect(events.map((e) => e.kind)).not.toEqual(expect.arrayContaining(["item.accepted"]));
  expect(events.some((e) => e.kind === "review.approved")).toBe(false);
  // The task's page says so plainly.
  const html = renderItem(await L.project(), await L.detail(item.id));
  expect(html).toMatch(/Merged outside Atelier<\/strong>, recorded afterwards by owner/);
  expect(html).toContain("did not pass through the gate, and no checks or test receipt are recorded");
  expect(html).toMatch(/codex\/gpt-6-astra approved <code>bbbbbbbbbbbb<\/code> \(2026-10-13\)/);
  // The same record again is answered with the first; another merge is refused.
  expect((await call(item.id, { mergeCommit: MERGE, head: HEAD, reviews })).status).toBe(200);
  await refusal(await call(item.id, { mergeCommit: OTHER, head: HEAD, reviews }), 409, "closed");
  expect(((await L.events(item.id)) as unknown as LedgerEvent[]).filter((e) => e.kind === "item.merged")).toHaveLength(1);
});

it("takes the task's recorded head when no head is named", async () => {
  const { L, call } = await setup("record-merge-pushed");
  const item = await L.newItem("Pushed, then merged by hand", [], "owner");
  const { generation } = await L.claim(item.id, BUILDER);
  await L.setFork(item.id, "record-merge-pushed--t1", BASE, BUILDER);
  await L.recordToken(item.id, BUILDER, generation, null, "tok-pushed");
  await L.recordPush(item.id, BUILDER, HEAD, HEAD);
  const r = await call(item.id, { mergeCommit: MERGE, reviews });
  expect(r.status, await r.clone().text()).toBe(200);
  expect((await r.json() as { record: { commit: string } }).record.commit).toBe(HEAD);
  expect(((await L.events(item.id)) as unknown as LedgerEvent[]).find((e) => e.kind === "item.merge_recorded")?.data.recordedHead).toBeUndefined();
});

// t767 round 2 (Astra): the command that replaced fast land omitted --head. A
// fast build never pushes a task head, so the route had none to default to
// and the suggested command failed. The test takes the command as printed,
// reads its --head and sends what it names.
it("the command suggested for a fast build carries the built commit as --head, and the route accepts it where it refuses without", async () => {
  const { L, call } = await setup("record-merge-fast");
  const item = await L.newItem("Built in fast mode", [], "owner");
  const { generation } = await L.claim(item.id, BUILDER);
  await L.setFork(item.id, "record-merge-fast--t1", BASE, BUILDER);
  await L.recordToken(item.id, BUILDER, generation, null, "tok-fast");
  const command = recordMergeCommand(item.id, HEAD);
  const word = (flag: string) => command.split(" ")[command.split(" ").indexOf(flag) + 1];
  expect(word("--head")).toBe(HEAD);
  expect(word("--review")).toBe(`H/M=approve@${HEAD}`);
  // Without --head: no pushed head, so the route refuses.
  expect((await call(item.id, { mergeCommit: MERGE, reviews })).status).not.toBe(200);
  const r = await call(item.id, { mergeCommit: MERGE, head: word("--head"), reviews });
  expect(r.status, await r.clone().text()).toBe(200);
  expect((await r.json() as { record: { commit: string } }).record.commit).toBe(HEAD);
});

it("refuses an agent: only the developer records a merge", async () => {
  const { L, call, issue } = await setup("record-merge-agent");
  const item = await L.newItem("Agent tries", [], "owner");
  await L.claim(item.id, BUILDER);
  const body = { mergeCommit: MERGE, head: HEAD, reviews };
  // The developer's token naming an agent.
  await refusal(await call(item.id, body, BUILDER), 403, "not_project_owner");
  await refusal(await call(item.id, body, ASTRA), 403, "not_project_owner");
  // An agent token and a runner token, under their own names and naming the
  // developer (an agent token is bound to its actor, a runner token to its jobs).
  const agent = await issue({ actor: BUILDER, projects: ["record-merge-agent"] });
  const runner = await issue({ runner: "home:studio", projects: ["record-merge-agent"] });
  for (const [token, actor, code] of [[agent, BUILDER, "owner_token_required"], [agent, "owner", "actor_mismatch"], [runner, ASTRA, "runner_forbidden"], [runner, "owner", "runner_forbidden"]] as const) {
    await refusal(await call(item.id, body, actor, token), 403, code);
  }
  expect(await L.item(item.id)).toMatchObject({ state: "claimed", owner: BUILDER });
  // The Ledger refuses it too, whatever the route.
  const err = await L.recordMerge(item.id, BUILDER, { mergeCommit: MERGE, commit: HEAD, reviews }, { parents: [BASE, HEAD], holds: true }, { fork: null, token: null }).then(() => null, (e: unknown) => e as Error);
  expect(err?.message).toMatch(/not_project_owner/);
});

it("refuses when main does not hold the merge commit", async () => {
  const { L, call, dropMerge } = await setup("record-merge-absent");
  const item = await L.newItem("Merged on a laptop only", [], "owner");
  // A merge the baseline has, but not on main.
  await refusal(await call(item.id, { mergeCommit: OTHER, head: HEAD, reviews }), 409, "merge_not_on_main", /main does not hold dddddddd.*atelier sync/);
  // A merge the baseline has never seen: main was not synced.
  dropMerge();
  await refusal(await call(item.id, { mergeCommit: MERGE, head: HEAD, reviews }), 409, "merge_not_on_main", /baseline has no commit cccccccc/);
  expect((await L.item(item.id)).state).toBe("open");
});

it("refuses when the merge commit's second parent is not the task's head, or it is not a merge", async () => {
  const { L, call } = await setup("record-merge-parent");
  const item = await L.newItem("Wrong commit named", [], "owner");
  await refusal(await call(item.id, { mergeCommit: MERGE, head: OTHER, reviews: [{ by: ASTRA, verdict: "approve", head: OTHER }] }), 409, "second_parent_differs", /second parent is bbbbbbbb, not dddddddd/);
  await refusal(await call(item.id, { mergeCommit: SOLO, head: HEAD, reviews }), 409, "not_a_merge");
  // No head named and none pushed: nothing to compare with.
  await refusal(await call(item.id, { mergeCommit: MERGE, reviews }), 400, "bad_record", /commit merged/);
  // A fork's base is not a head the task pushed.
  const forked = await L.newItem("Forked, nothing pushed", [], "owner");
  await L.claim(forked.id, BUILDER);
  await L.setFork(forked.id, "record-merge-parent--t2", BASE, BUILDER);
  await refusal(await call(forked.id, { mergeCommit: MERGE, reviews }), 400, "bad_record", /commit merged/);
  // The reviews must approve the commit merged.
  await refusal(await call(item.id, { mergeCommit: MERGE, head: HEAD, reviews: [{ by: ASTRA, verdict: "reject", head: HEAD }] }), 400, "no_approval");
  expect((await L.item(item.id)).state).toBe("open");
  expect(((await L.events(item.id)) as unknown as LedgerEvent[]).some((e) => e.kind === "item.merged" || e.kind === "item.merge_recorded")).toBe(false);
});

// gpt-6-astra's review of t653: the record dropped the workspace token
// before revoking it, so a revocation that failed left the token live with
// no record of it, and the retry, reading no token, never revoked it. The
// token is revoked first now, as abandon and release do.
it("a revocation that fails changes nothing, and the retry revokes the token and records the merge", async () => {
  const { L, call, revoked, failRevoke } = await setup("record-merge-revoke");
  const item = await L.newItem("Claimed with a live token", [], "owner");
  const { generation } = await L.claim(item.id, BUILDER);
  expect(await L.recordToken(item.id, BUILDER, generation, null, "tok-live")).toBe(true);
  await L.setFork(item.id, "record-merge-revoke--t1", BASE, BUILDER);
  const body = { mergeCommit: MERGE, head: HEAD, reviews };
  failRevoke(true);
  await refusal(await call(item.id, body), 503, "revoke_failed", /nothing was changed/);
  expect(await L.item(item.id)).toMatchObject({ state: "claimed", owner: BUILDER });
  expect(await L.tokenId(item.id)).toBe("tok-live");
  expect(((await L.events(item.id)) as unknown as LedgerEvent[]).some((e) => e.kind === "item.merge_recorded")).toBe(false);
  failRevoke(false);
  expect((await call(item.id, body)).status).toBe(200);
  expect(revoked).toEqual(["tok-live"]);
  expect(await L.tokenId(item.id)).toBeNull();
  expect((await L.item(item.id)).state).toBe("merged");
});

// gpt-6-astra's second review of t653: the route revoked with the fork read
// before the baseline reads and the token read after, so a first claim made
// while the baseline was read (fork and token both new) was revoked with no
// repository, which revoke passed over, and the record then took the live
// token off the record. The fork and token are read together now, after the
// baseline reads, and a token with no repository is refused.
it("a first claim made while the baseline is read leaves no live write token", async () => {
  const { L, call, revoked, hold } = await setup("record-merge-race");
  const item = await L.newItem("Open when the record starts", [], "owner");
  const { paused, resume } = hold();
  const pending = call(item.id, { mergeCommit: MERGE, head: HEAD, reviews });
  await paused;
  // The task's first claim completes meanwhile: the claim, its fork, its write token.
  const { generation } = await L.claim(item.id, BUILDER);
  await L.setFork(item.id, "record-merge-race--t1", BASE, BUILDER);
  expect(await L.recordToken(item.id, BUILDER, generation, null, "tok-race")).toBe(true);
  resume();
  const r = await pending;
  // Either the token was revoked and the merge recorded, or nothing changed
  // and the token is still on the record to revoke; never a token live and
  // off the record.
  const token = await L.tokenId(item.id);
  expect(revoked.includes("tok-race") || token === "tok-race", `${r.status} ${await r.clone().text()}`).toBe(true);
  expect(r.status, await r.clone().text()).toBe(200);
  expect(revoked).toEqual(["tok-race"]);
  expect(token).toBeNull();
  expect((await L.item(item.id)).state).toBe("merged");
});

it("refuses the record when the workspace changes after it was read, and drops no token", async () => {
  const { L } = await setup("record-merge-moved");
  const item = await L.newItem("Claimed after the read", [], "owner");
  const workspace = await L.workspaceOf(item.id);
  const { generation } = await L.claim(item.id, BUILDER);
  await L.setFork(item.id, "record-merge-moved--t1", BASE, BUILDER);
  await L.recordToken(item.id, BUILDER, generation, null, "tok-new");
  const err = await L.recordMerge(item.id, "owner", { mergeCommit: MERGE, commit: HEAD, reviews }, { parents: [BASE, HEAD], holds: true }, workspace).then(() => null, (e: unknown) => e as Error);
  expect(err?.message).toMatch(/workspace_changed/);
  expect(await L.tokenId(item.id)).toBe("tok-new");
  expect((await L.item(item.id)).state).toBe("claimed");
});

// gpt-6-astra's third review of t653: a first claim waiting on Artifacts for
// its fork, a record-merge made meanwhile, and then the claim's setFork,
// which replaced the merged task's head with the fork's base. Record-merge
// now refuses while a claim is in flight (held, workspace not complete), and
// setFork refuses a task its claim no longer holds.
it("refuses the record while a claim is in flight, through the real claim route, and the claim then completes", async () => {
  const { L, call, issue, request, holdFork } = await setup("record-merge-inflight");
  const item = await L.newItem("Claimed while the merge is recorded", [], "owner");
  const agent = await issue({ actor: BUILDER, projects: ["record-merge-inflight"] });
  const { started, resume } = holdFork();
  const claiming = request("POST", `/projects/record-merge-inflight/items/${item.id}/claim`, agent, BUILDER, {});
  await started;
  // The claim holds the task; its fork is being made.
  expect(await L.item(item.id)).toMatchObject({ state: "claimed", owner: BUILDER, fork: null });
  await refusal(await call(item.id, { mergeCommit: MERGE, head: HEAD, reviews }), 409, "claim_in_flight", /being claimed by claude-code\/opus-5\.5/);
  resume();
  const claimed = await claiming;
  expect(claimed.status, await claimed.clone().text()).toBe(200);
  const now = await L.item(item.id);
  expect(now).toMatchObject({ state: "claimed", owner: BUILDER });
  expect(now.fork).not.toBeNull();
  expect(((await L.events(item.id)) as unknown as LedgerEvent[]).some((e) => e.kind === "item.merged")).toBe(false);
});

it("a fork recorded after the task was merged or claimed again is refused, and the merged head is unchanged", async () => {
  const { L, call } = await setup("record-merge-late-fork");
  // A claim reserves the task and pauses before setFork; the developer
  // abandons the task meanwhile (record-merge itself refuses a claim in flight).
  const item = await L.newItem("Abandoned under a pending claim", [], "owner");
  const { generation } = await L.claim(item.id, BUILDER);
  await L.abandon(item.id, "owner", "merged by hand; recorded elsewhere");
  const late = await L.setFork(item.id, "record-merge-late-fork--t1", BASE, BUILDER, false, generation).then(() => null, (e: unknown) => e as Error);
  expect(late?.message).toMatch(/claim_superseded/);
  expect(await L.item(item.id)).toMatchObject({ state: "abandoned", fork: null, head: null });
  // A merged task: its claim completed, the merge recorded, then a stale
  // setFork of that claim arrives.
  const merged = await L.newItem("Merged, then a stale fork", [], "owner");
  const claim = await L.claim(merged.id, BUILDER);
  await L.setFork(merged.id, "record-merge-late-fork--t2", BASE, BUILDER, false, claim.generation);
  await L.recordToken(merged.id, BUILDER, claim.generation, null, "tok-m");
  expect((await call(merged.id, { mergeCommit: MERGE, head: HEAD, reviews })).status).toBe(200);
  const stale = await L.setFork(merged.id, "record-merge-late-fork--t2", BASE, BUILDER, false, claim.generation).then(() => null, (e: unknown) => e as Error);
  expect(stale?.message).toMatch(/claim_superseded/);
  expect(await L.item(merged.id)).toMatchObject({ state: "merged", head: HEAD });
  // Another claim's generation is refused too.
  const other = await L.newItem("Claimed again", [], "owner");
  const first = await L.claim(other.id, BUILDER);
  const wrong = await L.setFork(other.id, "record-merge-late-fork--t3", BASE, BUILDER, false, first.generation + 1).then(() => null, (e: unknown) => e as Error);
  expect(wrong?.message).toMatch(/claim_superseded/);
});

// antigravity/gemini-4-argon's review of t653 (round 4): claimInFlight
// inferred a claim from the fork, the token and the last claim event, so a
// handed-off task (its token dropped, no claim in flight) was refused, and a
// claim reserved without an item.claimed event (a re-claim by the holder, or
// a claim after a fast take) was missed. A claim is in flight now exactly
// when its reserved generation (claim_pending) has not completed.
it("a handed-off task is recorded: no claim is in flight after a handoff", async () => {
  const { L, call } = await setup("record-merge-handoff");
  const item = await L.newItem("Handed off, then merged by hand", [], "owner");
  const { generation } = await L.claim(item.id, BUILDER);
  await L.setFork(item.id, "record-merge-handoff--t1", BASE, BUILDER, false, generation);
  await L.recordToken(item.id, BUILDER, generation, null, "tok-h");
  await L.handoff(item.id, "owner", ASTRA, "the freeze moved it", false, "tok-h");
  expect(await L.item(item.id)).toMatchObject({ state: "claimed", owner: ASTRA });
  expect(await L.tokenId(item.id)).toBeNull();
  const r = await call(item.id, { mergeCommit: MERGE, head: HEAD, reviews });
  expect(r.status, await r.clone().text()).toBe(200);
  expect((await L.item(item.id)).state).toBe("merged");
});

it("refuses the record while the holder's re-claim is in flight, and records it once the re-claim completes", async () => {
  const { L, call } = await setup("record-merge-reclaim");
  const item = await L.newItem("Re-claimed by its holder", [], "owner");
  const first = await L.claim(item.id, BUILDER);
  await L.setFork(item.id, "record-merge-reclaim--t1", BASE, BUILDER, false, first.generation);
  await L.recordToken(item.id, BUILDER, first.generation, null, "tok-1");
  // The holder claims again: a new generation, the fork and old token still recorded.
  const again = await L.claim(item.id, BUILDER);
  expect(again.generation).toBeGreaterThan(first.generation);
  await refusal(await call(item.id, { mergeCommit: MERGE, head: HEAD, reviews }), 409, "claim_in_flight");
  expect(await L.recordToken(item.id, BUILDER, again.generation, "tok-1", "tok-2")).toBe(true);
  expect((await call(item.id, { mergeCommit: MERGE, head: HEAD, reviews })).status).toBe(200);
});

it("records a fast take, and refuses a claim in flight after it", async () => {
  const { L, call } = await setup("record-merge-fast");
  const item = await L.newItem("Taken fast", [], "owner");
  await L.dispatch(item.id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  await L.confirmFastMode("owner", "access");
  await L.setMode("owner", "fast", "Artifacts fails every new fork");
  const runner = { runner: "home:studio", kind: "home" } as const;
  await L.takeFast(item.id, ASTRA, runner);
  expect(await L.item(item.id)).toMatchObject({ state: "claimed", owner: ASTRA, fork: null });
  // The holder's claim after the take reserves a generation with no item.claimed event.
  await L.claim(item.id, ASTRA, runner);
  await refusal(await call(item.id, { mergeCommit: MERGE, head: HEAD, reviews }), 409, "claim_in_flight");
  // A fast take alone is complete: no claim is in flight.
  const other = await L.newItem("Taken fast, merged by hand", [], "owner");
  await L.dispatch(other.id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  await L.takeFast(other.id, ASTRA, runner);
  const r = await call(other.id, { mergeCommit: MERGE, head: HEAD, reviews });
  expect(r.status, await r.clone().text()).toBe(200);
});

// t726: on a baseline built with --history-since the merge commit is rebuilt
// with one parent, so record-merge refused every merge made outside Atelier
// (not_a_merge, or merge_not_on_main for the project's own hash). The CLI
// checks the second parent in the checkout and names the baseline commit
// paired with the merge; the baseline need only hold that commit.
it("records a merge the baseline holds flattened, when the CLI names the baseline commit paired with it", async () => {
  const { L, call } = await setup("record-merge-flat");
  const item = await L.newItem("Merged on a history-since baseline", [], "owner");
  const { generation } = await L.claim(item.id, BUILDER);
  await L.setFork(item.id, "record-merge-flat--t1", BASE, BUILDER);
  await L.recordToken(item.id, BUILDER, generation, null, "tok-flat");
  const project = "1".repeat(40);
  const r = await call(item.id, { mergeCommit: project, baselineMerge: FLAT, head: HEAD, reviews });
  expect(r.status, await r.clone().text()).toBe(200);
  expect((await r.json() as { record: Record<string, unknown> }).record).toMatchObject({ mergeCommit: project, baselineMerge: FLAT, commit: HEAD });
  expect(await L.item(item.id)).toMatchObject({ state: "merged", head: HEAD });
});

it("still refuses a merge the baseline cannot map, naming atelier sync, and the project's hash without a pairing", async () => {
  const { L, call } = await setup("record-merge-unmapped");
  const item = await L.newItem("Unmapped", [], "owner");
  const { generation } = await L.claim(item.id, BUILDER);
  await L.setFork(item.id, "record-merge-unmapped--t1", BASE, BUILDER);
  await L.recordToken(item.id, BUILDER, generation, null, "tok-unmapped");
  // The task has a pushed head, which a missing head would otherwise pick up.
  await L.recordPush(item.id, BUILDER, HEAD, HEAD);
  // The project's hash is on the baseline, but its pairing is not: the pairing decides.
  await refusal(await call(item.id, { mergeCommit: MERGE, baselineMerge: "2".repeat(40), head: HEAD, reviews }), 409, "merge_not_on_main", /atelier sync/);
  // A pairing without the head the CLI checked is refused, not completed with the task's current head.
  await refusal(await call(item.id, { mergeCommit: "1".repeat(40), baselineMerge: FLAT, reviews }), 400, "bad_record", /paired baseline commit also names the head/);
  await refusal(await call(item.id, { mergeCommit: "1".repeat(40), head: HEAD, reviews }), 409, "merge_not_on_main", /atelier sync/);
  // A pairing is not a way past main: a commit only another branch holds is refused.
  await refusal(await call(item.id, { mergeCommit: "1".repeat(40), baselineMerge: OTHER, head: HEAD, reviews }), 409, "merge_not_on_main", /atelier sync/);
  expect(await L.item(item.id)).toMatchObject({ state: "claimed" });
});

// t754: the 2026-10-17 status listed a ship for every merge whose deploy the
// orchestrator's post-merge script had already run outside atelier ship, so
// the waiting list was mostly noise. --shipped records that run with the merge.
it("--shipped counts as the run of the declared protected actions, so no ship is owed for that merge", async () => {
  const { L, call } = await setup("record-merge-shipped", { shipKinds: ["deploy", "install"] });
  const ships = async () => (await L.inbox(new Date().toISOString())).filter((e) => e.kind === "ship").map((e) => e.itemId);
  const owed = await L.newItem("Deployed before it was recorded", [], "owner");
  const unshipped = await L.newItem("Recorded without saying it shipped", [], "owner");
  // The note is text, not empty and not long; a refused record changes nothing.
  for (const shipped of ["", "   ", 7, "x".repeat(501)]) await refusal(await call(owed.id, { mergeCommit: MERGE, head: HEAD, reviews, shipped }), 400, "bad_record", /what ran is a short note/);
  expect((await L.item(owed.id)).state).not.toBe("merged");
  expect((await call(owed.id, { mergeCommit: MERGE, head: HEAD, reviews, shipped: " deploy version 3f9a " })).status).toBe(200);
  expect((await call(unshipped.id, { mergeCommit: MERGE, head: HEAD, reviews })).status).toBe(200);
  // Only the merge recorded without the note is still owed.
  expect(await ships()).toEqual([unshipped.id]);
  const runs = (await L.actionRuns()).filter((r) => r.ship === `recorded-${owed.id}`);
  expect(runs.map((r) => [r.kind, r.step, r.approval, r.command, r.passed, r.note])).toEqual([["install", "recorded", null, null, true, "deploy version 3f9a"], ["deploy", "recorded", null, null, true, "deploy version 3f9a"]]);
  expect(((await L.events(owed.id)) as unknown as LedgerEvent[]).find((e) => e.kind === "item.merge_recorded")?.data.shipped).toBe("deploy version 3f9a");
  // A repeat of the same record adds no second run.
  expect((await call(owed.id, { mergeCommit: MERGE, head: HEAD, reviews, shipped: "again" })).status).toBe(200);
  expect((await L.actionRuns()).filter((r) => r.ship === `recorded-${owed.id}`)).toHaveLength(2);
});

it("a ship recorded after an older merge retires the ship that merge owed, and a merge recorded after the ship still owes one", async () => {
  const { L, call } = await setup("record-merge-later-ship", { shipKinds: ["deploy"] });
  const ships = async () => (await L.inbox(new Date().toISOString())).filter((e) => e.kind === "ship").map((e) => e.itemId);
  const older = await L.newItem("Merged first", [], "owner");
  const newer = await L.newItem("Merged after the ship", [], "owner");
  expect((await call(older.id, { mergeCommit: MERGE, head: HEAD, reviews })).status).toBe(200);
  expect(await ships()).toEqual([older.id]);
  // A deploy of a later main head, recorded as atelier ship records it.
  await L.approveAction({ kind: "deploy", commit: LATER }, "owner");
  await L.consumeAction({ kind: "deploy", commit: LATER }, "owner");
  await L.recordActionRun({ step: "deploy", kind: "deploy", approval: "a1", command: "npx wrangler deploy", commit: LATER, exitStatus: 0, durationMs: 900, passed: true, outputTail: "", ship: "s-1" }, "owner");
  expect(await ships()).toEqual([]);
  expect((await call(newer.id, { mergeCommit: MERGE, head: HEAD, reviews })).status).toBe(200);
  expect(await ships()).toEqual([newer.id]);
});
