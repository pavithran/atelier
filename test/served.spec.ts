import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import type { ModelReliability } from "../src/models/reliability.ts";
import type { ServedMatch } from "../src/models/served.ts";
import { signIn } from "./signin.ts";

// t95: the owner records which model served events recorded under another,
// through the Worker's own fetch handler and the Ledger's real SQLite. The
// annotated events never change; the record and the pages count them under
// the served model.

const TOKEN = "served-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const ZCODE = "zcode/glm-5.3", OPUS = "claude-code/opus-5.5";
const [H0, H1] = ["0", "1"].map((c) => c.repeat(40));
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

function call(method: string, path: string, actor: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

type Answer = { project: string; served: string; recorded: string; from: string; to: string; items: string[] | null; matched: ServedMatch[]; pending: number; annotated: number; applied: boolean };

it("the owner annotates the served model of matching events; a dry run writes nothing, a second run nothing twice, and the events never change", async () => {
  const name = "served-a";
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  // zcode holds t1 and pushes; opus holds t2 and zcode reviews it.
  await L(name).newItem("Served by another model", ["docs/**"], "owner");
  await L(name).newItem("Reviewed by it", ["docs/**"], "owner");
  await L(name).claim("t1", ZCODE);
  await L(name).setFork("t1", `${name}--t1`, H0, ZCODE);
  await L(name).recordPush("t1", ZCODE, H1, H1);
  await L(name).claim("t2", OPUS);
  await L(name).setFork("t2", `${name}--t2`, H0, OPUS);
  await L(name).recordPush("t2", OPUS, H1, H1);
  await L(name).addReview({ itemId: "t2", criteria: await L(name).criteria("t2"), by: ZCODE, head: H1, approve: true, note: "fine", at: new Date().toISOString() });
  const before = (await L(name).events(undefined, 100)) as unknown as LedgerEvent[];
  const zcodes = before.filter((e) => e.actor === ZCODE).map((e) => e.seq).sort((a, b) => a - b);
  expect(zcodes.length).toBe(4);
  const window = { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 3_600_000).toISOString() };
  const body = { served: "deepseek-flash", recorded: "zcode/GLM-5.3", ...window, note: "per model_usage" };

  expect((await call("POST", `/projects/${name}/served`, OPUS, body)).status).toBe(403);
  expect((await call("POST", `/projects/${name}/served`, "owner", { ...body, from: "soon" })).status).toBe(400);
  const dry = await call("POST", `/projects/${name}/served`, "owner", body);
  expect(dry.status).toBe(200);
  const preview = (await dry.json()) as Answer;
  expect(preview).toMatchObject({ project: name, served: "deepseek-flash", recorded: "zcode/GLM-5.3", items: null, pending: 4, annotated: 0, applied: false });
  expect(preview.matched.map((m) => m.seq)).toEqual(zcodes);
  expect(((await L(name).events(undefined, 100)) as unknown as LedgerEvent[]).length).toBe(before.length);

  const only = (await (await call("POST", `/projects/${name}/served`, "owner", { ...body, items: ["t2"] })).json()) as Answer;
  expect(only.matched.map((m) => [m.itemId, m.kind])).toEqual([["t2", "review.approved"]]);

  const applied = (await (await call("POST", `/projects/${name}/served`, "owner", { ...body, apply: true })).json()) as Answer;
  expect([applied.annotated, applied.applied]).toEqual([4, true]);
  const after = (await L(name).events(undefined, 100)) as unknown as LedgerEvent[];
  const notes = after.filter((e) => e.kind === "event.served");
  expect(notes.map((e) => [e.data.seq, e.actor, e.itemId]).sort()).toEqual(
    zcodes.map((seq) => [seq, "owner", before.find((e) => e.seq === seq)!.itemId]).sort());
  expect(notes[0].data).toMatchObject({ recorded: ZCODE, served: "deepseek-flash", note: "per model_usage" });
  // Every event recorded before is still there, exactly as it was.
  expect(after.filter((e) => e.kind !== "event.served")).toEqual(before);
  const again = (await (await call("POST", `/projects/${name}/served`, "owner", { ...body, apply: true })).json()) as Answer;
  expect([again.matched.length, again.pending, again.annotated]).toEqual([4, 0, 0]);
  expect(again.matched.every((m) => m.served === "deepseek-flash")).toBe(true);

  // The reliability record, the Models page and the Flow page count the work under deepseek-flash.
  const { models } = (await (await call("GET", "/reliability", "owner")).json()) as { models: ModelReliability[] };
  const flash = models.find((m) => m.model === "deepseek-flash")!;
  expect(flash.actors).toEqual(["zcode/deepseek-flash"]);
  expect(flash.approvals).toBe(1);
  expect(models.some((m) => m.model === "glm-5.3")).toBe(false);
  await call("PUT", "/models/deepseek-flash", "owner", { harness: "zcode", where: "cloud" });
  const cookie = await signIn(TOKEN, testEnv);
  const page = await (await worker.fetch(new Request("https://atelier.test/models", { headers: { cookie } }), testEnv)).text();
  expect(page).toContain("<code>deepseek-flash</code>");
  expect(page).toContain("Took 1 task");
  const flow = await (await worker.fetch(new Request("https://atelier.test/flow", { headers: { cookie } }), testEnv)).text();
  expect(flow).toContain("deepseek-flash");
});
