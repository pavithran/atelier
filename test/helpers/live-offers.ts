import { runInDurableObject } from "cloudflare:test";
import type { SeenOffer } from "../../src/dispatch/rules.ts";
import type { ModelEntry } from "../../src/models/pool.ts";

// A live home runner that offers every model of `pool` for the review job,
// for a test of the automatic reviewer choice, which names only a model a
// live runner offers (t225).
export function liveOffersFor(pool: readonly Pick<ModelEntry, "harness" | "id">[]): SeenOffer[] {
  const agents = [...new Set(pool.map((m) => m.harness))].map((agent) => ({ agent, models: pool.filter((m) => m.harness === agent).map((m) => m.id) }));
  return [{ runner: "home:test", kind: "home", agents, jobs: ["build", "review"], at: new Date().toISOString() }];
}

// The same offer as a project's Ledger holds it, as a runner's poll leaves it.
export async function holdLiveOffers(ledger: { fetch(request: Request): Promise<Response> } | unknown, pool: readonly Pick<ModelEntry, "harness" | "id">[]): Promise<void> {
  await runInDurableObject(ledger as never, async (_instance: unknown, state: DurableObjectState) => {
    state.storage.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('runner-offer:test', ?)`, JSON.stringify(liveOffersFor(pool)[0]));
  });
}
