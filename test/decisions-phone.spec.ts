// Decisions at phone width (t545 review, moved by t562): the list a phone
// starts from is Today's Needs you section, and /decisions redirects to it.
// Every card links to its own task page: from the list, every decision can be
// reached.
import { env } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { signIn } from "./signin.ts";

const TOKEN = "decisions-phone-owner";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const NAME = "decisions-phone";
const A = "claude-code/opus-5.5";
const H0 = "0".repeat(40);

const get = (path: string, cookie: string) => worker.fetch(new Request(`https://atelier.test${path}`, { headers: { cookie }, redirect: "manual" }), testEnv);

it("a phone reaches every decision from the list, and Today is the list and /decisions leads to it", async () => {
  const record = { name: NAME, repo: NAME, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await L(NAME).setProject(record, "owner");
  await I().registerProject(record);
  const titles = ["Accept the first", "Accept the second", "Accept the third"];
  for (const [i, title] of titles.entries()) {
    const id = `t${i + 1}`, head = String(i + 1).repeat(40);
    await L(NAME).newItem(title, ["src/**"], "owner");
    await L(NAME).claim(id, A);
    await L(NAME).setWorkspace(id, `${NAME}--${id}`, H0, A);
    await L(NAME).recordPush(id, A, head, head);
    await L(NAME).addEvidence({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["src/a.ts"] });
    await L(NAME).submit(id, A);
  }
  const cookie = await signIn(TOKEN, testEnv);

  // The bare Decisions address redirects to Today, whose Needs you section is the list.
  const bare = await get("/decisions", cookie);
  expect([bare.status, bare.headers.get("location")]).toEqual([302, "/"]);
  const list = await (await get("/", cookie)).text();
  const needs = list.split('id="needs-you"')[1].split("</section>")[0];
  const rows = [...needs.matchAll(/<a class="today-title" href="(\/p\/decisions-phone\/(t\d+))">([^<]*)<\/a>/g)];
  expect(rows.map((m) => m[2]).sort()).toEqual(["t1", "t2", "t3"]);
  expect(rows.map((m) => m[3]).sort()).toEqual([...titles].sort());

  // Each card opens its own task page, and the old picked address leads to the same page.
  for (const [, path, id, title] of rows) {
    const picked = await (await get(path, cookie)).text();
    expect(picked).toContain(title);
    const old = await get(`/decisions?project=${NAME}&task=${id}`, cookie);
    expect([old.status, old.headers.get("location")]).toEqual([302, path]);
  }
});
