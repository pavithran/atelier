import { env } from "cloudflare:workers";
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
  await l.addReview({ itemId: "t1", by: "zcode/glm-5.3", head, approve: false, note: "secret reviewer note", at: time });
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
  // What the page says instead: a neutral label from the project's kind, the
  // kind of work of each task story, and the card's counts and families.
  expect(body).toContain("<h2>An iOS app</h2>");
  expect(body).toContain("A fix");
  expect(body).toMatch(/<b>0<\/b>merged/);
  expect(body).toMatch(/<b>1<\/b>sent back/);
  expect(body).toMatch(/<b>1<\/b>in progress/);
  expect(body).toContain('class="pulse-graph"');
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
  expect(body).toContain("<h2>Open Tool</h2>");
  expect(body).toContain("Polish the handle");
  expect(body).not.toContain("Hush Secret Title");
  expect(body).toContain("<h2>An iOS app</h2>");
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
  const home = await (await worker.fetch(new Request("https://atelier.test/", { headers: { cookie } }), testEnv)).text();
  expect(home).toContain('action="/projects/showcase"');
  expect((await OWNER_TOKEN_CALL("DELETE", "/showcase/owner-only")).status).toBe(200);
  expect(await (await OWNER_TOKEN_CALL("GET", "/showcase")).text()).not.toContain("owner-only");
});

it("the sign-in page stands in the public shell, with no signed-in rail", async () => {
  const body = await (await worker.fetch(new Request("https://atelier.test/login"), testEnv)).text();
  expect(body).not.toContain('class="rail"');
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
  await I().setShowcase("lead-check", "named");
  const body = await (await worker.fetch(new Request("https://atelier.test/showcase"), testEnv)).text();
  expect(body).toContain("<h1>A Git platform for many coding agents</h1>");
  expect(body.indexOf("One owner per task, evidence observed, another model family reviews, the owner decides.")).toBeGreaterThan(0);
  expect(body.indexOf('class="subhead"')).toBeGreaterThan(body.indexOf("<h1>A Git platform"));
  expect(body).toContain("The owner made 0 decisions.");
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
  const before = html.split('class="compare-card before"')[1].split("</a>")[0];
  expect(before).toContain(">Photograph<");
  expect(before).toContain("<b>3,000</b> commits");
  expect(before).not.toContain(">Samey<");
  expect(html.split('class="compare-card with"')[1].split("</a>")[0]).toContain(">Samey<");
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
  const before = html.split('class="compare-card before"')[1].split("</a>")[0];
  expect(before).toContain(">Deep<");
  expect(before).toContain("<b>400</b> commits");
  expect(html.split('class="compare-card with"')[1].split("</a>")[0]).toContain(">Deep<");
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
  expect(body).toContain("5eedba5e");    // a named project's revisions stay named
  expect(body).toContain("dec0ded5");
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
