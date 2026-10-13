import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import layout from "../src/layout.css";
import { HELP_GROUPS } from "../src/usage.ts";
import { buildStory, type Story } from "../src/graph.ts";
import { buildImported } from "../src/import/history.ts";
import { renderShowcase, type ShownProject } from "../src/ui.ts";
import { signIn } from "./signin.ts";

// The public showcase as an anonymised portfolio (t184): the owner's setting
// decides which projects appear and whether each is named, the pages carry
// nothing an anonymised project named itself, and the sign-in page stands in
// the public shell over the portfolio's clipped activity.

const TOKEN = "showcase-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const OWNER_TOKEN_CALL = (method: string, path: string, body?: unknown) =>
  worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);

const time = "2026-10-03T12:00:00Z";
const head = "a".repeat(40);

// A project with work whose every name is a secret: the project's own name
// and title, a task title holding a path and an address, a check's command
// and a review's note.
async function secretProject(name: string, title: string) {
  const record = { name, repo: name, title, policy: { checks: ["xcodebuild -project Hush.xcodeproj -scheme Hush -destination platform=iOS test"], protected: [] }, createdAt: time };
  await L(name).setProject(record, "owner");
  await I().registerProject(record);
  const l = L(name);
  await l.newItem("Fix the crash in src/auth.ts reported by dev@private.example", [], "owner");
  await l.claim("t1", "codex/gpt-6");
  await l.setFork("t1", `${name}--t1`, head, "codex/gpt-6");
  await l.addEvidence({ itemId: "t1", claim: "npm run hush-suite", grade: "observed", head, passed: true, by: "codex/gpt-6", at: time, changedPaths: ["src/auth.ts"] });
  await l.addReview({ itemId: "t1", criteria: await l.criteria("t1"), by: "zcode/glm-5.3", head, approve: false, note: "secret reviewer note", at: time });
}

it("shows nothing by default, and the setting says which projects appear and how", async () => {
  await secretProject("default-none", "Default None Title");
  const before = await worker.fetch(new Request("https://atelier.test/showcase"), testEnv);
  expect(before.status).toBe(404);
  const listed = await (await OWNER_TOKEN_CALL("GET", "/showcase")).json() as { showcase: unknown[] };
  expect(listed.showcase).toEqual([]);
  await I().setShowcase("default-none", "anonymous");
  const shown = await worker.fetch(new Request("https://atelier.test/showcase"), testEnv);
  expect(shown.status).toBe(200);
  expect((await I().removeShowcase("default-none"))).toBe(true);
  expect((await worker.fetch(new Request("https://atelier.test/showcase"), testEnv)).status).toBe(404);
});

it("an anonymised project's names, titles, paths, commands, notes and addresses never reach the showcase or the sign-in page", async () => {
  await secretProject("hush-app", "Hush Secret Title");
  await I().setShowcase("hush-app", "anonymous");
  const page = await worker.fetch(new Request("https://atelier.test/showcase"), testEnv);
  expect(page.status).toBe(200);
  const body = await page.text();
  for (const secret of ["hush-app", "Hush Secret Title", "Fix the crash", "src/auth.ts", "dev@private.example", "secret reviewer note", "npm run hush-suite", "Hush.xcodeproj"]) {
    expect(body, secret).not.toContain(secret);
  }
  // What the page says instead: a neutral label from the project's kind and
  // the card's counts and families. Its one task is open, so no task is told
  // as it happened (t578: only a merged task is).
  expect(body).toContain("<h3>An iOS app</h3>");
  expect(body).not.toContain('id="story-h"');
  expect(body).toContain("<dt>merged, last two weeks</dt><dd>0</dd>");
  expect(body).toContain("<dt>merged, all time</dt><dd>0</dd>");
  expect(body).toContain("<dt>sent back, last two weeks</dt><dd>1</dd>");
  expect(body).toContain("<dt>in progress, last two weeks</dt><dd>1</dd>");
  expect(body).toContain('class="pulse-graph bars"');
  expect(body).toContain(">GPT<");
  expect(body).toContain(">GLM<");
  // The sign-in page draws the same anonymised activity behind its form.
  const login = await worker.fetch(new Request("https://atelier.test/login"), testEnv);
  const loginBody = await login.text();
  for (const secret of ["hush-app", "Hush Secret Title", "Fix the crash", "src/auth.ts", "dev@private.example", "secret reviewer note"]) {
    expect(loginBody, secret).not.toContain(secret);
  }
  expect(loginBody).toContain('class="login-backdrop"');
});

it("a project shown named appears by name, beside the anonymised one", async () => {
  await secretProject("hush-app", "Hush Secret Title");
  const record = { name: "open-tool", repo: "open-tool", title: "Open Tool", policy: { checks: [], protected: [] }, createdAt: time };
  await L("open-tool").setProject(record, "owner");
  await I().registerProject(record);
  await L("open-tool").newItem("Polish the handle", [], "owner");
  await L("open-tool").claim("t1", "codex/gpt-6");
  await I().setShowcase("hush-app", "anonymous");
  await I().setShowcase("open-tool", "named");
  const body = await (await worker.fetch(new Request("https://atelier.test/showcase"), testEnv)).text();
  expect(body).toContain("<h3>Open Tool</h3>");
  expect(body).toContain('<span class="meta">Open Tool · </span>gpt-6 took t1');
  expect(body).not.toContain("Hush Secret Title");
  expect(body).toContain("<h3>An iOS app</h3>");
});

it("the setting is the owner's alone: agent tokens and unsigned callers cannot change it", async () => {
  await secretProject("owner-only", "Owner Only Title");
  // An unsigned browser form is sent to the sign-in page and changes nothing.
  const unsigned = await worker.fetch(new Request("https://atelier.test/projects/showcase", {
    method: "POST", body: new URLSearchParams({ project: "owner-only", mode: "named" }),
  }), { ...testEnv } as typeof env);
  expect(unsigned.status).toBe(303);
  expect(unsigned.headers.get("location")).toBe("https://atelier.test/login");
  // An agent token cannot reach the owner's API routes for it.
  const issued = await (await OWNER_TOKEN_CALL("POST", "/tokens", { actor: "codex/gpt-6", label: "Showcase test" })).json() as { token: string };
  const agent = await worker.fetch(new Request("https://atelier.test/api/showcase/owner-only", {
    method: "PUT", headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" }, body: JSON.stringify({ mode: "named" }),
  }), testEnv);
  expect(agent.status).toBe(403);
  // A cross-origin form is refused even signed in.
  const cookie = await signIn(TOKEN, testEnv);
  const cross = await worker.fetch(new Request("https://atelier.test/projects/showcase", {
    method: "POST", headers: { cookie, origin: "https://evil.test" }, body: new URLSearchParams({ project: "owner-only", mode: "named" }),
  }), testEnv);
  expect(cross.status).toBe(403);
  // The owner sets it through the API and the Projects page's form, and a bad mode is refused.
  expect((await OWNER_TOKEN_CALL("PUT", "/showcase/owner-only", { mode: "middle" })).status).toBe(400);
  expect((await OWNER_TOKEN_CALL("PUT", "/showcase/no-such-project", { mode: "named" })).status).toBe(404);
  expect((await OWNER_TOKEN_CALL("PUT", "/showcase/owner-only", { mode: "named" })).status).toBe(200);
  const form = await worker.fetch(new Request("https://atelier.test/projects/showcase", {
    method: "POST", headers: { cookie, origin: "https://atelier.test" }, body: new URLSearchParams({ project: "owner-only", mode: "anonymous" }),
  }), testEnv);
  expect(form.status).toBe(303);
  expect(await (await OWNER_TOKEN_CALL("GET", "/showcase")).text()).toContain('"mode": "anonymous"');
  const home = await (await worker.fetch(new Request("https://atelier.test/home", { headers: { cookie } }), testEnv)).text();
  expect(home).toContain('action="/projects/showcase"');
  expect((await OWNER_TOKEN_CALL("DELETE", "/showcase/owner-only")).status).toBe(200);
  expect(await (await OWNER_TOKEN_CALL("GET", "/showcase")).text()).not.toContain("owner-only");
});

it("the sign-in page stands in the public shell, with no owner bar", async () => {
  const body = await (await worker.fetch(new Request("https://atelier.test/login"), testEnv)).text();
  expect(body).not.toContain('class="owner-bar"');
  expect(body).not.toContain('href="/decisions"');
  expect(body).toContain('class="public-bar"');
  expect(body).toContain('<a href="/how">how Atelier works</a>');
});

it("the showcase leads with what Atelier is and keeps the tally as its sub-head", async () => {
  const record = { name: "lead-check", repo: "lead-check", policy: { checks: [], protected: [] }, createdAt: time };
  await L("lead-check").setProject(record, "owner");
  await I().registerProject(record);
  await L("lead-check").newItem("Tidy the desk", [], "owner");
  await L("lead-check").claim("t1", "codex/gpt-6");
  // One task, as it happened, tells a merged task only (t578).
  await L("lead-check").setFork("t1", "lead-check--t1", "1".repeat(40), "codex/gpt-6");
  await L("lead-check").recordPush("t1", "codex/gpt-6", head, head);
  await L("lead-check").addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", head, passed: true, by: "codex/gpt-6", at: time, changedPaths: ["src/a.ts"] });
  await L("lead-check").submit("t1", "codex/gpt-6");
  await L("lead-check").accept("t1", "owner", head);
  await L("lead-check").merged("t1", "owner", "d".repeat(40), true, head);
  await I().setShowcase("lead-check", "named");
  const body = await (await worker.fetch(new Request("https://atelier.test/showcase"), testEnv)).text();
  expect(body).toContain("<h1>Git keeps the code. Atelier brings the receipts.</h1>");
  expect(body).toContain('<p class="show-what">A Git platform for multiple coding agents, built on Cloudflare.</p>');
  expect(body).toContain("Repositories in Artifacts, the record in Durable Objects, landings as Workflows, checks in Containers on request.");
  // The canvas's order (d29): the hero, the comparison when there is one, the
  // tally with its evidence key, the portfolio, one task, the steps, the
  // moves, where it runs.
  const order = ['id="top"', 'id="tally-h"', 'class="evidence-key"', 'id="portfolio-h"', 'id="story-h"', 'id="travels-h"', 'id="moves-h"', 'id="where-h"', 'class="show-foot"'].map((m) => body.indexOf(m));
  expect(order.every((at) => at > 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // How a task travels names its seven steps, each counted from the tally.
  const travels = body.slice(body.indexOf('id="travels-h"'), body.indexOf('id="moves-h"'));
  expect([...travels.matchAll(/<h3>([A-Za-z]+)<\/h3>/g)].map((m) => m[1])).toEqual(["Planned", "Claimed", "Worked", "Checked", "Reviewed", "Decided", "Merged"]);
  expect(travels).toMatch(/<span class="travel-count">\d+ planned<\/span>/);
  expect(travels).toMatch(/<span class="travel-count">\d+ tasks? taken, \d+ handoffs?<\/span>/);
  // The steps take the accent, not the agents' family colours.
  expect(travels).not.toContain("--m-");
  expect(body).toContain("The owner made 1 decision.");
});

it("the comparison uses the shown project with the largest imported history when the same project's is thin", async () => {
  const at = (d: number, m = 0) => new Date(Date.UTC(2026, 9, d, 12, m)).toISOString();
  const evs = [
    { seq: 1, at: at(5, 0), actor: "pavi", kind: "item.created", itemId: "t1", data: {} },
    { seq: 2, at: at(5, 1), actor: "codex/gpt-6-astra", kind: "item.claimed", itemId: "t1", data: {} },
  ].reverse();
  const samey = buildStory("samey", [{ id: "t1", title: "Work", state: "claimed" }] as never, evs as never, "pavi", false, "Samey", { redact: true, ownerLabel: "PAVI" });
  const photo = buildStory("photograph", [], [], "pavi", false, "Photograph", { redact: true, ownerLabel: "PAVI" });
  const commits = (total: number) => Array.from({ length: total }, (_, i) => ({ hash: `h${i}`, committedAt: i + 1, message: i % 2 ? "x" : "x\n\nAgent: codex/gpt-6" }));
  const imported = new Map([
    ["samey", buildImported(commits(9), null, true)],
    ["photograph", buildImported(commits(3000), null, true)],
  ]);
  const cards: ShownProject[] = [
    { project: { name: "samey", repo: "samey", policy: { checks: [], protected: [] }, createdAt: time }, mode: "named", story: samey },
    { project: { name: "photograph", repo: "photograph", policy: { checks: [], protected: [] }, createdAt: time }, mode: "named", story: photo },
  ];
  const html = renderShowcase([samey, photo], samey.tally, "pavi", "PAVI", false, imported, cards);
  const before = html.split('class="compare-card before"')[1].split("</article>")[0];
  expect(before).toContain(">Photograph<");
  expect(before).toContain("<dt>3,000</dt><dd>commits</dd>");
  expect(before).not.toContain(">Samey<");
  expect(html.split('class="compare-card with"')[1].split("</article>")[0]).toContain(">Samey<");
});

it("the comparison prefers a project with a substantial history of its own over a busier one whose history is thin", async () => {
  const at = (d: number, m = 0) => new Date(Date.UTC(2026, 9, d, 12, m)).toISOString();
  const story = (name: string, label: string, ids: string[]) => buildStory(name, ids.map((id) => ({ id, title: "Work", state: "claimed" })) as never,
    ids.flatMap((id, i) => [
      { seq: 2 * i + 1, at: at(5, 2 * i), actor: "pavi", kind: "item.created", itemId: id, data: {} },
      { seq: 2 * i + 2, at: at(5, 2 * i + 1), actor: "codex/gpt-6-astra", kind: "item.claimed", itemId: id, data: {} },
    ]).reverse() as never, "pavi", false, label, { redact: true, ownerLabel: "PAVI" });
  const busy = story("busy", "Busy", ["t1", "t2", "t3"]);
  const deep = story("deep", "Deep", ["t1"]);
  const photo = buildStory("photograph", [], [], "pavi", false, "Photograph", { redact: true, ownerLabel: "PAVI" });
  const commits = (total: number) => Array.from({ length: total }, (_, i) => ({ hash: `h${i}`, committedAt: i + 1, message: "x" }));
  const imported = new Map([
    ["busy", buildImported(commits(9), null, true)],
    ["deep", buildImported(commits(400), null, true)],
    ["photograph", buildImported(commits(3000), null, true)],
  ]);
  const card = (name: string, s: typeof busy): ShownProject => ({ project: { name, repo: name, policy: { checks: [], protected: [] }, createdAt: time }, mode: "named", story: s });
  const html = renderShowcase([busy, deep, photo], busy.tally, "pavi", "PAVI", false, imported, [card("busy", busy), card("deep", deep), card("photograph", photo)]);
  const before = html.split('class="compare-card before"')[1].split("</article>")[0];
  expect(before).toContain(">Deep<");
  expect(before).toContain("<dt>400</dt><dd>commits</dd>");
  expect(html.split('class="compare-card with"')[1].split("</article>")[0]).toContain(">Deep<");
});

it("the How page's command reference arrives collapsed, each group closed until opened", async () => {
  const body = await (await worker.fetch(new Request("https://atelier.test/how"), testEnv)).text();
  expect(body.match(/<details class="how-group"/g)).toHaveLength(HELP_GROUPS.length);
  expect(body).not.toContain('<details class="how-group" open');
  expect(body).toContain('<summary>Sessions</summary>');
  expect(body).toContain('<summary>Projects</summary>');
});

it("the public navigation never breaks a link's words and wraps under the brand on a narrow screen", () => {
  const rule = /\.public-bar nav a \{[^}]*\}/.exec(layout)?.[0] ?? "";
  expect(rule).toContain("white-space: nowrap");
  const narrow = /@media \(max-width: 480px\) \{[\s\S]*?\}/.exec(layout)?.[0] ?? "";
  expect(narrow).toContain(".public-bar");
  expect(narrow).toContain("flex-wrap: wrap");
  // The sign-in backdrop is clipped to the viewport.
  expect(layout).toMatch(/\.login-backdrop \{[\s\S]*?max-height: 100dvh; overflow: clip;/);
});

it("the showcase is held for a minute at most by the zone and by browsers, and says where checks run (t216)", async () => {
  const record = { name: "ttl-check", repo: "ttl-check", policy: { checks: [], protected: [] }, createdAt: time };
  await L("ttl-check").setProject(record, "owner");
  await I().registerProject(record);
  await I().setShowcase("ttl-check", "named");
  for (let i = 0; i < 2; i++) { // the second read is served from the cache
    const res = await worker.fetch(new Request("https://atelier.test/showcase"), testEnv);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    expect(res.headers.get("cdn-cache-control")).toBe("max-age=60");
    const body = await res.text();
    expect(body).toContain("on the machine that asks for them; in a Cloudflare container only with --sandbox, or where the project requires it.");
    expect(body).not.toContain("or, where the project allows it, on the agent");
  }
});

// Audit 2026-10-06, split out of t219 as t276: a commit hash drawn on an
// anonymised project's graph or pages could be searched in a public
// repository and name the project, so an anonymised story carries none, while
// a project shown named still names its revisions.
it("an anonymised project's commit hashes never reach the showcase or the sign-in page; a named project's still do", async () => {
  const hashed = async (name: string, base: string, head: string, merge: string) => {
    const record = { name, repo: name, title: `${name} title`, policy: { checks: [], protected: [] }, createdAt: time };
    await L(name).setProject(record, "owner");
    await I().registerProject(record);
    const l = L(name);
    await l.newItem("Ship the fix", [], "owner");
    await l.claim("t1", "codex/gpt-6");
    await l.setFork("t1", `${name}--t1`, base, "codex/gpt-6");
    await l.recordPush("t1", "codex/gpt-6", head, head);
    await l.addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", head, passed: true, by: "codex/gpt-6", at: time, changedPaths: ["src/a.ts"] });
    await l.submit("t1", "codex/gpt-6");
    await l.accept("t1", "owner", head);
    await l.merged("t1", "owner", merge, true, head);
  };
  await hashed("hush-hash", "1".repeat(40), "e7a1c0de".repeat(5), "c0ffee42".repeat(5));
  await hashed("named-hash", "2".repeat(40), "5eedba5e".repeat(5), "dec0ded5".repeat(5));
  await I().setShowcase("hush-hash", "anonymous");
  await I().setShowcase("named-hash", "named");
  const body = await (await worker.fetch(new Request("https://atelier.test/showcase"), testEnv)).text();
  expect(body.match(/<dt>merged, all time<\/dt><dd>1<\/dd>/g)?.length).toBeGreaterThanOrEqual(2);
  // A named project's revisions stay named: its merge, in the latest moves.
  expect(body).toContain("accepted t1; merged into main as dec0ded5");
  expect(body).not.toContain("e7a1c0de"); // an anonymised project's hashes are gone
  expect(body).not.toContain("c0ffee42");
  // The sign-in page draws the same anonymised activity behind its form.
  const login = await (await worker.fetch(new Request("https://atelier.test/login"), testEnv)).text();
  expect(login).not.toContain("e7a1c0de");
  expect(login).not.toContain("c0ffee42");
});

it("an anonymised story carries no commit hash in its beads, moments or drawing; a redacted named one keeps them", () => {
  const at = (seq: number) => `2026-10-05T10:0${seq}:00.000Z`;
  const H = "e7a1c0de".repeat(5), M = "c0ffee42".repeat(5);
  const evs = [
    { seq: 1, at: at(1), actor: "pavi", kind: "item.created", itemId: "t1", data: {} },
    { seq: 2, at: at(2), actor: "codex/gpt-6", kind: "item.claimed", itemId: "t1", data: {} },
    { seq: 3, at: at(3), actor: "codex/gpt-6", kind: "push.observed", itemId: "t1", data: { head: H } },
    { seq: 4, at: at(4), actor: "codex/gpt-6", kind: "item.submitted", itemId: "t1", data: { head: H } },
    { seq: 5, at: at(5), actor: "pavi", kind: "item.accepted", itemId: "t1", data: { head: H } },
    { seq: 6, at: at(6), actor: "pavi", kind: "item.merged", itemId: "t1", data: { mergeCommit: M } },
  ];
  const items = [{ id: "t1", title: "Ship the fix", state: "merged" }];
  const card = (s: Story, mode: "named" | "anonymous"): ShownProject =>
    ({ project: { name: s.project, repo: s.project, policy: { checks: [], protected: [] }, createdAt: time }, mode, story: s });
  const anon = buildStory("hush", items as never, evs as never, "pavi", false, "An iOS app", { redact: true, anon: true });
  const anonHtml = renderShowcase([anon], anon.tally, "pavi", "PAVI", false, new Map(), [card(anon, "anonymous")]);
  for (const hash of [H.slice(0, 8), M.slice(0, 8)]) {
    expect(anon.threads.flatMap((th) => th.beads.map((b) => b.label)).join(" "), hash).not.toContain(hash);
    expect(anon.moments.map((m) => m.text).join(" "), hash).not.toContain(hash);
    expect(anonHtml, hash).not.toContain(hash);
  }
  expect(anonHtml).not.toContain("merged as");
  // Redacted but named, the revisions stay named: only the anonymised form drops them.
  const named = buildStory("named-tool", items as never, evs as never, "pavi", false, "Named Tool", { redact: true });
  const namedHtml = renderShowcase([named], named.tally, "pavi", "PAVI", false, new Map(), [card(named, "named")]);
  expect(namedHtml).toContain(H.slice(0, 8));
  expect(namedHtml).toContain(M.slice(0, 8));
});

// Seen live on 13 Oct 2026 (t578): the showcase read the last 3,000 events,
// which on Atelier's own busy ledger covered eight hours, so it said 0 merged
// in two weeks beside 379 all time and told an open, failing task as its
// story. Every figure is now counted over the whole record, and the story is
// a merged task read from its own events.
it("the showcase counts the whole record, not the most recent events, and tells a merged task", async () => {
  const name = "busy-record";
  const record = { name, repo: name, title: "Busy Record", policy: { checks: [], protected: [] }, createdAt: time };
  await L(name).setProject(record, "owner");
  await I().registerProject(record);
  const l = L(name);
  await l.newItem("Ship the parser", [], "owner");
  await l.claim("t1", "codex/gpt-6");
  await l.setFork("t1", `${name}--t1`, "1".repeat(40), "codex/gpt-6");
  await l.recordPush("t1", "codex/gpt-6", head, head);
  await l.addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", head, passed: true, by: "codex/gpt-6", at: time, changedPaths: ["src/a.ts"] });
  await l.addReview({ itemId: "t1", criteria: await l.criteria("t1"), by: "zcode/glm-5.3", head, approve: false, note: "not yet", at: time });
  await l.addReview({ itemId: "t1", criteria: await l.criteria("t1"), by: "zcode/glm-5.3", head, approve: true, note: "fine now", at: time });
  await l.submit("t1", "codex/gpt-6");
  await l.accept("t1", "owner", head);
  await l.merged("t1", "owner", "d".repeat(40), true, head);
  await l.newItem("Chase the flaky build", [], "owner");
  await l.claim("t2", "codex/gpt-6");
  // More events than any read limit, all after the merge: failing checks on the open task.
  const NOISE = 3200;
  await runInDurableObject(l, async (_: unknown, state: DurableObjectState) => {
    const at = new Date().toISOString();
    for (let i = 0; i < NOISE; i++) {
      state.storage.sql.exec(`INSERT INTO events (item_id, at, actor, kind, data) VALUES ('t2', ?, 'atelier/sandbox', 'evidence.observed', ?)`, at, JSON.stringify({ passed: false, where: "sandbox", claim: "npm test" }));
    }
  });
  // This project alone is shown, so the page's figures are its own.
  for (const e of await I().showcaseEntries()) await I().removeShowcase(e.name);
  await I().setShowcase(name, "named");
  const body = await (await worker.fetch(new Request("https://atelier.test/showcase"), testEnv)).text();
  // The figures count every event: the merge, the review and the owner's
  // acceptance happened before the last 3,000 events.
  expect(body).toContain(`<dt>checks run on a clean copy, ${NOISE.toLocaleString("en")} in Cloudflare</dt><dd>${(NOISE + 1).toLocaleString("en")}</dd>`);
  expect(body).toContain("<dt>times a model sent work back</dt><dd>1</dd>");
  expect(body).toContain("The owner made 1 decision.");
  expect(body).toContain("<dt>merged, last two weeks</dt><dd>1</dd>");
  expect(body).toContain("<dt>merged, all time</dt><dd>1</dd>");
  expect(body).toContain("<dt>sent back, last two weeks</dt><dd>1</dd>");
  expect(body).not.toContain("the most recent part of the record");
  // The story is the merged task, sent back once, not the open one with thousands of failures.
  const story = body.slice(body.indexOf('id="story-h"'), body.indexOf("</section>", body.indexOf('id="story-h"')));
  expect(story).toContain("t1 · Ship the parser");
  expect(story).not.toContain("t2");
  expect(story).toContain("sent it back");
});

// t578's first deploy left every project out when its whole-record counts
// failed, behind a catch that logged nothing. A project whose counts cannot
// be read is still shown, from its recent events, and the error is logged.
it("a project whose whole-record counts fail is still shown, from its recent events, and the error is logged", async () => {
  const name = "counts-fail";
  const record = { name, repo: name, title: "Counts Fail", policy: { checks: [], protected: [] }, createdAt: time };
  await L(name).setProject(record, "owner");
  await I().registerProject(record);
  await L(name).newItem("Mend the gate", [], "owner");
  await L(name).claim("t1", "codex/gpt-6");
  // The Ledger's counts fail for this test alone; the method is restored after it.
  type Proto = { showcaseCounts: (...a: unknown[]) => unknown };
  const real = await runInDurableObject(L(name), async (instance: object) => {
    const proto = Object.getPrototypeOf(instance) as Proto;
    const was = proto.showcaseCounts;
    proto.showcaseCounts = () => { throw new Error("no such table: events_fake"); };
    return was;
  });
  for (const e of await I().showcaseEntries()) await I().removeShowcase(e.name);
  await I().setShowcase(name, "named");
  const logged: string[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.join(" ")); };
  try {
    const body = await (await worker.fetch(new Request("https://atelier.test/showcase"), testEnv)).text();
    expect(body).not.toContain("could not be read just now");
    expect(body).toContain("<h3>Counts Fail</h3>");
    expect(body).toContain("gpt-6 took t1");
  } finally {
    console.error = error;
    await runInDurableObject(L(name), async (instance: object) => { (Object.getPrototypeOf(instance) as Proto).showcaseCounts = real; });
  }
  expect(logged.join("\n")).toContain("showcase: the whole-record counts of counts-fail could not be read: no such table: events_fake");
});
