import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import type { ProjectPolicy } from "../src/rules.ts";
import { fingerprint } from "../src/secret-scan.ts";
import { renderItem } from "../src/ui.ts";

// t178: block, unblock, abandon and clear-secret on the developer's
// direction, as accept and fast mode take it (t629). The developer token
// with the developer's quoted words and the acting model does the action and
// records both on the event; the same token with a model acting and no words
// is stopped, naming the one command to run on the developer's yes; an
// agent's own token never carries the words; a project set up with
// --no-override is no different, since none of the four lowers a gate.

const TOKEN = "item-direction-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const AT = "2026-10-25T12:00:00.000Z";
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra";
const QUOTE = "yes, park it until the schema lands";
const H0 = "0".repeat(40), H1 = "a".repeat(40);
const FAKE_KEY = ["sk", "proj", "y".repeat(24)].join("-");
const policy: ProjectPolicy = { checks: [], protected: [] };

const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
async function project(name: string, over: Partial<ProjectPolicy> = {}) {
  const record = { name, repo: `${name}--baseline`, policy: { ...policy, ...over }, createdAt: AT };
  await ledger(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  for (const [harness, id] of [["claude-code", "opus-5.5"], ["codex", "gpt-6-astra"]]) {
    expect((await worker.fetch(new Request(`https://atelier.test/api/models/${id}`, {
      method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: JSON.stringify({ harness, where: "cloud" }),
    }), testEnv)).status).toBe(200);
  }
  return ledger(name);
}
const post = (name: string, id: string, verb: string, body: Record<string, unknown>, headers: Record<string, string> = {}, bearer = TOKEN, actor = "owner") =>
  worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${id}/${verb}`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "x-atelier-actor": actor, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }), testEnv);
const acting = { "x-atelier-acting": OPUS };
const events = async (L: ReturnType<typeof ledger>, kind: string) => (await L.events(undefined, 100) as unknown as LedgerEvent[]).filter((e) => e.kind === kind);
const agentToken = async (name: string) => (await (await worker.fetch(new Request("https://atelier.test/api/tokens", {
  method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: JSON.stringify({ actor: GPT, projects: [name] }),
}), testEnv)).json() as { token: string }).token;

it("block and unblock take the developer's words and the acting model, and record both on the event, the task and the receipt lines", async () => {
  const name = "dir-block";
  const L = await project(name);
  await L.newItem("Wire the keys", ["src/**"], "owner", { accept: ["Works"] });

  const blocked = await post(name, "t1", "block", { reason: "waiting on the schema", quote: QUOTE }, acting);
  expect(blocked.status).toBe(200);
  expect(await blocked.json()).toMatchObject({ state: "blocked", blocked: { by: "owner", reason: "waiting on the schema", quote: QUOTE, acting: OPUS } });
  expect((await events(L, "item.blocked"))[0]).toMatchObject({ actor: "owner", data: { confirmed: "direction", quote: QUOTE, acting: OPUS } });
  // The status line and the task page say the words where the block shows.
  const detail = await L.detail("t1");
  const html = renderItem(await L.project(), detail);
  expect(html).toContain(`the developer&#39;s words: “${QUOTE}”, relayed by ${OPUS}`);

  const lifted = await post(name, "t1", "unblock", { quote: "go on" }, acting);
  expect(lifted.status).toBe(200);
  expect((await events(L, "item.unblocked"))[0]).toMatchObject({ actor: "owner", data: { confirmed: "direction", quote: "go on", acting: OPUS } });
  expect(await L.item("t1")).not.toHaveProperty("blocked.quote");
});

it("the words need the acting model and the developer's own actor; blank words are refused", async () => {
  const name = "dir-refused";
  const L = await project(name);
  await L.newItem("Wire the keys", ["src/**"], "owner", { accept: ["Works"] });
  expect(await (await post(name, "t1", "block", { reason: "x", quote: QUOTE })).json()).toMatchObject({ error: "no_acting" });
  expect(await (await post(name, "t1", "block", { reason: "x", quote: "  " }, acting)).json()).toMatchObject({ error: "bad_quote" });
  expect(await (await post(name, "t1", "block", { reason: "x", quote: QUOTE }, acting, TOKEN, OPUS)).json()).toMatchObject({ error: "bad_quote" });
  expect(await L.item("t1")).toMatchObject({ state: "open" });
});

it("without the words a model on the developer token is stopped, and the stop names the one command to run", async () => {
  const name = "dir-stop";
  const L = await project(name);
  await L.newItem("Wire the keys", ["src/**"], "owner", { accept: ["Works"] });
  await L.newItem("Close me", ["src/**"], "owner", { accept: ["Works"] });

  const stop = async (res: Response) => {
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; detail: string };
    expect(body.error).toBe("direction_needed");
    return body.detail;
  };
  expect(await stop(await post(name, "t1", "block", { reason: "waiting on the schema", until: "2026-11-01" }, acting)))
    .toContain(`atelier block t1 "waiting on the schema" --until 2026-11-01 --quote "the developer's words" --as H/M --project ${name}`);
  expect(await stop(await post(name, "t2", "abandon", { note: "superseded", deliveredBy: "t1" }, acting)))
    .toContain(`atelier abandon t2 --note "superseded" --delivered-by t1 --quote "the developer's words" --as H/M --project ${name}`);
  expect(await stop(await post(name, "t1", "clear-secret", { reason: "a fake key" }, acting)))
    .toContain(`atelier clear-secret t1 --note "a fake key" --quote "the developer's words" --as H/M --project ${name}`);
  expect(await stop(await post(name, "t1", "unblock", {}, acting))).toContain(`atelier unblock t1 --quote`);
  expect(await L.item("t1")).toMatchObject({ state: "open" });
  expect(await L.item("t2")).toMatchObject({ state: "open" });

  // Block and unblock go out under the model's own actor, with no acting
  // header: they are stopped the same way, held or not.
  expect(await stop(await post(name, "t1", "block", { reason: "x" }, {}, TOKEN, OPUS))).toContain(`atelier block t1 "x" --quote`);
  expect(await stop(await post(name, "t1", "unblock", {}, {}, TOKEN, OPUS))).toContain(`atelier unblock t1 --quote`);
  expect(await L.item("t1")).toMatchObject({ state: "open" });

  // The developer's own call, with no model named, goes on as before.
  expect((await post(name, "t1", "block", { reason: "waiting on the schema" })).status).toBe(200);
  expect((await post(name, "t1", "unblock", {})).status).toBe(200);
  expect(await (await post(name, "t2", "abandon", { note: "by hand" })).json()).toMatchObject({ state: "abandoned" });
  expect((await events(L, "item.abandoned"))[0].data).not.toHaveProperty("quote");
});

it("abandon takes the developer's words and records them with the note on the event", async () => {
  const name = "dir-abandon";
  const L = await project(name);
  await L.newItem("Close me", ["src/**"], "owner", { accept: ["Works"] });
  const res = await post(name, "t1", "abandon", { note: "superseded", quote: "drop it", deliveredBy: undefined }, acting);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ state: "abandoned" });
  expect((await events(L, "item.abandoned"))[0]).toMatchObject({ actor: "owner", data: { note: "superseded", confirmed: "direction", quote: "drop it", acting: OPUS } });
});

it("clear-secret takes the developer's words and keeps them against each clearance and on the event", async () => {
  const name = "dir-secret";
  const L = await project(name);
  await L.newItem("Bring a secret in", ["src/**"], "owner");
  await L.claim("t1", OPUS);
  await L.setFork("t1", `${name}--t1`, H0, OPUS);
  await L.recordPush("t1", OPUS, H1, H1);
  const line = `const key = "${FAKE_KEY}";`;
  await L.setSecret("t1", "atelier/events", H1, [{ file: "src/keys.ts", line: 3, fingerprint: await fingerprint(line) }]);
  const res = await post(name, "t1", "clear-secret", { reason: "a fake key in a fixture", quote: "it is a fixture" }, acting);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ secretClearances: [{ reason: "a fake key in a fixture", by: "owner", quote: "it is a fixture", acting: OPUS }] });
  expect((await events(L, "secret.cleared"))[0]).toMatchObject({ actor: "owner", data: { confirmed: "direction", quote: "it is a fixture", acting: OPUS } });
});

it("an agent's own token cannot carry the words; the page's forms and --no-override projects are untouched", async () => {
  const name = "dir-token";
  const L = await project(name, { noOverride: true });
  await L.newItem("Wire the keys", ["src/**"], "owner", { accept: ["Works"] });
  await L.claim("t1", GPT);
  const agent = await agentToken(name);
  for (const verb of ["block", "unblock", "abandon", "clear-secret"]) {
    const res = await post(name, "t1", verb, { reason: "x", quote: QUOTE }, {}, agent, GPT);
    expect(res.status, verb).toBe(403);
  }
  expect(await L.item("t1")).toMatchObject({ state: "claimed" });
  // The holder's own token blocks and unblocks with no words, as before.
  expect((await post(name, "t1", "block", { reason: "waiting" }, {}, agent, GPT)).status).toBe(200);
  expect((await events(L, "item.blocked"))[0]).toMatchObject({ actor: GPT, proved: true });
  expect((await events(L, "item.blocked"))[0].data).not.toHaveProperty("quote");
  expect((await post(name, "t1", "unblock", {}, {}, agent, GPT)).status).toBe(200);

  // In a --no-override project the developer's words still direct the four,
  // and the call without them still stops: none of them overrides a review.
  expect((await post(name, "t1", "block", { reason: "x" }, acting)).status).toBe(403);
  expect((await post(name, "t1", "block", { reason: "x", quote: QUOTE }, acting)).status).toBe(200);
  // An agent's token cannot record a review under another actor.
  const review = await post(name, "t1", "review", { head: H1, approve: true, note: "fine" }, {}, agent, OPUS);
  expect(review.status).toBe(403);
});
