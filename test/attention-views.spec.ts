// Home, a project's Overview and the Decisions page against the fixed
// portfolio of test/fixtures/attention.ts: each says, per project, exactly the
// tasks the waiting rule places under the owner, in its order, once each, as
// `atelier status` and `atelier inbox` do in test/attention-views.test.mjs.
import { expect, it } from "vitest";
import { attentionFor } from "../src/attention";
import { buildStanding, renderHome, renderInbox, renderProject, type Detail } from "../src/ui";
import { readStanding, type StandingSource } from "../src/standing-read";
import type { ProjectRecord } from "../src/ledger";
import { buildStory } from "../src/graph";
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
    expect(sec).toContain(`<h2 id="wait-h">Waiting on you · ${EXPECTED[n].owner.length}</h2>`);
    expect(ids(sec, /<li><a class="row-id" href="\/p\/\w+\/(\w+)">/g).slice(0, Math.min(5, EXPECTED[n].owner.length))).toEqual(EXPECTED[n].owner.slice(0, 5).map(([id]) => id));
    // Overlapping scopes never sit inline with what waits.
    expect(sec).not.toContain("overlap");
  }

  // Decisions: one row per task waiting, across projects, in the rule's order.
  const decisions = renderInbox([place("alpha"), place("beta")], [record("alpha"), record("beta")], "PAVI");
  expect(ids(decisions, /task=(\w+)#review"/g)).toEqual([...ownerIds("alpha"), ...ownerIds("beta")]);
  expect(decisions).toContain(`Decisions · ${ownerIds("alpha").length + ownerIds("beta").length}</h1>`);
  expect(decisions).toContain(`Alpha · ${ownerIds("alpha").length}</h2>`);
  // Each row says what to do; the selected task's detail links where it is done.
  expect(decisions).toContain("Run the protected actions its merge declared: a dry run first, then approve and ship.");
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
  expect(page).toContain(`Waiting on you · ${known.length}`);
});

it("the standing labels the tasks as not read when the task list cannot be read, rather than nothing waiting", async () => {
  const s = await readStanding(source("alpha", ["items"]), OFFERS, [], 300, NOW);
  expect(s.waiting).toEqual([]);
  expect(s.partial).toContain("The project's tasks could not be read, so what waits on you there is unknown.");
  const page = renderProject(record("alpha"), [], null, "PAVI", s, null);
  expect(page).toContain("The project&#39;s tasks could not be read");
  // No count is drawn from tasks that were not read.
  expect(page).not.toContain('class="state-grid"');
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

it("Decisions never says the owner is clear when tasks or notices could not be read", async () => {
  for (const failed of ["items", "inbox"]) {
    const L = source("beta", [failed]);
    const [tasks, notices] = await Promise.all([L.items().catch(() => null), L.inbox(NOW.toISOString(), []).catch(() => null)]);
    const a = attentionFor("beta", tasks, notices, OFFERS, NOW);
    const page = renderInbox([a], [record("beta")], "PAVI");
    expect(page).toContain("Nothing is known to be waiting on you; more may be waiting.");
    expect(page).toContain("The list may be incomplete.");
    expect(page).toContain(failed === "items" ? "tasks could not be read" : "notices could not be read");
    expect(page).not.toContain("You’re clear.");
    expect(page).not.toContain("Nothing is waiting on you.");
  }
});

// Found in pre-review of t504: with no owner task known, the resting panel
// beside the list said "Nothing is waiting on you." while the list said it
// may be incomplete. Both now say the same.
it("Decisions' resting panel says the list may be incomplete, naming the project, when its records were not all read", () => {
  const at = (seq: number, actor: string, kind: string) => ({ seq, itemId: "b1", at: `2026-10-04T10:0${seq}:00.000Z`, actor, kind, data: {} });
  const story = buildStory("beta", [{ ...BETA_ITEMS[0], id: "b1", state: "merged" }], [at(2, "pavi", "item.merged"), at(1, "codex/gpt-6", "item.claimed")], "pavi");
  expect(story.threads.length).toBe(1);
  const unread = renderInbox([attentionFor("beta", null, null, OFFERS, NOW)], [record("beta")], "PAVI", undefined, [], [], { story, owner: "pavi" });
  const panel = unread.slice(unread.indexOf('class="resting-graph"'));
  expect(unread).toContain("The list may be incomplete.");
  expect(panel).toContain("The list may be incomplete: some records of Beta could not be read, so more may be waiting on you.");
  expect(unread).not.toContain("Nothing is waiting on you.");
  // Read in full and with nothing waiting, it says so.
  const read = renderInbox([attentionFor("beta", [], [], OFFERS, NOW)], [record("beta")], "PAVI", undefined, [], [], { story, owner: "pavi" });
  expect(read.slice(read.indexOf('class="resting-graph"'))).toContain("Nothing is waiting on you.");
  expect(read).not.toContain("may be incomplete");
});

// The tier review of t546 (codex/gpt-6-astra at 2393474a): a board that
// failed to read was drawn as an empty one, "0 tasks", "Running · 0" and
// "Nobody is working", and a standing whose tasks failed as "Nothing waits on
// you here" and "None pending". Not read is said as not read; read and empty
// still says empty.
const overviewOf = (page: string) => page.split('id="standing"')[1].split('<details class="disclosure')[0];
const emptyClaims = ["Nothing waits on you here", "None pending", "Nobody is working", "Nothing merged yet"];

it("the Overview says what it could not read as not read, with no zero counts and no empty-state claims", async () => {
  const s = await readStanding(source("alpha", ["items", "inbox"]), OFFERS, [], 300, NOW);
  expect(s.unread).toEqual(["tasks", "notices"]);
  const page = renderProject(record("alpha"), null, null, "PAVI", s, null);
  const sec = overviewOf(page);
  expect(sec).toContain("What waits on you here could not be read.");
  expect(sec).toContain("Who is working could not be read.");
  expect(sec).toContain("The merges could not be read.");
  expect(sec).toContain("The ship requests could not be read.");
  for (const claim of emptyClaims) expect(sec).not.toContain(claim);
  expect(sec).not.toMatch(/· 0\b|\b0 tasks?\b|\b0 waiting/);
  expect(sec).toContain('<h2 id="wait-h">Waiting on you</h2>');
  expect(sec).toContain('<h2 id="run-h">Running</h2>');
  // The record under the fold counts nothing from the tasks it did not read.
  expect(page).not.toContain("0 tasks queued");
  expect(page).toContain("Atelier's record: its tasks could not be read");
});

it("the Overview whose board alone failed says who is working as not read, and keeps what the standing read", async () => {
  const s = await readStanding(source("alpha", []), OFFERS, [], 300, NOW);
  const sec = overviewOf(renderProject(record("alpha"), null, [], "PAVI", s, null));
  expect(sec).toContain("Who is working could not be read.");
  expect(sec).not.toContain("Nobody is working");
  expect(sec).not.toMatch(/\b0 tasks?\b|Running · /);
  expect(sec).toContain(`Waiting on you · ${s.waiting.length}`);
});

it("the Overview of a project read in full and empty still says it is empty", async () => {
  const empty: StandingSource = {
    project: () => Promise.resolve(record("alpha")),
    items: () => Promise.resolve([]),
    inbox: () => Promise.resolve([]),
    events: () => Promise.resolve([]),
    detail: () => Promise.reject(new Error("none")),
    sessions: () => Promise.resolve([]),
  };
  const s = await readStanding(empty, OFFERS, [], 300, NOW);
  expect(s.unread).toBeUndefined();
  const page = renderProject(record("alpha"), [], [], "PAVI", s, { items: [] } as never, []);
  const sec = overviewOf(page);
  for (const claim of emptyClaims) expect(sec).toContain(claim);
  expect(sec).toContain("Waiting on you · 0");
  expect(sec).toContain("Running · 0");
  expect(sec).toContain("0 tasks");
  expect(sec).not.toContain("could not be read");
  expect(page).toContain("0 tasks queued");
});

// t60. Finding it would have caught: accepted work held while main moved went
// unmentioned until merge time (ikon-weblog, 2026-10-16).
it("GET standing carries where accepted work stands against main only when asked, and says when that could not be read", async () => {
  const held = [{ id: "a1", title: "Held", acceptedHead: "a".repeat(40), main: "b".repeat(40), state: "behind" as const }];
  const without = await readStanding(source("alpha", []), OFFERS, [], 300, NOW);
  expect("accepted" in without).toBe(false);
  const withHeld = await readStanding(source("alpha", []), OFFERS, [], 300, NOW, () => Promise.resolve(held));
  expect(withHeld.accepted).toEqual(held);
  const none = await readStanding(source("alpha", []), OFFERS, [], 300, NOW, () => Promise.resolve([]));
  expect("accepted" in none).toBe(false);
  const failed = await readStanding(source("alpha", []), OFFERS, [], 300, NOW, () => Promise.reject(new Error("unavailable")));
  expect("accepted" in failed).toBe(false);
  expect(failed.partial).toContain("Whether accepted work is behind main could not be read.");
});
