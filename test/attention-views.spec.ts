// Home, a project's Overview and the Decisions page against the fixed
// portfolio of test/fixtures/attention.ts: each says, per project, exactly the
// tasks the waiting rule places under the owner, in its order, once each, as
// `atelier status` and `atelier inbox` do in test/attention-views.test.mjs.
import { expect, it } from "vitest";
import { attentionFor } from "../src/attention";
import { buildStanding, renderHome, renderInbox, renderProject } from "../src/ui";
import type { ProjectRecord } from "../src/ledger";
import { ALL_ENTRIES, ALPHA_ITEMS, BETA_ITEMS, EXPECTED, NOW, OFFERS } from "./fixtures/attention";

const record = (name: string): ProjectRecord => ({ name, title: name === "alpha" ? "Alpha" : "Beta", repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: NOW.toISOString() });
const items = { alpha: ALPHA_ITEMS, beta: BETA_ITEMS };
const place = (name: "alpha" | "beta") => attentionFor(name, items[name], ALL_ENTRIES, OFFERS, NOW);
const ownerIds = (name: "alpha" | "beta") => EXPECTED[name].owner.map(([id]) => id);
const ids = (html: string, re: RegExp) => [...html.matchAll(re)].map((m) => m[1]);

it("Home, the Overview and Decisions agree with the rule, per project, counting tasks", () => {
  // Home: the card's count and its first rows, in the rule's order.
  const home = renderHome((["alpha", "beta"] as const).map((n) => ({ project: record(n), items: items[n], waiting: place(n) })), "PAVI", NOW, "pavi");
  const alphaCard = home.slice(home.indexOf('href="/p/alpha"'), home.indexOf('href="/p/beta"'));
  const betaCard = home.slice(home.indexOf('href="/p/beta"'));
  expect(alphaCard).toContain(`<b>${ownerIds("alpha").length}</b>waiting on you`);
  expect(betaCard).toContain("<b>0</b>waiting on you");
  expect(ids(alphaCard, /<li class="owner-call"><a href="\/p\/alpha\/(\w+)"/g)).toEqual(ownerIds("alpha").slice(0, 3));
  expect(alphaCard).toContain(`and ${ownerIds("alpha").length - 3} more`);

  // The Overview of each project.
  for (const n of ["alpha", "beta"] as const) {
    const s = buildStanding(record(n), items[n], new Map(), 300, place(n), new Map(), NOW);
    expect(s.waiting.map((w) => [w.id, w.call])).toEqual(EXPECTED[n].owner);
    expect(s.overlaps).toEqual(EXPECTED[n].overlaps);
    expect(s.pipeline.reduce((k, x) => k + x.count, 0)).toBe(EXPECTED[n].pipeline.length);
    const page = renderProject(record(n), items[n], [], "PAVI", s);
    const sec = page.split('id="standing"')[1].split('<details class="disclosure')[0];
    if (EXPECTED[n].owner.length) expect(sec).toContain(`${EXPECTED[n].owner.length} tasks waiting on you here`);
    else expect(sec).not.toContain("waiting on you here");
    // Overlapping scopes never sit inline with what waits.
    expect(sec).not.toContain("overlap");
  }

  // Decisions: one row per task waiting, across projects, in the rule's order.
  const decisions = renderInbox([place("alpha"), place("beta")], [record("alpha"), record("beta")], "PAVI");
  expect(ids(decisions, /task=(\w+)#review"/g)).toEqual([...ownerIds("alpha"), ...ownerIds("beta")]);
  expect(decisions).toContain(`${ownerIds("alpha").length} tasks need your attention.`);
  // Each row says what to do and links where it is done.
  expect(decisions).toContain('<a href="/p/alpha/ship">Open Ship</a>');
  expect(decisions).toContain("Start a runner that offers codex/gpt-9 on a home runner, or send the task elsewhere.");
  expect(decisions.split('<details class="disclosure overlaps">')[0]).not.toContain("a2 and a3");
  expect(decisions).toContain("1 pair of tasks with overlapping scopes</summary>");
});
