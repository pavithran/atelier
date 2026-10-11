// t457, driven through the Worker's own handlers: a task page form that is
// refused (a stale head or criteria, an approval, the command-line
// permission, an override) answers with the task's page again, the refusal
// beside the form it came from with a way on, the reason typed kept, the
// confirmation secret never echoed, and no success the record does not
// hold. An override, from the page or the command line, keeps whether a
// qualifying reviewer was available, and the task's history says it.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { NO_CRITERIA } from "../src/criteria.ts";
import { signIn } from "./signin.ts";

const TOKEN = "owner-forms-token";
const SECRET = "owner-forms-secret-no-session-holds";
const A = "claude-code/opus-5.5", H0 = "0".repeat(40), H1 = "a".repeat(40), T0 = "1".repeat(40), T1 = "2".repeat(40);

// A submitted protected change waiting for its independent review, on a
// server that takes the confirmation secret as the owner's factor.
async function setup(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: ["AGENTS.md"] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  await L.newItem("Rewrite the agent instructions", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", `${name}--t1`, H0, A);
  await L.recordPush("t1", A, H1, H1);
  await L.addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", head: H1, passed: true, by: A, at: new Date().toISOString(), changedPaths: ["AGENTS.md"] });
  await L.submit("t1", A);
  const logs: Record<string, { hash: string; parents: string[]; treeHash: string }[]> = {
    [`${name}--t1`]: [{ hash: H1, parents: [H0], treeHash: T1 }, { hash: H0, parents: [], treeHash: T0 }],
    [name]: [{ hash: H0, parents: [], treeHash: T0 }],
  };
  const ARTIFACTS = { get: async (repo: string) => {
    const log = logs[repo] ?? [];
    return {
      log: async (o: { limit?: number } = {}) => log.slice(0, o.limit ?? 50), readCommit: async (h: string) => log.find((c) => c.hash === h) ?? null,
      readTree: async () => null, readBlob: async () => null, info: async () => ({ remote: "https://git.test/r.git", defaultBranch: "main" }), [Symbol.dispose]() {},
    };
  } } as unknown as typeof env.ARTIFACTS;
  const bindings = { ...env, ATELIER_TOKEN: TOKEN, OVERRIDE_SECRET: SECRET, ARTIFACTS } as typeof env;
  const cookie = await signIn(TOKEN, bindings);
  const post = (verb: string, fields: Record<string, string>) => worker.fetch(new Request(`https://atelier.test/ui/${name}/t1/${verb}`, {
    method: "POST", redirect: "manual", headers: { origin: "https://atelier.test", cookie }, body: new URLSearchParams({ head: H1, criteria: NO_CRITERIA, note: "", ...fields }),
  }), bindings);
  const api = (path: string, body: unknown) => worker.fetch(new Request(`https://atelier.test/api/projects/${name}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: JSON.stringify(body),
  }), bindings);
  const view = async () => (await worker.fetch(new Request(`https://atelier.test/p/${name}/t1`, { headers: { cookie } }), bindings)).text();
  return { L, post, api, view };
}

const alertFor = (html: string, verb: string) => /<p class="error form-error" role="alert" id="error-[a-z-]+">[^<]*/.exec(html.slice(html.indexOf(`id="error-${verb}"`) - 60))?.[0] ?? "";

it("criterion 6: a stale head or stale criteria on Approve re-renders the page with the refusal beside Approve, and records nothing", async () => {
  const { L, post } = await setup("forms-stale");
  const staleHead = await post("approve", { head: H0 });
  expect(staleHead.status).toBe(409);
  const html = await staleHead.text();
  expect(html).toContain('<button aria-describedby="error-approve">Approve revision</button><p class="error form-error" role="alert" id="error-approve">This task changed since you opened it; refresh and review the new revision. Nothing was recorded from this attempt. <a href="/p/forms-stale/t1">Reload this task</a> to see its current revision, then try again.</p>');
  // The page is the task's own, drawn from the record: no claim of approval.
  expect(html).toContain("<dt>Your approval</dt><dd>Not given</dd>");
  expect(html).not.toContain("Approved by you");
  const staleCriteria = await post("approve", { criteria: "sha256:" + "f".repeat(64) });
  expect(staleCriteria.status).toBe(409);
  expect(alertFor(await staleCriteria.text(), "approve")).toMatch(/^<p class="error form-error" role="alert" id="error-approve">t1(&#39;|&#x27;|')s acceptance criteria changed since you opened this page; reload it and read them again\. Nothing was recorded/);
  expect(await L.reviewsFor("t1")).toEqual([]);
  // The same approval, sent from a current page, is recorded and said beside the actions.
  const ok = await post("approve", {});
  expect(ok.status).toBe(303);
  expect(ok.headers.get("location")).toBe("https://atelier.test/p/forms-stale/t1");
});

it("criterion 6: stale criteria refuse the override and the command-line permission as they refuse Approve", async () => {
  const { L, post } = await setup("forms-stale-criteria");
  const stale = "sha256:" + "f".repeat(64), reason = "No other family today";
  const override = await post("override", { criteria: stale, note: reason, confirmation: SECRET });
  expect(override.status).toBe(409);
  const html = await override.text();
  expect(alertFor(html, "override")).toMatch(/^<p class="error form-error" role="alert" id="error-override">t1(&#39;|&#x27;|')s acceptance criteria changed since you opened this page/);
  expect(html).toContain(`>${reason}</textarea>`);
  expect(html).not.toContain(SECRET);
  expect((await L.item("t1")).state).toBe("submitted");
  const missing = await post("override", { criteria: "", note: reason, confirmation: SECRET });
  expect(missing.status).toBe(409);
  expect((await L.item("t1")).state).toBe("submitted");
  const permission = await post("allow-override", { criteria: stale, confirmation: SECRET });
  expect(permission.status).toBe(409);
  expect(alertFor(await permission.text(), "allow-override")).toMatch(/acceptance criteria changed since you opened this page/);
  expect((await L.item("t1")).overrideConfirmation).toBeUndefined();
  const events = await L.events("t1") as unknown as { kind: string }[];
  expect(events.filter((v) => v.kind === "review.overridden" || v.kind === "override.allowed" || v.kind === "item.accepted")).toEqual([]);
});

it("criterion 6: an old tab's second override after acceptance is refused on the page and records nothing more", async () => {
  const { L, post } = await setup("forms-second-override");
  expect((await post("override", { note: "No other family", confirmation: SECRET })).status).toBe(303);
  expect((await L.item("t1")).state).toBe("accepted");
  const count = async () => (await L.events("t1") as unknown as { kind: string }[]).filter((v) => v.kind === "review.overridden" || v.kind === "item.accepted").length;
  expect(await count()).toBe(2);
  // The same form again, from a tab drawn before the acceptance.
  const again = await post("override", { note: "Second <try> from an old tab", confirmation: SECRET });
  expect(again.status).toBe(409);
  const html = await again.text();
  expect(html).toContain('role="alert" id="error-override">t1 was already accepted at aaaaaaaa since this page was drawn, so this override would record a second override and acceptance. Nothing was recorded from this attempt.');
  expect(html).toContain("<blockquote>Second &lt;try&gt; from an old tab</blockquote>");
  expect(html).not.toContain(SECRET);
  expect(await count()).toBe(2);
});

it("criterion 6: a refused override keeps its reason, never echoes the secret, and reopens the disclosure", async () => {
  const { L, post } = await setup("forms-override");
  const reason = "No <other> family is available today";
  // A wrong secret: refused at the factor, before the Ledger.
  const wrong = await post("override", { note: reason, confirmation: "a guess at " + SECRET });
  expect(wrong.status).toBe(403);
  const html = await wrong.text();
  expect(html).toContain('<details class="override-disclosure" open>');
  expect(html).toContain(">No &lt;other&gt; family is available today</textarea>");
  expect(html).toContain('<button aria-describedby="error-override">Override the review and accept</button><p class="error form-error" role="alert" id="error-override">');
  expect(alertFor(html, "override")).toMatch(/needs the confirmation secret, which was not this server/);
  expect(html).not.toContain(SECRET);
  for (const field of html.match(/<input[^>]*name="confirmation"[^>]*>/g) ?? []) expect(field).not.toContain("value=");
  // A blank reason with the right secret: the Ledger's own validation refuses it.
  const blank = await post("override", { note: "   ", confirmation: SECRET });
  expect(blank.status).toBe(400);
  const blankHtml = await blank.text();
  expect(alertFor(blankHtml, "override")).toContain('id="error-override"');
  expect(blankHtml).not.toContain(SECRET);
  expect((await L.item("t1")).state).toBe("submitted");
  expect(blankHtml).toContain("<dt>Acceptance</dt><dd class=\"bad\">Not ready: 1 blocker</dd>");
});

it("criterion 6: a refused command-line permission is said beside its button and grants nothing", async () => {
  const { L, post } = await setup("forms-permission");
  const res = await post("allow-override", {});
  expect(res.status).toBe(403);
  const html = await res.text();
  expect(html).toContain('<button aria-describedby="error-allow-override">Allow an override from the command line</button><p class="error form-error" role="alert" id="error-allow-override">');
  expect(alertFor(html, "allow-override")).toMatch(/needs the confirmation secret, which was not given/);
  expect(html).toContain("<dt>Command-line permission</dt><dd>Not given</dd>");
  expect((await L.item("t1")).overrideConfirmation).toBeUndefined();
});

it("criterion 6: a refused Accept the page no longer offers is still said among the actions", async () => {
  const { post } = await setup("forms-accept");
  const res = await post("accept", {});
  expect(res.status).toBe(409);
  const html = await res.text();
  const actions = html.slice(html.indexOf('<div class="actions">'));
  expect(actions.indexOf('<p class="error form-error" role="alert" id="error-accept">Not ready:')).toBe(actions.indexOf("<p"));
  expect(html).not.toContain("Accept revision</button>");
});

it("criterion 7: a permission given before noOverride is switched on reads as prohibited by policy, never active", async () => {
  const { L, post, view } = await setup("forms-policy-permission");
  expect((await post("allow-override", { confirmation: SECRET })).status).toBe(303);
  expect(await view()).toMatch(/<dt>Command-line permission<\/dt><dd class="ask">Active for revision aaaaaaaa until /);
  await L.initProject({ name: "forms-policy-permission", repo: "forms-policy-permission", reset: false, noOverride: true }, "owner");
  // The Ledger keeps the confirmation on record; the page says it allows nothing.
  expect((await L.item("t1")).overrideConfirmation).toBeDefined();
  const html = await view();
  expect(html).toMatch(/<dt>Command-line permission<\/dt><dd class="bad">Prohibited by policy: given for revision aaaaaaaa until [^<]*, but this project now refuses every override, so it allows nothing<\/dd>/);
  expect(html).not.toContain("Active for revision");
});

it("criterion 7: an override refused under noOverride keeps its typed reason on the page that no longer offers the form", async () => {
  const { L, post } = await setup("forms-policy-override");
  await L.initProject({ name: "forms-policy-override", repo: "forms-policy-override", reset: false, noOverride: true }, "owner");
  const reason = "No <other> family is available today";
  // Sent from a page drawn before the policy changed.
  const res = await post("override", { note: reason, confirmation: SECRET });
  expect(res.status).toBeGreaterThanOrEqual(400);
  const html = await res.text();
  expect(html).not.toContain("Override the review and accept</button>");
  expect(html).toContain('role="alert" id="error-override"');
  expect(html).toContain('<div class="kept-note"><p class="meta">The reason you typed, which was not recorded:</p><blockquote>No &lt;other&gt; family is available today</blockquote></div>');
  expect(html).not.toContain(SECRET);
  expect((await L.item("t1")).state).toBe("submitted");
});

it("criterion 4: an override from the page keeps the reviewer availability in review.overridden and the history shows it", async () => {
  const { L, post, view } = await setup("forms-availability-page");
  // The command-line permission is given first; the page's own override then clears it unused.
  expect((await post("allow-override", { confirmation: SECRET })).status).toBe(303);
  const until = (await L.item("t1")).overrideConfirmation!.until;
  const res = await post("override", { note: "No other family", confirmation: SECRET });
  expect(res.status, await res.clone().text()).toBe(303);
  const events = await L.events("t1") as unknown as { kind: string; data: Record<string, unknown> }[];
  const overridden = events.find((v) => v.kind === "review.overridden")!.data;
  expect(overridden).toMatchObject({ confirmed: "page", availability: { known: true, source: "model pool" } });
  const availability = overridden.availability as { reviewer: string | null; at: string };
  expect(Date.parse(availability.at)).not.toBeNaN();
  const html = await view();
  const said = availability.reviewer
    ? `Reviewer availability: ${availability.reviewer} qualified and was available (model pool, `
    : "Reviewer availability: no qualifying reviewer was available (model pool, ";
  // Once in the review's override note, once in the task's history.
  expect(html.split(said)).toHaveLength(3);
  // Once the page override clears the command-line permission, it is invalidated, never expired early.
  expect(Date.parse(until)).toBeGreaterThan(Date.now());
  expect((await L.item("t1")).overrideConfirmation).toBeUndefined();
  expect(html).toMatch(/<dt>Command-line permission<\/dt><dd>Invalidated by your override on this page at aaaaaaaa, [^<]*; it was never used<\/dd>/);
  expect(html).not.toMatch(/<dt>Command-line permission<\/dt><dd>Expired/);
});

it("criterion 4: an override from the command line keeps the reviewer the pool offered, and the history shows it", async () => {
  const { L, api, view } = await setup("forms-availability-cli");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).putModel({ id: "gpt-6-astra", harness: "codex", where: "home", provider: "subscription", aliases: [], family: "other", note: "", addedBy: "owner", addedAt: new Date().toISOString() } as never);
  await L.confirmOverride("t1", "owner", H1, "secret");
  const res = await api("/items/t1/accept", { head: H1, overrideReview: "Accepting now; the reviewer can follow" });
  expect(res.status, await res.clone().text()).toBe(200);
  expect(await res.json()).toMatchObject({ availableReviewer: "codex/gpt-6-astra" });
  const events = await L.events("t1") as unknown as { kind: string; data: Record<string, unknown> }[];
  expect(events.find((v) => v.kind === "review.overridden")!.data).toMatchObject({ confirmed: "command line", availability: { known: true, reviewer: "codex/gpt-6-astra", source: "model pool" } });
  const html = await view();
  expect(html).toContain("Reviewer availability: codex/gpt-6-astra qualified and was available (model pool, ");
  expect(html).toMatch(/<dt>Command-line permission<\/dt><dd>Consumed by the command-line override at aaaaaaaa, /);
});

it("criterion 4: an override recorded without a lookup is kept as an explicit unknown", async () => {
  const { L, view } = await setup("forms-availability-unknown");
  await L.accept("t1", "owner", H1, "No other family", undefined, "secret");
  const events = await L.events("t1") as unknown as { kind: string; data: Record<string, unknown> }[];
  expect(events.find((v) => v.kind === "review.overridden")!.data.availability).toMatchObject({ known: false, reviewer: null, why: "no reviewer was looked for as the override was made" });
  expect(await view()).toContain("Reviewer availability: unknown, no reviewer was looked for as the override was made");
});
