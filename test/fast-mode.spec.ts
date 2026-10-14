import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent, ReviewClaim } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { parseRuleError, type ProjectPolicy } from "../src/rules.ts";
import { signIn } from "./signin.ts";
import { renderItem, type Detail } from "../src/ui.ts";
import type { ShowcaseCounts } from "../src/graph.ts";

// Fast mode (t585). On 2026-10-13 Artifacts failed every new fork, so no
// task could be claimed, and four finished tasks were merged by hand,
// outside the record. Fast mode records that path: the owner's switch, a
// landed-fast receipt per task, and a post-merge review that a model of the
// builder's family may answer for a fast landing only.

const TOKEN = "fast-mode-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const AT = "2026-10-13T12:00:00.000Z";
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", SONNET = "claude-code/sonnet-5", GPT = "codex/gpt-6-astra";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("sonnet-5", "claude-code"), entry("gpt-6-astra", "codex")];
const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };
const C1 = "c".repeat(40), M1 = "d".repeat(40), M2 = "e".repeat(40);
const receipt = (commit: string, mergeCommit: string) => ({ commit, mergeCommit, builder: OPUS, tests: { command: "npm test", sha256: "f".repeat(64) } });

const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
async function project(name: string) {
  const record = { name, repo: `${name}--baseline`, policy, createdAt: AT };
  await ledger(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return ledger(name);
}
function api(method: string, path: string, actor: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}
async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code, err.message).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

it("the owner alone switches modes; fast is a standing decision until the switch back to full", async () => {
  const L = await project("fast-switch");
  expect(await L.mode()).toMatchObject({ mode: "full", line: "Mode: full" });
  await refusal(L.setMode(GPT, "fast", "forks fail"), "not_project_owner", /only the developer/);
  await refusal(L.setMode("owner", "fast", ""), "bad_reason", /needs a reason/);
  await L.confirmFastMode("owner", "access");
  const fast = await L.setMode("owner", "fast", "Artifacts fails every new fork");
  expect(fast).toMatchObject({ mode: "fast", reason: "Artifacts fails every new fork", decision: "d1" });
  expect(fast.line).toMatch(/^Mode: fast since \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(Artifacts fails every new fork\)$/);
  expect((await L.standingDecisions()).map((d) => d.text)).toEqual([expect.stringContaining("fast mode")]);
  const full = await L.setMode("owner", "full", undefined);
  expect(full).toMatchObject({ mode: "full", line: "Mode: full", landed: [] });
  expect(await L.standingDecisions()).toEqual([]);

  // Through the routes: any token reads, only the owner switches.
  expect((await api("POST", "/projects/fast-switch/mode", GPT, { mode: "fast", reason: "mine" })).status).toBe(403);
  await L.confirmFastMode("owner", "access");
  const made = await api("POST", "/projects/fast-switch/mode", "owner", { mode: "fast", reason: "forks fail" });
  expect(made.status).toBe(200);
  const read = await (await api("GET", "/projects/fast-switch/mode", GPT)).json() as { mode: string; line: string };
  expect(read).toMatchObject({ mode: "fast", line: expect.stringContaining("(forks fail)") });
  expect((await api("POST", "/projects/fast-switch/items/t1/landed-fast", GPT, receipt(C1, M1))).status).toBe(403);
});

it("a landing is refused in full mode, records its receipt in fast mode, and queues a same-family post-merge review", async () => {
  const L = await project("fast-land");
  const item = await L.newItem("Finished elsewhere", ["src/**"], "owner", { accept: ["Works"] });
  await refusal(L.landedFast(item.id, "owner", receipt(C1, M1)), "not_fast_mode", /full mode/);
  await L.confirmFastMode("owner", "access");
  await L.setMode("owner", "fast", "forks fail");
  await refusal(L.landedFast(item.id, GPT, receipt(C1, M1)), "not_project_owner", /only the developer/);
  const landed = await L.landedFast(item.id, "owner", receipt(C1, M1));
  expect(landed.item).toMatchObject({ state: "merged", head: C1, acceptedHead: C1, pushActors: [OPUS] });
  expect(landed.receipt).toMatchObject({ commit: C1, mergeCommit: M1, builder: OPUS, reason: "forks fail", tests: { command: "npm test" } });
  const kinds = ((await L.events(item.id)) as unknown as LedgerEvent[]).map((e) => e.kind);
  expect(kinds).toEqual(expect.arrayContaining(["item.landed_fast", "item.merged"]));

  // The receipt says no review was asked for until one is (t605).
  expect(renderItem(await L.project(), await L.detail(item.id))).toContain("no post-merge review was requested");
  // The builder never reviews its own landing; another model of its family may.
  await refusal(L.requestReview(item.id, "owner", OPUS, POOL), "self_review", /contributed/);
  expect(await L.requestReview(item.id, "owner", SONNET, POOL)).toMatchObject({ requested: true, head: M1, reviewer: SONNET });
  expect(renderItem(await L.project(), await L.detail(item.id))).toContain("a post-merge review was requested and is not recorded yet");
  const claim = await L.claimReview(item.id, SONNET, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ itemId: item.id, by: SONNET, head: M1, criteria: claim.criteria, request: claim.request, approve: true, note: "Fine", at: AT }, undefined, true);
  expect((await L.reviewsFor(item.id))[0]).toMatchObject({ postMerge: true, independence: "same-family (fast mode)" });
  expect((await L.fastLandings())[0]).toMatchObject({ item: item.id, review: { state: "approved", by: SONNET } });
  // The task page names the mode it landed under, and the showcase counts it apart from gated merges.
  const html = renderItem(await L.project(), await L.detail(item.id));
  expect(html).toContain("Landed in fast mode");
  expect(html).toContain("same-family (fast mode)");
  expect(html).toContain("its post-merge review is recorded");
  expect(html).not.toContain("audits it");
  const counts = await L.showcaseCounts("2000-01-01T00:00:00.000Z") as unknown as ShowcaseCounts;
  expect(counts).toMatchObject({ landedFast: 1, merges: 0 });
  expect(counts.kinds.some((k) => k.kind === "item.merged")).toBe(false);
  expect(counts.days.some((k) => k.kind === "item.merged")).toBe(false);
});

it("a same-family post-merge review is refused for a merge that did not land fast", async () => {
  const L = await project("fast-family");
  await L.setProject({ name: "fast-family", repo: "fast-family--baseline", policy: { ...policy, protected: ["src/**"] }, createdAt: AT }, "owner");
  const item = await L.newItem("Gated", ["src/**"], "owner", { accept: ["Works"] });
  await L.claim(item.id, OPUS);
  await L.setFork(item.id, `fast-family--${item.id}`, "0".repeat(40), OPUS);
  await L.recordPush(item.id, OPUS, C1, C1);
  await L.addEvidence({ itemId: item.id, claim: "npm test", grade: "observed", head: C1, passed: true, by: "owner", at: AT, changedPaths: ["src/a/x.ts"] });
  await L.submit(item.id, OPUS);
  await L.confirmOverride(item.id, "owner", C1, "access");
  await L.accept(item.id, "owner", C1, "No independent runner was available");
  await L.merged(item.id, "owner", M1, true);
  await refusal(L.requestReview(item.id, "owner", SONNET, POOL), "not_independent", /same family.*fast mode/);
  expect(await L.requestReview(item.id, "owner", GPT, POOL)).toMatchObject({ requested: true });
});

it("a rejected post-merge review of a fast landing files a fix task from its findings, and full mode lists the landing", async () => {
  const L = await project("fast-fix");
  const item = await L.newItem("Risky", ["src/**"], "owner", { accept: ["Works"] });
  await L.confirmFastMode("owner", "access");
  await L.setMode("owner", "fast", "forks fail");
  await L.landedFast(item.id, "owner", receipt(C1, M2));
  await L.requestReview(item.id, "owner", GPT, POOL);
  const claim = await L.claimReview(item.id, GPT, RUNNER) as unknown as ReviewClaim;
  const findings = [{ file: "src/a.ts", line: 3, severity: "blocking" as const, text: "Drops the record" }];
  await L.addReview({ itemId: item.id, by: GPT, head: M2, criteria: claim.criteria, request: claim.request, approve: false, note: "Drops data", findings, at: AT }, undefined, true);
  const fix = await L.item("t2");
  expect(fix).toMatchObject({ title: expect.stringMatching(/^Fix after fast landing of t1: Risky/), state: "open", accept: ["src/a.ts:3: Drops the record"] });
  const full = await L.setMode("owner", "full", undefined);
  expect(full.landed).toEqual([expect.objectContaining({ item: "t1", review: expect.objectContaining({ state: "rejected" }), fix: "t2" })]);
});

// Astra's audit of 2026-10-13, finding 3: the switch to fast mode and a fast
// landing took the developer token alone, though fast mode lands without the
// gate, so they skipped the confirmation an override of the independent
// review needs and a project's --no-override. Now the switch needs the
// developer's permission from the Settings page, given with the factor no
// agent holds and spent by one switch, and a project that forbids overrides
// refuses the switch and every fast landing.
it("the switch to fast mode needs the developer's confirmation from the Settings page, not the developer token", async () => {
  const name = "fast-confirm";
  const L = await project(name);
  const SECRET = "fast-confirm-secret-no-session-holds";
  const bindings = { ...testEnv, OVERRIDE_SECRET: SECRET } as typeof env;
  const switchFast = () => worker.fetch(new Request(`https://atelier.test/api/projects/${name}/mode`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: JSON.stringify({ mode: "fast", reason: "forks fail" }),
  }), bindings);
  const allow = (headers: Record<string, string>, fields: Record<string, string>) => worker.fetch(new Request(`https://atelier.test/ui/${name}/mode/allow-fast`, {
    method: "POST", redirect: "manual", headers: { origin: "https://atelier.test", ...headers }, body: new URLSearchParams(fields),
  }), bindings);

  await refusal(L.setMode("owner", "fast", "forks fail"), "fast_mode_unconfirmed", /developer token alone does not confirm it/);
  const refused = await switchFast();
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: "fast_mode_unconfirmed" });
  expect(await L.mode()).toMatchObject({ mode: "full" });

  // The form posted with the developer token as a bearer, or from a session without the secret, confirms nothing.
  expect((await allow({ authorization: `Bearer ${TOKEN}` }, { confirmation: SECRET })).status).not.toBe(303);
  const cookie = await signIn(TOKEN, bindings);
  expect((await allow({ cookie }, {})).status).not.toBe(303);
  expect((await switchFast()).status).toBe(403);
  // The Settings page offers the permission, with the secret's field.
  const settings = await (await worker.fetch(new Request(`https://atelier.test/p/${name}/settings`, { headers: { cookie } }), bindings)).text();
  expect(settings).toContain("Allow fast mode from the command line");
  expect(settings).toContain('name="confirmation"');

  // With the factor, the permission is given, and one switch spends it.
  expect((await allow({ cookie }, { confirmation: SECRET })).status).toBe(303);
  expect((await switchFast()).status).toBe(200);
  expect(await L.mode()).toMatchObject({ mode: "fast" });
  // Switching back to full needs no confirmation; switching to fast again needs a new one.
  expect(await L.setMode("owner", "full", undefined)).toMatchObject({ mode: "full" });
  await refusal(L.setMode("owner", "fast", "again"), "fast_mode_unconfirmed", /Allow fast mode from the command line/);
});

it("a project that forbids overrides refuses the switch to fast mode and every fast landing", async () => {
  const name = "fast-no-override";
  const L = await project(name);
  const item = await L.newItem("Finished elsewhere", ["src/**"], "owner", { accept: ["Works"] });
  await L.confirmFastMode("owner", "access");
  await L.setMode("owner", "fast", "forks fail");
  await L.setProject({ name, repo: `${name}--baseline`, policy: { ...policy, noOverride: true }, createdAt: AT }, "owner");
  await refusal(L.landedFast(item.id, "owner", receipt(C1, M1)), "fast_mode_forbidden", /forbids overrides.*--no-override/);
  expect((await L.item(item.id)).state).toBe("open");
  expect((await api("POST", `/projects/${name}/items/${item.id}/landed-fast`, "owner", receipt(C1, M1))).status).toBe(403);
  await L.setMode("owner", "full", undefined);
  await refusal(L.confirmFastMode("owner", "access"), "fast_mode_forbidden", /forbids overrides/);
  await refusal(L.setMode("owner", "fast", "forks fail"), "fast_mode_forbidden", /fast mode is refused/);
});

// t629 reverses t596's confirmation for the switch (Astra's audit of
// 2026-10-13, finding 3; the developer's decision of 2026-10-13, "why isn't
// my direction sufficient?"): the developer token alone switches to fast
// mode when the request carries the developer's quoted words and names the
// model acting on them. The switch records both, so it says afterwards who
// asked and why. No words, no switch; an agent token is refused; a project
// that forbids overrides still refuses; the Settings page still works.
it("the developer token switches to fast mode on the developer's quoted words and the acting model, and records both", async () => {
  const name = "fast-direction";
  const L = await project(name);
  for (const [harness, id] of [["claude-code", "opus-5.5"], ["codex", "gpt-6-astra"]]) {
    expect((await api("PUT", `/models/${id}`, "owner", { harness, where: "cloud" })).status).toBe(200);
  }
  const post = (body: unknown, headers: Record<string, string> = {}, bearer = TOKEN, actor: string | null = "owner") => worker.fetch(new Request(`https://atelier.test/api/projects/${name}/mode`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, ...(actor ? { "x-atelier-actor": actor } : {}), "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }), testEnv);
  const QUOTE = "every project, fast mode and overrides both";

  // No words: refused as before, naming the page and the --quote way.
  const bare = await post({ mode: "fast", reason: "forks fail" }, { "x-atelier-acting": OPUS });
  expect(bare.status).toBe(403);
  expect(await bare.json()).toMatchObject({ error: "fast_mode_unconfirmed", detail: expect.stringContaining("--quote") });
  // Words with no acting model, or blank words: refused.
  expect(await (await post({ mode: "fast", reason: "forks fail", quote: QUOTE })).json()).toMatchObject({ error: "no_acting" });
  expect(await (await post({ mode: "fast", reason: "forks fail", quote: "  " }, { "x-atelier-acting": OPUS })).json()).toMatchObject({ error: "bad_quote" });
  // An agent token is refused, with or without an acting header.
  const agent = (await (await api("POST", "/tokens", "owner", { actor: GPT, projects: [name] })).json() as { token: string }).token;
  expect((await post({ mode: "fast", reason: "forks fail", quote: QUOTE }, { "x-atelier-acting": OPUS }, agent, null)).status).toBe(403);
  expect((await post({ mode: "fast", reason: "forks fail", quote: QUOTE }, {}, agent, null)).status).toBe(403);
  expect(await L.mode()).toMatchObject({ mode: "full" });

  // With both: switched, the words and the acting model on the record, the event and the decision.
  const ok = await post({ mode: "fast", reason: "forks fail", quote: QUOTE }, { "x-atelier-acting": OPUS });
  expect(ok.status).toBe(200);
  const fast = await ok.json() as { line: string; decision: string };
  expect(fast).toMatchObject({ mode: "fast", reason: "forks fail", quote: QUOTE, acting: OPUS });
  expect(fast.line).toContain(`the developer's words: “${QUOTE}”, relayed by ${OPUS}`);
  expect(await L.mode()).toMatchObject({ mode: "fast", quote: QUOTE, acting: OPUS });
  const switched = (await L.events(undefined, 50) as unknown as LedgerEvent[]).find((e) => e.kind === "mode.fast")!;
  expect(switched.data).toMatchObject({ reason: "forks fail", confirmed: "direction", quote: QUOTE, acting: OPUS });
  expect((await L.decisions()).find((d) => d.id === fast.decision)).toMatchObject({ quote: QUOTE, acting: OPUS });
  // The standing atelier status prints carries the same line.
  const standing = await (await api("GET", `/projects/${name}/standing`, "owner")).json() as { mode?: string };
  expect(standing.mode).toBe(fast.line);
  // A fast landing's receipt carries the words the mode was switched on.
  const item = await L.newItem("Finished elsewhere", ["src/**"], "owner", { accept: ["Works"] });
  const { receipt: landed } = await L.landedFast(item.id, "owner", receipt(C1, M1));
  expect(landed).toMatchObject({ reason: "forks fail", quote: QUOTE, acting: OPUS });

  // The page's permission still works, with no words.
  await L.setMode("owner", "full", undefined);
  await L.confirmFastMode("owner", "access");
  expect(await L.setMode("owner", "fast", "page path")).toMatchObject({ mode: "fast" });
  expect(await L.mode()).not.toHaveProperty("quote");
  await L.setMode("owner", "full", undefined);

  // A project that forbids overrides refuses the switch, words or not.
  await L.setProject({ name, repo: `${name}--baseline`, policy: { ...policy, noOverride: true }, createdAt: AT }, "owner");
  expect(await (await post({ mode: "fast", reason: "forks fail", quote: QUOTE }, { "x-atelier-acting": OPUS })).json()).toMatchObject({ error: "fast_mode_forbidden" });
  await refusal(L.setMode("owner", "fast", "forks fail", OPUS, QUOTE), "fast_mode_forbidden", /fast mode is refused/);
});

// t637: the task page's fast-landing summary said the reason fast mode was
// switched on, but not the developer's words nor the model that relayed them,
// which t629 records on the receipt and the text receipt prints (f654d0ae).
// It now says them as the text receipt does, escaped; a landing with no
// direction reads as before; the page stays behind the developer's sign-in.
it("the task page's fast-landing summary names the developer's words and the acting model, escaped", async () => {
  const name = "fast-direction-page";
  const L = await project(name);
  const QUOTE = `land <b>it</b> & "go" 'now'`;
  await L.setMode("owner", "fast", "forks fail", OPUS, QUOTE);
  const item = await L.newItem("Finished elsewhere", ["src/**"], "owner", { accept: ["Works"] });
  await L.landedFast(item.id, "owner", receipt(C1, M1));
  const html = renderItem(await L.project(), await L.detail(item.id));
  expect(html).toContain(`Reason: forks fail; on the developer&#39;s words: “land &lt;b&gt;it&lt;/b&gt; &amp; &quot;go&quot; &#39;now&#39;”, relayed by ${OPUS}.</p>`);
  expect(html).not.toContain("<b>it</b>");

  // codex/gpt-6-astra's review of t637: the page read the receipt from the
  // newest 200 events only, so 200 later edits of the merged task hid the
  // whole summary. It is read by kind now; the window really is passed here.
  for (let i = 0; i < 201; i++) await L.editItem(item.id, "owner", { area: null });
  const late = await L.detail(item.id) as unknown as Detail;
  expect(late.events.some((x) => x.kind === "item.landed_fast")).toBe(false);
  const lateHtml = renderItem(await L.project(), late);
  expect(lateHtml).toContain("Landed in fast mode");
  expect(lateHtml).toContain(`relayed by ${OPUS}.</p>`);
  expect(lateHtml).toContain("no post-merge review was requested");
  // A post-merge review requested since the landing is read by kind too.
  await L.requestReview(item.id, "owner", SONNET, POOL);
  for (let i = 0; i < 201; i++) await L.editItem(item.id, "owner", { area: null });
  expect(renderItem(await L.project(), await L.detail(item.id))).toContain("a post-merge review was requested and is not recorded yet");

  // Through the route: an agent token and a visitor not signed in never see the page.
  const page = `https://atelier.test/p/${name}/${item.id}`;
  const agent = (await (await api("POST", "/tokens", "owner", { actor: GPT, projects: [name] })).json() as { token: string }).token;
  const asAgent = await worker.fetch(new Request(page, { headers: { authorization: `Bearer ${agent}` } }), testEnv);
  expect(asAgent.status).toBe(403);
  expect(await asAgent.text()).not.toContain("relayed by");
  const anonymous = await worker.fetch(new Request(page, { redirect: "manual" }), testEnv);
  expect(anonymous.status).toBe(303);
  expect(anonymous.headers.get("location")).toBe("https://atelier.test/login");
});

it("a fast landing with no recorded direction reads as before on the task page", async () => {
  const L = await project("fast-paged-page");
  await L.confirmFastMode("owner", "access");
  await L.setMode("owner", "fast", "forks fail");
  const item = await L.newItem("Finished elsewhere", ["src/**"], "owner", { accept: ["Works"] });
  await L.landedFast(item.id, "owner", receipt(C1, M1));
  const html = renderItem(await L.project(), await L.detail(item.id));
  expect(html).toContain(`built by ${OPUS}. Reason: forks fail.</p>`);
  expect(html).not.toContain("words: “");
  expect(html).not.toContain("relayed by");
});
