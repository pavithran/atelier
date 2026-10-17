import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { Ledger } from "../src/ledger.ts";
import { UPDATING_DETAIL } from "../src/rules.ts";
import { signIn } from "./signin.ts";

// A deploy leaves a busy Ledger running the old code (t586). On 2026-10-13
// from 09:35 to 10:05 EDT, after the deploys of t578 and t585, the atelier
// Ledger answered "The RPC receiver does not implement the method" for
// showcaseCounts and mode, and the showcase showed zeros, until every
// runner was stopped for about 70 s and it went idle.
//
// A stale Ledger is played here by a method on Ledger.prototype that
// throws the runtime's missing-method answer (without, below): the Ledgers
// run in this isolate, so a call to the method meets that answer, as one to
// an older build does. A
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

// Runs fn while every Ledger in this isolate answers the method as one
// without it does: the method throws the runtime's own missing-method error,
// in the words a deployed Ledger answers. It is not deleted from the
// prototype (t619): the Workers test pool looks a method up as soon as the
// call arrives and runs the calls to one object in turn, so the lookup of a
// deleted method failed while its call still waited behind the Worker's
// ledgerVersion, and under load that failure was reported as an unhandled
// rejection, ending npm test with exit 1 though every test passed.
async function without<T>(method: string, fn: () => Promise<T>): Promise<T> {
  const proto = Ledger.prototype as unknown as Record<string, unknown>;
  const saved = Object.getOwnPropertyDescriptor(proto, method)!;
  expect(saved, `Ledger.prototype.${method}`).toBeTruthy();
  Object.defineProperty(proto, method, { ...saved, value() { throw new TypeError(`The RPC receiver does not implement the method "${method}".`); } });
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

// t619: under the full suite's load the test above left an unhandled
// rejection behind ("The RPC receiver does not implement "mode"", from
// getDurableObjectRPCProperty in the Workers test pool), and npm test exited
// 1 with every test passing. The pool looks a method up as soon as the call
// arrives, but runs calls to one object in turn; the Worker sends its
// ledgerVersion first (src/ledger-stub.ts), so the lookup of a method taken
// off the prototype failed while the call still waited, with nothing yet to
// handle it. Here ledgerVersion's lookup is held for 300 ms, which makes that
// wait certain; the stale Ledger must still leave no unhandled rejection.
it("a stale Ledger's missing method leaves no unhandled rejection while the call waits behind ledgerVersion", async () => {
  const proc = (globalThis as unknown as { process: { on(e: string, f: (r: unknown) => void): void; off(e: string, f: (r: unknown) => void): void } }).process;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  // Ahead of Vitest's own listener would be better, but the count suffices:
  // Vitest still reports what this sees, and this test says why.
  proc.on("unhandledRejection", onUnhandled);
  const proto = Ledger.prototype as unknown as Record<string, unknown>;
  const saved = Object.getOwnPropertyDescriptor(proto, "ledgerVersion")!;
  Object.defineProperty(proto, "ledgerVersion", {
    configurable: true,
    get(this: object) { const f = (saved.value as (...a: unknown[]) => unknown).bind(this); return new Promise((r) => setTimeout(() => r(f), 300)); },
  });
  try {
    await project("stale-queued");
    const res = await without("mode", () => api("GET", "/projects/stale-queued/mode"));
    expect(res.status).toBe(503);
    await wait(600);
  } finally {
    Object.defineProperty(proto, "ledgerVersion", saved);
    proc.off("unhandledRejection", onUnhandled);
  }
  expect(unhandled.map((r) => String(r instanceof Error ? r.message : r))).toEqual([]);
});

it("a project's showcase page says the server is updating instead of printing figures it could not count", async () => {
  await project("stale-show");
  const signed = await signIn(TOKEN, testEnv);
  const get = () => worker.fetch(new Request("https://atelier.test/p/stale-show/showcase", { headers: { cookie: signed } }), testEnv);
  const res = await without("showcaseCounts", get);
  expect(res.status).toBe(503);
  expect(await res.text()).toContain("the server is updating");
  await wait(300);
  expect((await get()).status).toBe(200);
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

// t744: the first call after the Worker's ledgerVersion met a Ledger that had
// already restarted, answering 500, when the host was slow enough that the
// call reached the Ledger more than the gate's settle time (50 ms) after
// ledgerVersion left. A slow host is played by holding the lookup of mode.
it("a slow host between ledgerVersion and the call that follows it does not fail the call", async () => {
  await project("stale-slow");
  await mark("stale-slow", (instance) => { instance.env = { ...(instance.env as object), DEPLOYED_MAIN: OLD }; });
  const proto = Ledger.prototype as unknown as Record<string, unknown>;
  const saved = Object.getOwnPropertyDescriptor(proto, "mode")!;
  Object.defineProperty(proto, "mode", {
    configurable: true,
    get(this: object) { const f = (saved.value as (...a: unknown[]) => unknown).bind(this); return new Promise((r) => setTimeout(() => r(f), 300)); },
  });
  try {
    const res = await api("GET", "/projects/stale-slow/mode");
    expect(res.status).toBe(200);
  } finally { Object.defineProperty(proto, "mode", saved); }
});
