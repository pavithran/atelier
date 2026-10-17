// Every page and state the design brief lists (docs/design/brief.md, "Page
// states"), as the requests that draw them from the seeded fixture (seed.ts),
// and the test-only sign-in they are drawn under: the Access assertion and
// session cookie test/access.spec.ts uses, with the team's keys served by a
// stubbed fetch. The ids are the screenshots' names; scripts/design/capture.ts
// and test/fixtures/design/screens.test.mjs hold the brief, this list and the
// manifest to one another.

import { vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import worker from "../../../src/index.ts";
import { signIn } from "../../signin.ts";
import { EMPTY_PROJECT, OWNER_NAME, UNAVAILABLE_PROJECT, withUnavailable, type Seeded } from "./seed.ts";

export const ORIGIN = "https://atelier.test";
const ISS = "https://atelier-design.cloudflareaccess.com";
const AUD = "d3519n0000000000000000000000c0de";
const EMAIL = "owner@example.com";
const TOKEN = "design-capture-token";

// Who asks: nobody signed in; Access's sign-in without an Atelier session,
// which behind Access starts one (t534); the owner with both; and nobody
// signed in on a server without Access, the only one that draws the sign-in
// page's token form.
export type Audience = "public" | "access" | "owner" | "token";

export interface PageState {
  id: string;          // the screenshot name: docs/design/screens/<id>-<width>.png
  path: string;
  audience: Audience;
  status: number;      // the status the page is drawn with
  marker: string;      // text the page must hold, so a wrong page is caught
  state: string;       // what this capture shows, in the brief's words
}

// The bindings the pages are drawn with: production code, the seeded Ledger,
// an unreadable Ledger for one project, the fake Artifacts, Access in front.
export function designEnv(base: Env, seeded: Seeded): Env {
  return {
    ...base,
    LEDGER: withUnavailable(base.LEDGER, UNAVAILABLE_PROJECT),
    ARTIFACTS: seeded.git.binding(),
    ATELIER_TOKEN: TOKEN,
    CF_ACCESS_ISS: ISS,
    CF_ACCESS_AUD: AUD,
    CF_ACCESS_OWNER_EMAIL: EMAIL,
    OWNER_NAME,
    TIMEZONE: "UTC",
  } as unknown as Env;
}

const pair = await generateKeyPair("RS256");
const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "design", alg: "RS256" }] };

// Serves the Access team's keys; any other request is answered 404, so no
// page reaches the network (the AI Gateway figures, for one, read as off).
export function serveKeys() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const keys = String(input) === `${ISS}/cdn-cgi/access/certs`;
    return new Response(keys ? JSON.stringify(jwks) : "{}", { status: keys ? 200 : 404, headers: { "content-type": "application/json" } });
  });
}

export const assertion = () => new SignJWT({ email: EMAIL })
  .setProtectedHeader({ alg: "RS256", kid: "design" }).setIssuer(ISS).setAudience(AUD).setIssuedAt().setExpirationTime("1h").sign(pair.privateKey);

export async function session(env: Env): Promise<string> {
  return signIn(TOKEN, env, { "cf-access-jwt-assertion": await assertion() });
}

export async function draw(env: Env, path: string, audience: Audience, cookie: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (audience === "token") {
    const { CF_ACCESS_ISS: _iss, CF_ACCESS_AUD: _aud, CF_ACCESS_OWNER_EMAIL: _email, ...plain } = env as unknown as Record<string, unknown>;
    return worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual" }), plain as unknown as Env);
  }
  if (audience !== "public") headers["cf-access-jwt-assertion"] = await assertion();
  if (audience === "owner") headers.cookie = cookie;
  return worker.fetch(new Request(`${ORIGIN}${path}`, { headers, redirect: "manual" }), env);
}

export function pageStates(s: Seeded): PageState[] {
  const lc = (shape: keyof Seeded["byShape"][string]) => s.byShape["ledger-core"][shape]![0];
  const task = (id: string, shape: string, status: number, marker: string, state: string): PageState =>
    ({ id: `task-${shape}`, path: `/p/ledger-core/${id}`, audience: "owner", status, marker, state });
  const merged = lc("merged");
  return [
    // Public
    { id: "public-how", path: "/how", audience: "public", status: 200, marker: "How", state: "The explainer" },
    { id: "public-owner-route", path: "/p/ledger-core", audience: "public", status: 401, marker: "behind Cloudflare Access", state: "A visitor on an owner URL without Access's sign-in" },
    { id: "signin", path: "/login", audience: "token", status: 200, marker: "Sign in to Atelier", state: "Sign-in" },
    // Cross-project
    { id: "home", path: "/home", audience: "owner", status: 200, marker: "Ledger Core", state: "Portfolio: dense, empty and unavailable projects" },
    { id: "decisions", path: "/decisions", audience: "owner", status: 200, marker: "aria-labelledby=\"sel-h\"", state: "Inbox with the first decision selected" },
    { id: "decisions-sent-back", path: `/decisions?project=ledger-core&task=${lc("sentBack")}`, audience: "owner", status: 200, marker: "Changes requested", state: "A sent-back task selected" },
    { id: "decisions-blocked", path: `/decisions?project=ledger-core&task=${lc("blocked")}`, audience: "owner", status: 200, marker: "Blocked", state: "A blocked task selected" },
    { id: "studio", path: "/studio", audience: "owner", status: 200, marker: "at work", state: "The floor with live, stale and overlapping work" },
    { id: "flow", path: "/flow", audience: "owner", status: 200, marker: "every project", state: "Every project's flow, all time" },
    { id: "flow-filtered", path: "/flow?since=1d&family=anthropic", audience: "owner", status: 200, marker: "every project", state: "Flow filtered to the last day and one family" },
    { id: "history", path: "/history", audience: "owner", status: 200, marker: "Merged", state: "Timeline of 231 merges and 10 closures" },
    { id: "models", path: "/models", audience: "owner", status: 200, marker: "Models", state: "Empty pool, track record from the seeded events, Gateway off" },
    { id: "usage", path: "/usage", audience: "owner", status: 200, marker: "Usage", state: "Two runners' reports, one stale, one alert" },
    // A project's area
    { id: "project", path: "/p/ledger-core", audience: "owner", status: 200, marker: "Tasks by state", state: "Dense project overview (200 tasks)" },
    { id: "project-empty", path: `/p/${EMPTY_PROJECT}`, audience: "owner", status: 200, marker: "Nothing waits on you here", state: "Project with no tasks" },
    { id: "project-unavailable", path: `/p/${UNAVAILABLE_PROJECT}`, audience: "owner", status: 503, marker: "unable to reach its records", state: "Project whose Ledger cannot be read" },
    { id: "tasks", path: "/p/ledger-core/tasks", audience: "owner", status: 200, marker: "Create a task", state: "All 200 tasks in one list" },
    { id: "tasks-empty", path: `/p/${EMPTY_PROJECT}/tasks`, audience: "owner", status: 200, marker: "No tasks.", state: "Task board with no tasks: one empty Unsorted area" },
    { id: "project-flow", path: "/p/ledger-core/flow", audience: "owner", status: 200, marker: "Ledger Core", state: "One project's flow" },
    { id: "plans", path: "/p/ledger-core/plans", audience: "owner", status: 200, marker: "No plans yet", state: "No plans" },
    { id: "ship", path: "/p/ledger-core/ship", audience: "owner", status: 200, marker: "No action has been approved yet", state: "No protected action approved" },
    { id: "settings", path: "/p/ledger-core/settings", audience: "owner", status: 200, marker: "npm run typecheck", state: "Checks and protected paths" },
    { id: "code", path: "/p/ledger-core/code", audience: "owner", status: 200, marker: "README.md", state: "Baseline root directory" },
    { id: "code-dir", path: "/p/ledger-core/code/src", audience: "owner", status: 200, marker: "ledger.ts", state: "A directory" },
    { id: "code-file", path: "/p/ledger-core/code/src/ui.ts", audience: "owner", status: 200, marker: "src/ui.ts of ledger-core", state: "A file" },
    { id: "code-no-commits", path: `/p/${EMPTY_PROJECT}/code`, audience: "owner", status: 404, marker: "no commits yet", state: "A baseline with no commits" },
    { id: "log", path: "/p/ledger-core/log", audience: "owner", status: 200, marker: "Merge t", state: "Log, first page of 157 commits" },
    { id: "log-page-2", path: "/p/ledger-core/log?page=1", audience: "owner", status: 200, marker: "Merge t", state: "Log, second page" },
    { id: "commit", path: `/p/ledger-core/commit/${s.mainHead["ledger-core"]}`, audience: "owner", status: 200, marker: "Initial commit", state: "One commit (the first)" },
    { id: "path-history", path: "/p/ledger-core/history/src/ui.ts", audience: "owner", status: 200, marker: "src/ui.ts", state: "The commits that changed one path" },
    // A task's page, one per state
    task(lc("open"), "open-long", 200, "Ready to start", "Unclaimed task with a long title and brief"),
    task(lc("working"), "working", 200, "Working", "Claimed, pushed, no checks yet"),
    task(lc("stale"), "stale", 200, "Working", "Claimed, nothing pushed for two days"),
    task(lc("blocked"), "blocked", 200, "Blocked", "Blocked by its holder"),
    task(lc("failed"), "failed", 200, "Failed", "Submitted with a failing check"),
    task(lc("ready"), "unreadable", 200, "could not be read from Artifacts", "Ready to accept; the diff cannot be read"),
    task(s.byShape["ledger-core"].ready![1], "ready", 200, "Ready to accept", "Ready to accept, diff shown"),
    task(lc("protected"), "protected", 200, "independent review", "Protected path: review required"),
    task(lc("sentBack"), "sent-back", 200, "Changes requested", "Checks passed, then sent back (the t435 shape)"),
    task(lc("accepted"), "accepted", 200, "Ready to merge", "Accepted, waiting for the merge"),
    task(lc("scope"), "scope", 200, "Scope changed", "Changes outside its declared scope"),
    task(merged, "merged", 200, "Merged", "Merged, diff as it landed"),
    task(lc("abandoned"), "abandoned", 200, "Task closed", "Closed without merging"),
    { id: "task-not-found", path: "/p/ledger-core/t9999", audience: "owner", status: 404, marker: "t9999", state: "A task id that does not exist" },
    { id: "fork-code", path: `/p/ledger-core/${lc("working")}/code`, audience: "owner", status: 200, marker: "README.md", state: "A task's workspace, browsed" },
    { id: "fork-none", path: `/p/ledger-core/${lc("open")}/code`, audience: "owner", status: 404, marker: "has no fork yet", state: "Browsing a task with no workspace" },
  ];
}

// Addresses that answer with a redirect, asserted by fixture.spec.ts and
// listed in the brief, not captured: the page they lead to is.
export const ALIASES: { path: string; audience: Audience; status: number; location: string }[] = [
  { path: "/", audience: "public", status: 302, location: "/home" },
  { path: "/showcase", audience: "public", status: 302, location: "/home" },
  { path: "/projects", audience: "owner", status: 301, location: "/home" },
  { path: "/flow?project=ledger-core", audience: "owner", status: 301, location: "/p/ledger-core/flow" },
  { path: "/home", audience: "token", status: 303, location: "/login" },
];
