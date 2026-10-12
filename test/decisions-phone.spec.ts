// Decisions at phone width (t545 review): /decisions without a task selects
// the first decision for the desktop's detail, but marks it `auto-selected`,
// so a phone shows the list (layout.css hides the list only under
// `has-selection`). Every row links to its own picked decision, whose back
// link returns to that list: from the list, every decision can be reached.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { signIn } from "./signin.ts";

const TOKEN = "decisions-phone-owner";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const NAME = "decisions-phone";
const A = "claude-code/opus-5.5";
const H0 = "0".repeat(40);

const page = async (path: string, cookie: string) => (await worker.fetch(new Request(`https://atelier.test${path}`, { headers: { cookie } }), testEnv)).text();

it("a phone reaches every decision from the list, and the list is what /decisions shows without a pick", async () => {
  const record = { name: NAME, repo: NAME, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await L(NAME).setProject(record, "owner");
  await I().registerProject(record);
  const titles = ["Accept the first", "Accept the second", "Accept the third"];
  for (const [i, title] of titles.entries()) {
    const id = `t${i + 1}`, head = String(i + 1).repeat(40);
    await L(NAME).newItem(title, ["src/**"], "owner");
    await L(NAME).claim(id, A);
    await L(NAME).setFork(id, `${NAME}--${id}`, H0, A);
    await L(NAME).recordPush(id, A, head, head);
    await L(NAME).addEvidence({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["src/a.ts"] });
    await L(NAME).submit(id, A);
  }
  const cookie = await signIn(TOKEN, testEnv);

  // No pick: the first decision is selected for the desktop, as an
  // auto-selection, with no back link; the list stays the phone's view.
  const list = await page("/decisions", cookie);
  expect(list).toContain('<div class="desk auto-selected">');
  expect(list).not.toContain('class="desk has-selection"');
  expect(list).not.toContain('class="review-back"');
  expect(list).toContain('<section class="review-sheet decision-detail"');
  const rows = [...list.matchAll(/class="decision-row(?: selected)?" href="(\/decisions\?project=decisions-phone&task=(t\d+)#review)"/g)];
  expect(rows.map((m) => m[2])).toEqual(["t1", "t2", "t3"]);

  // Each row opens its own decision, picked, with the way back to the list.
  for (const [i, [, path, id]] of rows.entries()) {
    const picked = await page(path.replaceAll("&amp;", "&"), cookie);
    expect(picked).toContain('<div class="desk has-selection">');
    expect(picked).toContain(`<h2 id="sel-h">${titles[i]}</h2>`);
    expect(picked).toContain(`<a class="decision-row selected" href="/decisions?project=${NAME}&task=${id}#review" aria-current="true">`);
    expect(picked).toContain('<a class="review-back" href="/decisions">');
  }
  // Back to the list: the same list, not the last pick.
  expect(await page("/decisions", cookie)).toContain('<div class="desk auto-selected">');
});
