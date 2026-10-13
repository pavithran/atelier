import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { Ledger } from "../src/ledger.ts";
import { UPDATING_DETAIL } from "../src/rules.ts";

// A deploy leaves a busy Ledger running the old code (t586). On 2026-10-13
// from 09:35 to 10:05 EDT, after the deploys of t578 and t585, the atelier
// Ledger answered "The RPC receiver does not implement the method" for
// showcaseCounts and mode, and the showcase showed zeros, until every
// runner was stopped for about 70 s and it went idle.
//
// A stale Ledger is played here by taking a method off Ledger.prototype:
// the Ledgers run in this isolate, so a call to the method meets the
// runtime's own missing-method answer, as one to an older build does. A
// Ledger built for an older DEPLOYED_MAIN is played by giving its instance
// that var, since a Durable Object reads the vars of the deploy it runs.

const TOKEN = "stale-ledger-test-token";
const OLD = "a".repeat(40), NEW = "b".repeat(40);
const testEnv = { ...env, ATELIER_TOKEN: TOKEN, DEPLOYED_MAIN: NEW } as typeof env;
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L(name).setProject(record, "owner");
  await I().registerProject(record);
}
function api(method: string, path: string) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner" },
  }), testEnv);
}

// Runs fn while every Ledger in this isolate lacks the method.
async function without<T>(method: string, fn: () => Promise<T>): Promise<T> {
  const proto = Ledger.prototype as unknown as Record<string, unknown>;
  const saved = Object.getOwnPropertyDescriptor(proto, method)!;
  expect(saved, `Ledger.prototype.${method}`).toBeTruthy();
  delete proto[method];
  try { return await fn(); } finally { Object.defineProperty(proto, method, saved); }
}

// Marks the running Ledger instance, so a later look tells whether it was
// replaced by a restart; answers its stored last restart.
async function mark(name: string, extra?: (instance: Record<string, unknown>) => void): Promise<void> {
  await runInDurableObject(L(name), (instance) => {
    (instance as unknown as Record<string, unknown>).marked = true;
    extra?.(instance as unknown as Record<string, unknown>);
  });
}
async function look(name: string): Promise<{ marked: boolean; restart: { at: number; from: string | null; for: string | null } | null }> {
  return runInDurableObject(L(name), (instance, state) => {
    const raw = state.storage.sql.exec(`SELECT value FROM meta WHERE key = 'ledger-restart'`).toArray()[0]?.value;
    return { marked: (instance as unknown as Record<string, unknown>).marked === true, restart: typeof raw === "string" ? JSON.parse(raw) : null };
  });
}

it("the mode route says the server is updating when the Ledger lacks the method, and the Ledger restarts once idle", async () => {
  await project("stale-mode");
  await mark("stale-mode");
  const res = await without("mode", () => api("GET", "/projects/stale-mode/mode"));
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "server_updating", detail: UPDATING_DETAIL });
  // The Worker asked the Ledger to restart (restartForUpdate), which it
  // does once no call is in flight.
  await wait(300);
  const after = await look("stale-mode");
  expect(after.marked, "a fresh instance answers after the restart").toBe(false);
  expect(after.restart).toMatchObject({ for: NEW });
  // The restarted Ledger serves the method.
  const ok = await api("GET", "/projects/stale-mode/mode");
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ mode: "full" });
});

it("the showcase says the server is updating instead of printing figures it could not count", async () => {
  await project("stale-show");
  await I().setShowcase("stale-show", "named");
  const res = await without("showcaseCounts", () => worker.fetch(new Request("https://atelier.test/showcase"), testEnv));
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("The server is updating; the figures return in a minute.");
  expect(body).not.toContain("could not be read just now");
  // Not kept for the full minute, so the figures return once it restarts.
  expect(res.headers.get("cache-control")).toBe("public, max-age=10, s-maxage=10");
  await wait(300);
  const again = await (await worker.fetch(new Request("https://atelier.test/showcase"), testEnv)).text();
  expect(again).not.toContain("The server is updating");
});

it("a Ledger built for an older DEPLOYED_MAIN restarts when the Worker first addresses it, at most once a minute", async () => {
  await project("stale-version");
  await mark("stale-version", (instance) => { instance.env = { ...(instance.env as object), DEPLOYED_MAIN: OLD }; });
  // Any route that reaches the Ledger tells it the Worker's DEPLOYED_MAIN;
  // the old Ledger serves this call and restarts after it.
  const res = await api("GET", "/projects/stale-version/mode");
  expect(res.status).toBe(200);
  await wait(300);
  const after = await look("stale-version");
  expect(after.marked).toBe(false);
  expect(after.restart).toMatchObject({ from: OLD, for: NEW });
  // Still on older code a moment later, it waits out the minute.
  await mark("stale-version", (instance) => { instance.env = { ...(instance.env as object), DEPLOYED_MAIN: OLD }; });
  expect(await L("stale-version").ledgerVersion(NEW)).toEqual({ version: OLD, restarting: false, why: "too_soon" });
  // A Ledger on the Worker's own build stays.
  await mark("stale-version", (instance) => { instance.env = { ...(instance.env as object), DEPLOYED_MAIN: NEW }; });
  expect(await L("stale-version").ledgerVersion(NEW)).toEqual({ version: NEW, restarting: false, why: "current" });
  await wait(100);
  expect((await look("stale-version")).marked).toBe(true);
});
