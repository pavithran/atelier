// A live runner that offers the review jobs for the given models (t591: a
// review is requested only of a reviewer a live runner offers, and no
// recorded runner means none is offered). Tests that ask a review call this
// first, through the runner poll the server records offers from.
import type { Ledger } from "../../src/ledger.ts";

type Poller = { runnerPoll(token: never, offer: never): unknown };

export async function runnerOffers(L: Poller, models: string[], jobs = ["build", "review", "criteria-review"], runner = "home:test-reviews"): Promise<void> {
  const byAgent = new Map<string, string[]>();
  for (const m of models) {
    const [agent, id] = m.split("/");
    byAgent.set(agent, [...(byAgent.get(agent) ?? []), id]);
  }
  await L.runnerPoll({ id: `tok-${runner}`, runner } as never, { runner, kind: "home", jobs, agents: [...byAgent].map(([agent, ids]) => ({ agent, models: ids })) } as never);
}
