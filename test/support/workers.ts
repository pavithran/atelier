// The three names the Workers tests took from `cloudflare:test` and
// `cloudflare:workers` (env, SELF, runInDurableObject), for the Node server
// (Atelier 2.0, task 7; design-branches-2026-10-28.md, section 4.2). Each
// test file that imports this starts one server of its own (startServer,
// env "test") with a data directory of its own, so its Ledgers are new, as
// each file's storage was in the Workers pool. `env` is that server's
// bindings: LEDGER is its namespace. The vars are the ones wrangler.jsonc gave
// the Workers pool. The server and its directory go when the file's tests end.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
// @ts-expect-error the server is plain JavaScript without declarations
import { startServer } from "../../src/runtime/server.mjs";
import worker from "../../src/index.ts";
import { installDefaultProof } from "./proof.ts";
import "./default-runner.ts";

installDefaultProof();

const root = mkdtempSync(join(tmpdir(), "atelier-spec-"));
const server = await startServer({
  env: "test", dataDir: join(root, "data"), host: "127.0.0.1",
  vars: { AI_GATEWAY_ID: "atelier", PUBLIC_ORIGIN: "https://atelier.zone", ARTIFACTS_NAMESPACE: "atelier" },
});
after(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

export const env = server.settings as Env;
export { server };

type Stub = { name?: string; id?: { name?: string } };
// The namespace's own object behind a stub: its queue, its instance.
type Held = { run<T>(fn: () => Promise<T>): Promise<T>; live: { ctx: DurableObjectState; alarm?: (info: unknown) => Promise<void> }; row(): { at: number | null; gen: number }; write(at: number | null): void; firing: number | null };
const held = (stub: unknown): Held => {
  const s = stub as Stub;
  const name = s.name ?? s.id?.name;
  if (!name) throw new Error("runInDurableObject: not a stub of this server's namespace");
  return (server.namespace as unknown as { object(name: string): Held }).object(name);
};

// Runs fn on the object's live instance, in its queue, as the Workers pool did.
// The instance's type is the stub's, or the one fn names.
export function runInDurableObject<O, R>(stub: DurableObjectStub<O>, fn: (instance: O, state: DurableObjectState) => R | Promise<R>): Promise<R>;
export function runInDurableObject<O, R>(stub: unknown, fn: (instance: O, state: DurableObjectState) => R | Promise<R>): Promise<R>;
export function runInDurableObject<O, R>(stub: unknown, fn: (instance: O, state: DurableObjectState) => R | Promise<R>): Promise<R> {
  const o = held(stub);
  return o.run(async () => fn(o.live as unknown as O, o.live.ctx));
}

// Runs the object's alarm now if one is set; true when it ran.
export function runDurableObjectAlarm(stub: unknown): Promise<boolean> {
  const o = held(stub);
  return o.run(async () => {
    const kept = o.row();
    if (kept.at === null || typeof o.live.alarm !== "function") return false;
    o.firing = kept.gen;
    try { await o.live.alarm({ retryCount: 0, isRetry: false }); } finally { o.firing = null; }
    if (o.row().gen === kept.gen) o.write(null);
    return true;
  });
}

// worker.fetch on this server's bindings, as SELF.fetch was.
export const SELF = {
  fetch: (input: Request | string | URL, init?: RequestInit) => worker.fetch(new Request(input, init), env, createExecutionContext()),
};

type Ctx = ExecutionContext & { kept: Promise<unknown>[] };
export function createExecutionContext(): Ctx {
  const kept: Promise<unknown>[] = [];
  return { kept, waitUntil: (p: Promise<unknown>) => { kept.push(p); }, passThroughOnException() {}, props: {} } as unknown as Ctx;
}
export async function waitOnExecutionContext(ctx: ExecutionContext): Promise<void> {
  await Promise.allSettled((ctx as Ctx).kept);
}
