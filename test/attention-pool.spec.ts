// A protected change no reviewer in the pool qualifies for needs the owner's
// override (t504): the Home page, the Overview, the Decisions page and the
// standing route each read the Ledger's inbox with the model pool, so the
// task is placed under the owner, not left in review; once the pool offers a
// reviewer of another family, every view moves it back to review.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { signIn } from "./signin.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";

const TOKEN = "attention-pool-owner";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const NAME = "pool-placement";
const A = "claude-code/opus-5.5";
const H0 = "0".repeat(40), H1 = "a".repeat(40);

const api = (path: string) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
  headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner" },
}), testEnv);
const page = async (path: string, cookie: string) => (await worker.fetch(new Request(`https://atelier.test${path}`, { headers: { cookie } }), testEnv)).text();

type Waiting = { id: string; call: string; kind: string; kinds: string[]; reason: string; why: string };

it("a protected change with no qualifying reviewer waits on the owner in every view, and goes back to review once one qualifies", async () => {
  const record = { name: NAME, repo: NAME, policy: { checks: ["npm test"], protected: ["AGENTS.md"] }, createdAt: new Date().toISOString() };
  await L(NAME).setProject(record, "owner");
  await I().registerProject(record);
  await L(NAME).newItem("Touch a protected path", ["AGENTS.md"], "owner");
  await L(NAME).claim("t1", A);
  await L(NAME).setFork("t1", `${NAME}--t1`, H0, A);
  await L(NAME).recordPush("t1", A, H1, H1);
  await L(NAME).addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", head: H1, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["AGENTS.md"] });
  await L(NAME).submit("t1", A);
  const cookie = await signIn(TOKEN, testEnv);

  // Only the contributor's own family is in the pool: no reviewer qualifies.
  const T = new Date().toISOString();
  const model = (id: string, change: Partial<ModelEntry> = {}): ModelEntry => ({
    id, harness: "codex", where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: T, ...change,
  });
  await I().putModel(model("opus-5.5", { harness: "claude-code" }));

  const standing = async () => (await (await api(`/projects/${NAME}/standing`)).json()) as { waiting: Waiting[]; pipeline: { stage: string; count: number }[] };
  const none = await standing();
  expect(none.waiting.map((w) => [w.id, w.call])).toEqual([["t1", "override"]]);
  // The fields older clients read stay beside the call.
  expect(none.waiting[0]).toMatchObject({ kind: "assess", kinds: ["assess"] });
  expect(none.waiting[0].reason).toBe(none.waiting[0].why);
  const inbox = (await (await api("/inbox")).json()) as { project: string; itemId: string; kind: string; reviewer?: string | null }[];
  expect(inbox.filter((x) => x.project === NAME).map((x) => [x.itemId, x.kind, x.reviewer])).toEqual([["t1", "assess", null]]);

  const row = /<li class="owner-call"><a href="\/p\/pool-placement\/t1"><strong>Touch a protected path<\/strong><\/a><span class="tag[^"]*">No reviewer<\/span>/;
  const home = await page("/home", cookie);
  expect(home).toMatch(row);
  const overview = await page(`/p/${NAME}`, cookie);
  expect(overview.split('id="standing"')[1]).toContain("No reviewer");
  expect(overview).toContain("1 task waiting on you here");
  const decisions = await page(`/decisions?project=${NAME}&task=t1`, cookie);
  expect(decisions).toContain("No reviewer in the pool qualifies for this protected change");

  // A reviewer of another family joins the pool: the reviewers handle it.
  await I().putModel(model("gpt-6-astra"));
  const some = await standing();
  expect(some.waiting).toEqual([]);
  expect(some.pipeline).toEqual([{ stage: "submitted", count: 1 }]);
  expect(await page("/home", cookie)).not.toMatch(row);
  expect(await page(`/p/${NAME}`, cookie)).not.toContain("waiting on you here");
});
