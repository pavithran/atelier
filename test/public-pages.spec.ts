import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import layout from "../src/layout.css";
import { HELP_GROUPS } from "../src/usage.ts";
import { buildStory, drawStory } from "../src/graph.ts";
import { signIn } from "./signin.ts";

// The public pages: /how and the sign-in page, and the retired global
// showcase (t758): / and /showcase lead to the projects list, which a visitor
// who is not signed in meets as the sign-in, and nothing of the old showcase
// (its setting, its routes, the sign-in backdrop) is left to reach.

const TOKEN = "public-pages-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const time = "2026-10-03T12:00:00Z";

// Seen on 2026-10-17: the front door served a public showcase page; PAVI
// retired it. A visitor to / or /showcase is sent to /home (302), and /home
// shows the sign-in to anyone not signed in.
it("/ and /showcase answer 302 to /home, for GET and HEAD, signed in or not", async () => {
  const cookie = await signIn(TOKEN, testEnv);
  for (const path of ["/", "/showcase", "/showcase/"]) {
    for (const method of ["GET", "HEAD"]) {
      for (const headers of [{} as Record<string, string>, { cookie }]) {
        const res = await worker.fetch(new Request(`https://atelier.test${path}`, { method, headers }), testEnv);
        expect(res.status, `${method} ${path}`).toBe(302);
        expect(res.headers.get("location")).toBe("https://atelier.test/home");
      }
    }
  }
});

it("a visitor who follows the redirect meets the sign-in, with no showcase in it and no link to /showcase", async () => {
  const home = await worker.fetch(new Request("https://atelier.test/home"), testEnv);
  expect(home.status).toBeLessThan(400);
  const login = await worker.fetch(new Request("https://atelier.test/login"), testEnv);
  const body = await login.text();
  expect(body).not.toContain("login-backdrop");
  expect(body).not.toContain("over-graph");
  expect(body).not.toMatch(/public showcase/i);
  expect(body).not.toContain('href="/showcase"');
  expect(layout).not.toContain("login-backdrop");
});

it("the showcase setting is gone: no Projects page form, no API route, no form post", async () => {
  const cookie = await signIn(TOKEN, testEnv);
  const home = await (await worker.fetch(new Request("https://atelier.test/home", { headers: { cookie } }), testEnv)).text();
  expect(home).not.toContain("/projects/showcase");
  expect(home).not.toContain("Public showcase");
  const api = (method: string, path: string) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify({ mode: "named" }),
  }), testEnv);
  expect((await api("GET", "/showcase")).status).toBe(404);
  expect((await api("PUT", "/showcase/anything")).status).toBe(404);
  const form = await worker.fetch(new Request("https://atelier.test/projects/showcase", {
    method: "POST", headers: { cookie, origin: "https://atelier.test" }, body: new URLSearchParams({ project: "anything", mode: "named" }),
  }), testEnv);
  expect(form.status).toBe(404);
});

it("the sign-in page stands in the public shell, with no owner bar", async () => {
  const body = await (await worker.fetch(new Request("https://atelier.test/login"), testEnv)).text();
  expect(body).not.toContain('class="owner-bar"');
  expect(body).not.toContain('href="/decisions"');
  expect(body).toContain('class="public-bar"');
  expect(body).toContain('<a href="/how">how Atelier works</a>');
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
  const anon = buildStory("hush", items as never, evs as never, "pavi", false, "An iOS app", { redact: true, anon: true });
  const anonHtml = drawStory(anon, "pavi");
  for (const hash of [H.slice(0, 8), M.slice(0, 8)]) {
    expect(anon.threads.flatMap((th) => th.beads.map((b) => b.label)).join(" "), hash).not.toContain(hash);
    expect(anon.moments.map((m) => m.text).join(" "), hash).not.toContain(hash);
    expect(anonHtml, hash).not.toContain(hash);
  }
  // Redacted but named, the revisions stay named: only the anonymised form drops them.
  const named = buildStory("named-tool", items as never, evs as never, "pavi", false, "Named Tool", { redact: true });
  const namedHtml = drawStory(named, "pavi");
  expect(namedHtml).toContain(H.slice(0, 8));
  expect(namedHtml).toContain(M.slice(0, 8));
});
