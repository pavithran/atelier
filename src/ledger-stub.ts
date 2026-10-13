import { LEDGER_RESTART_GAP_MS, missingLedgerMethod, RuleError, UPDATING_DETAIL } from "./rules.ts";

// The Worker's side of a Ledger left on older code after a deploy (t586).
//
// The first time this isolate addresses a Ledger, it sends the Ledger its
// own DEPLOYED_MAIN (ledgerVersion); a Ledger whose code was built for
// another restarts itself once it is idle between requests (src/ledger.ts,
// src/restart-gate.ts). The message goes on the same stub as the call that
// follows it, so it reaches the Ledger first. A Ledger that cannot answer
// it (one older than t586) is asked again a minute later at the soonest.
//
// Every call made through the stub this returns that fails because the
// Ledger lacks the method asks the Ledger to restart (restartForUpdate) and
// fails instead with a 503 RuleError saying the server is updating, which
// the routes answer as they answer any rule, and which the showcase reads
// to say so on the page.

// The Ledgers this isolate has told its version: when it last tried, and
// whether one answered.
const told = new Map<string, { at: number; answered: boolean }>();

// Properties of a stub that are not Ledger methods and pass through.
const PASS = new Set(["then", "fetch", "connect", "dup", "id", "name"]);

type Stub = object;
type Call = (...args: unknown[]) => unknown;

export function guardLedger<T extends Stub>(stub: T, name: string, deployed: string | null | undefined, now: () => number = Date.now): T {
  const main = deployed?.trim() || null;
  const call = (method: string, ...args: unknown[]): Promise<unknown> => {
    try { return Promise.resolve((stub as Record<string, Call>)[method](...args)); } catch (err) { return Promise.reject(err); }
  };
  if (main) {
    const last = told.get(name);
    const t = now();
    if (!last || (!last.answered && t - last.at >= LEDGER_RESTART_GAP_MS)) {
      told.set(name, { at: t, answered: false });
      void call("ledgerVersion", main).then(
        (v) => {
          // A stale Ledger that restarted under a minute ago waits; this
          // isolate tells it again a minute later.
          const r = v as { version?: unknown; restarting?: unknown; why?: unknown } | null;
          told.set(name, { at: now(), answered: r?.why !== "too_soon" });
          if (r?.restarting) console.log(`ledger ${name} runs ${String(r.version ?? "unknown").slice(0, 12)}, the Worker ${main.slice(0, 12)}: it restarts once idle`);
        },
        (err: unknown) => {
          if (missingLedgerMethod(err)) console.error(`ledger ${name} predates ledgerVersion and cannot be told to restart; it restarts once idle (docs/orchestrating.md, "After a deploy")`);
        },
      );
    }
  }
  const updating = (err: unknown): unknown => {
    const method = missingLedgerMethod(err);
    if (!method) return err;
    console.error(`ledger ${name} lacks ${method}: it runs older code than the Worker; answering that the server is updating`);
    void call("restartForUpdate", main, method).catch(() => undefined);
    return new RuleError("server_updating", UPDATING_DETAIL, 503);
  };
  return new Proxy(stub, {
    get(target, prop) {
      const value = (target as Record<PropertyKey, unknown>)[prop];
      if (typeof prop !== "string" || PASS.has(prop) || typeof value !== "function") return value;
      // Call the method this read found, on the stub: reading the property
      // again could find another (a stub may answer each read afresh).
      return (...args: unknown[]) => {
        let result: Promise<unknown>;
        try { result = Promise.resolve(Reflect.apply(value as Call, target, args)); } catch (err) { result = Promise.reject(err); }
        return result.catch((err: unknown) => { throw updating(err); });
      };
    },
  });
}

// Whether an error is the answer of a stale Ledger, as guardLedger gives it.
export function serverUpdating(err: unknown): boolean {
  return err instanceof RuleError ? err.code === "server_updating" : /^503\|server_updating\|/.test(err instanceof Error ? err.message : "");
}

// For tests only: forget which Ledgers this isolate has told.
export function forgetToldLedgers(): void {
  told.clear();
}
