// A live review runner every test ledger and test server has by default
// (t591). A review is requested only of a reviewer a live runner offers, and
// no recorded runner means none is offered, so a fixture that asks a review
// without registering a runner would be refused (no_runner). This runner
// (one home, one cloud) offers the review and criteria-review jobs, and no build job, for the
// models the fixtures name. It joins the offers every Ledger reads, those the
// index records and those a project ledger holds; a runner of the same name
// that a test records replaces it. A suite that needs none offered (the
// tests of t591's own refusals) calls withoutDefaultRunner() before it asks.
import { Ledger } from "../../src/ledger.ts";
import type { SeenOffer } from "../../src/dispatch/rules.ts";

export const DEFAULT_RUNNER = "home:default-reviews", DEFAULT_CLOUD_RUNNER = "cloud:default-reviews";
const MODELS: Record<string, string[]> = {
  "claude-code": ["opus-5.5", "sonnet-5.5", "sonnet-5", "fable-5.1", "haiku-4.5", "claude-opus-5.5", "claude-sonnet-5.5"],
  codex: ["gpt-6", "gpt-6-astra", "gpt-6-astra:b", "gpt-6.1-sol", "other", "shared"],
  zcode: ["glm-5.3", "glm-judge-9"],
  opencode: ["glm-9", "glm-alias", "glm-5.3", "glm-5.3-flash", "qwen3-coder-next", "qwen-alias", "gemini-3.1-pro", "outside"],
  antigravity: ["gemini-4-argon", "gemini-3.1-pro", "claude-opus-5-5", "claude-opus-5.5", "claude-sonnet-5.5"],
};

let off = false;
export function withoutDefaultRunner(): void { off = true; }

// Only while fn runs, for one step of a test whose assertion counts every
// runner that offers a reviewer.
export async function withoutDefaultRunnerDuring<T>(fn: () => Promise<T>): Promise<T> {
  const was = off;
  off = true;
  try { return await fn(); } finally { off = was; }
}

// The models offered are the named ones and those in the pool the ledger
// holds, so a fixture's own pool is offered whatever it names.
const offer = (pool: { harness: string; id: string; aliases?: string[] }[]): SeenOffer[] => {
  const models = new Map(Object.entries(MODELS).map(([agent, list]) => [agent, new Set(list)]));
  for (const m of pool) {
    const set = models.get(m.harness) ?? new Set<string>();
    for (const id of [m.id, ...(m.aliases ?? [])]) set.add(id);
    models.set(m.harness, set);
  }
  const agents = [...models].map(([agent, set]) => ({ agent, models: [...set] }));
  return [DEFAULT_RUNNER, DEFAULT_CLOUD_RUNNER].map((runner) => ({ runner, kind: runner === DEFAULT_RUNNER ? "home" : "cloud", jobs: ["review", "criteria-review"], agents, at: new Date().toISOString() }) as SeenOffer);
};
const poolOf = (ledger: unknown): { harness: string; id: string; aliases?: string[] }[] => {
  const l = ledger as { poolStanding?: () => never[]; models?: () => never[] };
  try { return (l.poolStanding?.() ?? []) as never[]; } catch { return []; }
};
const withDefault = (ledger: unknown, offers: SeenOffer[]): SeenOffer[] => off || offers.some((o) => o.runner === DEFAULT_RUNNER) ? offers : [...offers, ...offer(poolOf(ledger))];

type Reading = { heldOffers?: () => SeenOffer[]; runnerOffers: () => SeenOffer[] };
const proto = Ledger.prototype as unknown as Reading;
if (!(proto as { defaultRunner?: boolean }).defaultRunner) {
  (proto as { defaultRunner?: boolean }).defaultRunner = true;
  for (const name of ["heldOffers", "runnerOffers"] as const) {
    const read = proto[name] as (this: unknown) => SeenOffer[];
    (proto as unknown as Record<string, unknown>)[name] = function (this: unknown) { return withDefault(this, read.call(this)); };
  }
}
