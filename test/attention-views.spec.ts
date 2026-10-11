// Home, a project's Overview and the Decisions page against the fixed
// portfolio of test/fixtures/attention.ts: each says, per project, exactly the
// tasks the waiting rule places under the owner, in its order, once each, as
// `atelier status` and `atelier inbox` do in test/attention-views.test.mjs.
import { expect, it } from "vitest";
import { attentionFor } from "../src/attention";
import { buildStanding, renderHome, renderInbox, renderProject, type Detail } from "../src/ui";
import { readStanding, type StandingSource } from "../src/standing-read";
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
    // The fields older clients of /standing read stay beside the call.
    for (const w of s.waiting) expect([typeof w.kind, Array.isArray(w.kinds), w.reason]).toEqual(["string", true, w.why]);
    if (n === "alpha") expect(s.waiting.find((w) => w.call === "override")).toMatchObject({ id: "a14", kind: "assess", kinds: ["assess"] });
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

// A Ledger whose reads named in `fail` reject, as a Durable Object that cannot
// answer does; the others answer from the fixture.
function source(name: "alpha" | "beta", fail: string[]): StandingSource {
  const down = () => Promise.reject(new Error("unavailable"));
  const or = <T>(read: string, value: T) => (fail.includes(read) ? down() : Promise.resolve(value));
  return {
    project: () => Promise.resolve(record(name)),
    items: () => or("items", items[name]),
    inbox: () => or("inbox", ALL_ENTRIES),
    events: () => or("events", []),
    detail: () => down() as Promise<Detail>,
    sessions: () => or("sessions", []),
  };
}

it("the Overview and GET standing keep the owner calls already read when the notices cannot be read, and say so", async () => {
  const s = await readStanding(source("alpha", ["inbox", "sessions"]), OFFERS, [], 300, NOW);
  // What the tasks themselves show still waits on the owner, in the rule's order.
  const known = attentionFor("alpha", ALPHA_ITEMS, null, OFFERS, NOW).owner.map((t) => [t.id, t.call]);
  expect(s.waiting.map((w) => [w.id, w.call])).toEqual(known);
  expect(known).toEqual(expect.arrayContaining([["a10", "clear-secret"], ["a4", "unblock"]]));
  // What only a notice shows is not claimed as clear: the gap is labelled.
  expect(s.waiting.map((w) => w.id)).not.toContain("a1");
  expect(s.partial).toContain("The project's notices could not be read, so acceptance, plan decisions and protected actions there are not shown.");
  expect(s.partial).toContain("The last session's note could not be read.");
  const page = renderProject(record("alpha"), [], null, "PAVI", s, null);
  expect(page).toContain("Part of this record is not shown");
  expect(page).toContain("The project&#39;s notices could not be read");
  expect(page).toContain("The task board could not be read.");
  expect(page).toContain("The project's events could not be read.");
  expect(page).toContain("tasks waiting on you here");
});

it("the standing labels the tasks as not read when the task list cannot be read, rather than nothing waiting", async () => {
  const s = await readStanding(source("alpha", ["items"]), OFFERS, [], 300, NOW);
  expect(s.waiting).toEqual([]);
  expect(s.partial).toContain("The project's tasks could not be read, so what waits on you there is unknown.");
});

it("Home keeps a project's owner calls when its moves or notices cannot be read, and labels what was not", () => {
  const waiting = attentionFor("alpha", ALPHA_ITEMS, null, OFFERS, NOW);
  const home = renderHome([{ project: record("alpha"), items: ALPHA_ITEMS, eventsUnread: true, waiting }, { project: record("beta"), items: BETA_ITEMS, waiting: place("beta") }], "PAVI", NOW, "pavi");
  const alphaCard = home.slice(home.indexOf('href="/p/alpha"'), home.indexOf('href="/p/beta"'));
  expect(alphaCard).toContain(`<b>${waiting.owner.length}?</b>waiting on you`);
  expect(alphaCard).toContain("Its recent moves could not be read.");
  expect(alphaCard).toContain("The project&#39;s notices could not be read");
  expect(ids(alphaCard, /<li class="owner-call"><a href="\/p\/alpha\/(\w+)"/g)).toEqual(waiting.owner.slice(0, 3).map((t) => t.id));
  // The healthy project beside it is read in full.
  expect(home.slice(home.indexOf('href="/p/beta"'))).toContain("<b>0</b>waiting on you");
});
