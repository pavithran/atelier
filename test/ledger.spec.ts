import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { briefFor } from "../src/brief.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { parseRuleError, type Evidence, type ProjectPolicy, type Review } from "../src/rules.ts";

// The Ledger driven end to end over Durable Object RPC, with its real SQLite
// storage, inside the Workers test pool. The pure policy underneath is tested
// in test/rules.test.ts; what these tests cover is the storage, the event log
// and the refusals crossing the RPC boundary. Workerd logs each of those
// refusals as an "uncaught exception (in promise)"; those lines are the
// refusals under test, not failures.

const H0 = "0".repeat(40);
const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const A = "claude-code/opus-5.5";
const B = "codex/gpt-5.5";

const policy: ProjectPolicy = { checks: ["npm test"], protected: ["AGENTS.md", "wrangler.*"] };

// One Durable Object instance per project name, so every test starts from an
// empty ledger regardless of how the pool isolates storage.
function ledger(project: string) {
  return env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
}

async function setup(project: string, p: ProjectPolicy = policy) {
  const L = ledger(project);
  await L.setProject({ name: project, repo: `${project}--baseline`, policy: p, createdAt: new Date().toISOString() }, "owner");
  return L;
}

function observed(itemId: string, head: string, changedPaths: string[] = ["src/a.ts"]): Evidence {
  return { itemId, claim: "npm test", grade: "observed", head, passed: true, by: "owner", at: new Date().toISOString(), changedPaths };
}

function review(itemId: string, by: string, head: string, approve: boolean, note = ""): Review {
  return { itemId, by, head, approve, note, at: new Date().toISOString() };
}

// A refusal must arrive with its code and detail intact: the worker turns
// whatever crosses the RPC boundary back into an HTTP status with `parseRuleError`.
async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(
    () => new Error(`expected a ${code} refusal`),
    (e: unknown) => e as Error,
  );
  const parsed = parseRuleError(err);
  expect(parsed?.code).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

// The generated stub types type `events()` and `detail()` as `never`, because
// LedgerEvent.data is Record<string, unknown> and the RPC serializable-subset
// type rejects it; workerd passes the values through regardless. Event kinds
// are therefore read through this cast, and detail() is asserted whole.
function kinds(events: unknown): string[] {
  return (events as LedgerEvent[]).map((e) => e.kind);
}

it("the index instance lists the registered projects", async () => {
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.registerProject({ name: "zeta", repo: "zeta", policy, createdAt: new Date().toISOString() });
  await index.registerProject({ name: "alpha", repo: "alpha", policy, createdAt: new Date().toISOString() });
  expect((await index.projects()).map((p) => p.name)).toEqual(["alpha", "zeta"]);
});

it("an item moves from creation to merge, gated by observed evidence", async () => {
  const L = await setup("lifecycle");
  await refusal(L.newItem("", [], "owner"), "bad_title", /an item needs a title/);
  const item = await L.newItem("Test the ledger end to end", ["src/**", "test/**"], "owner");
  expect(item).toMatchObject({ id: "t1", state: "open", owner: null });

  const claimed = await L.claim("t1", A);
  expect(claimed).toMatchObject({ item: { state: "claimed", owner: A }, needsFork: true });
  await L.setFork("t1", "lifecycle--t1", H0, A);

  await refusal(L.submit("t1", A), "nothing_pushed", /push work before submitting/);
  await L.recordPush("t1", A, H1, H1);
  await refusal(L.accept("t1", "owner"), "not_ready", /state is claimed, not submitted/);
  await L.addEvidence(observed("t1", H1, ["src/ledger.ts"]));
  await L.submit("t1", A);

  expect(await L.detail("t1")).toMatchObject({ gate: { ready: true, blockers: [], needsAssessor: false, outOfScope: [] } });
  expect((await L.inbox(new Date().toISOString())).map((e) => `${e.itemId}:${e.kind}`)).toEqual(["t1:accept"]);

  const accepted = await L.accept("t1", "owner");
  expect(accepted).toMatchObject({ state: "accepted", acceptedHead: H1, owner: A });
  const merged = await L.merged("t1", "owner", "m1", true);
  expect(merged).toMatchObject({ state: "merged", owner: null });
  expect(await L.owners()).toEqual([]);
  expect(kinds(await L.events("t1"))).toEqual([
    "item.merged", "item.accepted", "item.submitted", "evidence.observed", "push.observed",
    "fork.created", "item.claimed", "item.created",
  ]);
});

it("a protected path is accepted only after an independent approval", async () => {
  const L = await setup("protected");
  await L.newItem("Touch a protected path", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "protected--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);
  await L.addEvidence(observed("t1", H1, ["src/ledger.ts", "AGENTS.md"]));
  await L.submit("t1", A);

  await refusal(L.accept("t1", B), "not_project_owner", /only the project owner accepts/);
  await refusal(L.accept("t1", "owner"), "not_ready", /touches a protected path/);
  await refusal(L.addReview(review("t1", A, H1, true)), "self_review", /cannot review their own/);
  await L.addReview(review("t1", "codex/opus-5.5", H1, true));
  await refusal(L.accept("t1", "owner"), "not_ready", /protected path/);

  await L.addReview(review("t1", B, H1, true, "independent model, looks right"));
  const accepted = await L.accept("t1", "owner");
  expect(accepted).toMatchObject({ state: "accepted", acceptedHead: H1, owner: A });

  await refusal(L.merged("t1", B, "m1", true), "not_project_owner", /only the project owner merges/);
  const merged = await L.merged("t1", "owner", "m1", true);
  expect(merged).toMatchObject({ state: "merged", owner: null });
});

it("exactly one owner: claims are serialised, scoped and eligible", async () => {
  const strict: ProjectPolicy = { checks: [], protected: [], eligible: ["claude", "codex"], refuseOverlap: true };
  const L = await setup("sole-owner", strict);
  await L.newItem("First", ["src/**"], "owner");
  await L.newItem("Second", ["src/ui/**"], "owner");
  await L.newItem("Third", ["docs/**"], "owner");

  await L.claim("t1", A);
  await refusal(L.claim("t1", B), "owned", /t1 is owned by claude-code\/opus-5\.5/);

  // Two claims racing on one item: the Durable Object handles one at a time,
  // so one lands and the other is refused; there is never a second owner.
  const raced = await Promise.allSettled([L.claim("t3", A), L.claim("t3", B)]);
  expect(raced.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  const winner = raced.find((r) => r.status === "fulfilled");
  expect(await L.item("t3")).toMatchObject({ owner: winner!.value.item.owner });

  await refusal(L.claim("t2", "glm/glm-4.6"), "ineligible", /glm is not an eligible agent/);
  await refusal(L.claim("t2", B), "overlap", /overlaps live t1 \(claude-code\/opus-5\.5\)/);
  // The holder of the overlapping item may take a second overlapping item.
  expect(await L.claim("t2", A)).toMatchObject({ item: { owner: A } });
});

it("a failed fork unclaims the item, and a re-claim does not fork again", async () => {
  const L = await setup("fork-failed");
  await L.newItem("One", ["src/**"], "owner");
  expect(await L.claim("t1", A)).toMatchObject({ needsFork: true });

  await L.unclaim("t1", A, "fork: repository quota exceeded");
  expect(await L.item("t1")).toMatchObject({ state: "open", owner: null });

  await L.claim("t1", B);
  await L.setFork("t1", "fork-failed--t1", H0, B);
  expect(await L.claim("t1", B)).toMatchObject({ needsFork: false });
  expect(kinds(await L.events("t1"))).toEqual(["fork.created", "item.claimed", "item.claim_failed", "item.claimed", "item.created"]);
});

it("evidence and reviews are refused at a stale head", async () => {
  const L = await setup("stale-head");
  await L.newItem("One", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "stale-head--t1", H0, A);

  await L.addEvidence(observed("t1", H0));
  await L.recordPush("t1", A, H1, H1);
  await refusal(L.addEvidence(observed("t1", H0)), "stale_head", /evidence is for 00000000 but the item is at aaaaaaaa/);
  await L.addEvidence(observed("t1", H1));

  await L.recordPush("t1", A, H2, H2);
  await refusal(L.addReview(review("t1", B, H1, true)), "stale_head", /review is for an older head/);
  await refusal(L.addEvidence(observed("t1", H1)), "stale_head", /evidence is for aaaaaaaa but the item is at bbbbbbbb/);
  await L.addReview(review("t1", B, H2, false, "regressed"));
  expect((await L.reviewsFor("t1")).map((r) => r.head)).toEqual([H2]);
});

it("ownership moves by handoff, ends by release or abandonment", async () => {
  const eligible: ProjectPolicy = { checks: [], protected: [], eligible: ["claude", "codex"] };
  const L = await setup("handoff", eligible);
  await L.newItem("One", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "handoff--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);

  await refusal(L.handoff("t1", A, "glm/glm-4.6", "no"), "ineligible", /glm is not an eligible agent/);
  const moved = await L.handoff("t1", A, B, "off to a second opinion");
  expect(moved).toMatchObject({ owner: B, state: "claimed" });

  await refusal(L.recordPush("t1", A, H2, H2), "not_owner", /claude-code\/opus-5\.5 does not own t1 \(owner: codex\/gpt-5\.5\)/);
  await L.recordPush("t1", B, H2, H2);
  await L.release("t1", B, "parked");
  expect(await L.item("t1")).toMatchObject({ state: "open", owner: null });

  await L.newItem("Two", ["docs/**"], "owner");
  await L.claim("t2", A);
  await refusal(L.abandon("t2", A, "not mine to end"), "not_project_owner", /only the project owner abandons/);
  expect(await L.abandon("t2", "owner", "obsolete")).toMatchObject({ state: "abandoned", owner: null });
});

it("the owners view reports live items without titles, scopes or paths", async () => {
  const L = await setup("owners-view");
  await L.newItem("A title with detail in it", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "owners-view--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);

  const owners = await L.owners();
  expect(owners).toHaveLength(1);
  expect(Object.keys(owners[0]).sort()).toEqual(["head", "item", "owner", "since", "state"]);
  expect(owners[0]).toMatchObject({ item: "t1", state: "claimed", owner: A, head: H1 });
});

it("acceptance is bound to the expected revision and a push event invalidates approval", async () => {
  const L=await setup('revision-bound');
  await L.newItem('Review this revision',['src/**'],'owner'); await L.claim('t1',A); await L.setFork('t1','revision--t1',H0,A);
  await L.recordPush('t1',A,H1,H1); await L.addEvidence(observed('t1',H1)); await L.submit('t1',A);
  await refusal(L.accept('t1','owner',H2),'stale_head',/changed since/);
  await L.accept('t1','owner',H1);
  await L.observePush('t1',H2,H1);
  expect(await L.item('t1')).toMatchObject({state:'submitted',head:H2,acceptedHead:null});
  await L.observePush('t1',H1,H0);
  expect((await L.item('t1')).head).toBe(H2);
});

it("completed tasks cannot be reopened by push, submit, release, or review", async () => {
  const L=await setup('closed-state');
  await L.newItem('Close safely',[],'owner'); await L.claim('t1',A); await L.setFork('t1','closed--t1',H0,A);
  await L.recordPush('t1',A,H1,H1); await L.addEvidence(observed('t1',H1)); await L.submit('t1',A); await L.accept('t1','owner',H1);
  await refusal(L.merged('t1','owner','merge',false),'unverified_merge',/not on the baseline/);
  await L.merged('t1','owner','merge',true); await L.merged('t1','owner','merge',true);
  await refusal(L.recordPush('t1',A,H2,H2),'closed',/merged/);
  await refusal(L.submit('t1',A),'closed',/merged/);
  await refusal(L.release('t1','owner',''),'closed',/merged/);
  await refusal(L.addReview(review('t1',B,H1,true)),'closed',/merged/);
  await L.observePush('t1',H2,H1);
  expect((await L.item('t1')).state).toBe('merged');
  expect(kinds(await L.events('t1')).filter(k=>k==='item.merged')).toHaveLength(1);
});

it("HTTP approval rejects missing and stale revisions before reading Artifacts", async () => {
  const {default:worker}=await import('../src/index');
  const L=await setup('http-review');await L.newItem('Bound form',[],'owner');await L.claim('t1',A);await L.setFork('t1','http--t1',H0,A);await L.recordPush('t1',A,H1,H1);
  const bindings={...env,ATELIER_TOKEN:'fixture-token'};
  for(const head of ['',H2]) {
    const form=new URLSearchParams({head,note:'test'});
    const res=await worker.fetch(new Request('https://atelier.test/ui/http-review/t1/approve',{method:'POST',headers:{authorization:'Bearer fixture-token',origin:'https://atelier.test'},body:form}),bindings);
    expect(res.status).toBe(head?409:400);
    expect((await L.reviewsFor('t1')).length).toBe(0);
  }
  const cross=await worker.fetch(new Request('https://atelier.test/ui/http-review/t1/approve',{method:'POST',headers:{authorization:'Bearer fixture-token',origin:'https://other.test'},body:new URLSearchParams({head:H1})}),bindings);
  expect(cross.status).toBe(403);
});

it("push events read the authoritative branch head and ignore duplicate or unrelated events", async () => {
  const {default:worker}=await import('../src/index');
  const L=await setup('events-project');await L.newItem('Observe pushes',[],'owner');await L.claim('t1',A);await L.setFork('t1','events-project--t1',H0,A);
  const index=env.LEDGER.get(env.LEDGER.idFromName('__index'));
  await index.registerProject({name:'events-project',repo:'events-project',policy,createdAt:new Date().toISOString()});
  let reads=0,acks=0,retries=0;
  const artifacts={get:async()=>({info:async()=>({defaultBranch:'main'}),log:async()=>{reads++;return[{hash:H2}]},[Symbol.dispose](){}})} as unknown as Artifacts;
  const notice={type:'cf.artifacts.repo.pushed',source:{namespace:'atelier',repoName:'events-project--t1'},payload:{ref:'refs/heads/main',after:H1}};
  const send=async(body:unknown)=>worker.queue({messages:[{body,ack(){acks++},retry(){retries++}}]} as unknown as MessageBatch<unknown>,{...env,ARTIFACTS:artifacts});
  await send(notice);await send(notice);await send({...notice,payload:{...notice.payload,ref:'refs/heads/other'}});
  expect((await L.item('t1')).head).toBe(H2);expect(acks).toBe(3);expect(retries).toBe(0);expect(reads).toBe(2);
  expect(kinds(await L.events('t1')).filter(k=>k==='push.observed')).toHaveLength(1);
});

it("HTTP review and acceptance preserve the displayed revision through successful form posts",async()=>{
 const {default:worker}=await import('../src/index');
 const L=await setup('http-success');await L.newItem('Approve safely',[],'owner');await L.claim('t1',A);await L.setFork('t1','http-success--t1',H0,A);await L.recordPush('t1',A,H1,H1);await L.addEvidence(observed('t1',H1,['AGENTS.md']));await L.submit('t1',A);
 const artifacts={get:async()=>({log:async()=>[{hash:H1}],[Symbol.dispose](){}})} as unknown as Artifacts;
 const bindings={...env,ARTIFACTS:artifacts,ATELIER_TOKEN:'fixture-token'};
 for(const action of ['approve','accept']){
  const res=await worker.fetch(new Request(`https://atelier.test/ui/http-success/t1/${action}`,{method:'POST',headers:{authorization:'Bearer fixture-token',origin:'https://atelier.test'},body:new URLSearchParams({head:H1,note:'Reviewed'})}),bindings);
  expect(res.status).toBe(303);
 }
 expect(await L.item('t1')).toMatchObject({state:'accepted',acceptedHead:H1});
 expect((await L.reviewsFor('t1'))[0].head).toBe(H1);
});

it("dispatch queues an open task for a kind of runner, and only a matching runner claims it", async () => {
  const L = await setup("dispatch-flow");
  const item = await L.newItem("Tidy the guide", ["docs/**"], "owner");
  await refusal(L.dispatch(item.id, A, { to: "home" }), "not_project_owner", /only the project owner dispatches/);

  const queued = await L.dispatch(item.id, "owner", { to: "home", agent: "opencode", model: "glm-5.3-flash", note: "small task" });
  expect(queued.dispatch).toMatchObject({ to: "home", agent: "opencode", model: "glm-5.3-flash", by: "owner", note: "small task" });
  expect((await L.waiting()).map((i) => i.id)).toEqual([item.id]);

  const home = { runner: "home:studio", kind: "home" as const };
  await refusal(L.claim(item.id, A), "dispatched", /waiting for a home runner/);
  await refusal(L.claim(item.id, "opencode/glm-5.3-flash", { runner: "cloud:atelier", kind: "cloud" }), "wrong_runner", /for a home runner/);
  await refusal(L.claim(item.id, "claude-code/opus-5.5", home), "wrong_agent", /asks for opencode/);

  const { item: claimed } = await L.claim(item.id, "opencode/glm-5.3-flash", home);
  expect(claimed).toMatchObject({ state: "claimed", owner: "opencode/glm-5.3-flash" });
  expect(await L.waiting()).toEqual([]);
  const events = (await L.events(item.id)) as unknown as LedgerEvent[];
  expect(events.find((e) => e.kind === "item.claimed")?.data).toEqual({ runner: "home:studio" });
  await refusal(L.dispatch(item.id, "owner", {}), "not_open", /owned by opencode/);

  // A runner that gives up releases the task, and it waits in the queue again.
  await L.release(item.id, "opencode/glm-5.3-flash", "out of time");
  expect((await L.waiting()).map((i) => i.id)).toEqual([item.id]);

  await L.undispatch(item.id, "owner");
  expect(await L.waiting()).toEqual([]);
  await refusal(L.undispatch(item.id, "owner"), "not_dispatched", /not waiting for a runner/);
  // Withdrawn, it is an ordinary open task again.
  const { item: byHand } = await L.claim(item.id, A);
  expect(byHand.owner).toBe(A);
  expect(kinds(await L.events(item.id))).toEqual(expect.arrayContaining(["item.dispatched", "item.undispatched", "item.released"]));
});

it("the queue lists the oldest dispatch first and skips tasks that are not open", async () => {
  const L = await setup("dispatch-order");
  const first = await L.newItem("First", ["a/**"], "owner");
  const second = await L.newItem("Second", ["b/**"], "owner");
  await L.dispatch(first.id, "owner", { to: "any" });
  await new Promise((ok) => setTimeout(ok, 5));
  await L.dispatch(second.id, "owner", { to: "cloud" });
  expect((await L.waiting()).map((i) => i.id)).toEqual([first.id, second.id]);
  await L.claim(first.id, "codex/gpt-6", { runner: "cloud:atelier", kind: "cloud" });
  expect((await L.waiting()).map((i) => i.id)).toEqual([second.id]);
});

it("a claim belongs to the runner that made it; the same agent name from another runner is refused", async () => {
  const L = await setup("runner-held");
  const item = await L.newItem("Edit", ["a/**"], "owner");
  await L.dispatch(item.id, "owner", { to: "home", agent: "opencode", model: "glm-5.3-flash" });
  const actor = "opencode/glm-5.3-flash";
  const studio = { runner: "home:studio", kind: "home" as const };
  const laptop = { runner: "home:laptop", kind: "home" as const };

  const { item: held } = await L.claim(item.id, actor, studio);
  expect(held.runner).toBe("home:studio");
  await refusal(L.claim(item.id, actor, laptop), "owned", /held by opencode\/glm-5.3-flash on home:studio, not home:laptop/);
  await refusal(L.claim(item.id, actor), "owned", /not a claim made without a runner/);
  // The holding runner may refresh its own claim.
  expect((await L.claim(item.id, actor, studio)).item.runner).toBe("home:studio");

  // A handoff ends the old runner's hold; the first runner to claim as the new owner adopts it.
  await L.handoff(item.id, "owner", "opencode/qwen3-coder-next", "try the coder");
  expect((await L.item(item.id)).runner).toBeNull();
  const { item: adopted } = await L.claim(item.id, "opencode/qwen3-coder-next", laptop);
  expect(adopted.runner).toBe("home:laptop");
  await refusal(L.claim(item.id, "opencode/qwen3-coder-next", studio), "owned", /on home:laptop, not home:studio/);
});

it("a submit records the summary in its event, cleaned and capped, and only the latest submit at a head speaks", async () => {
  const L = await setup("summary");
  await L.newItem("Summarise", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "summary--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);
  await L.submit("t1", A, `  Added the brief.\u0007\n${"x".repeat(900)}  `);
  const submitted = async () => ((await L.events("t1")) as unknown as LedgerEvent[]).filter((e) => e.kind === "item.submitted");
  const [first] = await submitted();
  const text = first.data.summary as string;
  expect(text).toHaveLength(600);
  expect(text.startsWith("Added the brief.  xxx")).toBe(true);
  expect(first.data.head).toBe(H1);
  expect(first.actor).toBe(A);

  // A new revision submitted without a summary has none, whatever came before.
  await L.recordPush("t1", A, H2, H2);
  await L.submit("t1", A);
  const detail = (await L.detail("t1")) as unknown as Parameters<typeof briefFor>[0];
  const events = detail.events;
  expect(detail.item.head).toBe(H2);
  expect(briefFor(detail, events).summary).toBeNull();
  expect((await submitted())[0].data).toEqual({ head: H2 });
  // The first revision's summary is still its own.
  expect(briefFor({ ...detail, item: { ...detail.item, head: H1 } }, events).summary).toBe(text);
});

it("the submit route passes an optional summary to the Ledger", async () => {
  const TOKEN = "summary-route-token";
  const L = await setup("summary-route");
  await L.newItem("Via the route", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "summary-route--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);
  const { default: worker } = await import("../src/index.ts");
  const res = await worker.fetch(new Request("https://atelier.test/api/projects/summary-route/items/t1/submit", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": A, "content-type": "application/json" },
    body: JSON.stringify({ summary: "  From the CLI.  " }),
  }), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
  expect(res.status).toBe(200);
  const [event] = ((await L.events("t1")) as unknown as LedgerEvent[]).filter((e) => e.kind === "item.submitted");
  expect(event.data.summary).toBe("From the CLI.");
});
