import { expect, it } from "vitest";
import layout from "../src/layout.css";
import { buildStory, type Story } from "../src/graph.ts";
import { buildImported } from "../src/import/history.ts";
import { foldMoves, renderShowcase, type ShownProject } from "../src/ui.ts";

// The public showcase as the d29 canvas draws it (t544, Main.dc.html): the
// hero, the comparison, the tally with its window and evidence key, the
// portfolio, one task, seven counted steps, the moves feed with a glyph per
// kind and repeats folded, where it runs, and the privacy note. Every figure
// is read from the seeded stories.

const at = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, d, h, m)).toISOString();
const ev = (seq: number, when: string, actor: string, kind: string, itemId: string, data: Record<string, unknown> = {}) => ({ seq, at: when, actor, kind, itemId, data });

function seeded(): { built: Story; idle: Story; anon: Story } {
  const evs = [
    ev(1, at(4, 9), "pavi", "item.created", "t1"),
    ev(2, at(4, 9), "pavi", "item.created", "t2"),
    ev(3, at(4, 10), "codex/gpt-6-astra", "item.claimed", "t1"),
    ev(4, at(4, 10, 5), "codex/gpt-6-astra", "push.observed", "t1", { head: "a".repeat(40) }),
    ev(5, at(4, 10, 6), "atelier/sandbox", "evidence.observed", "t1", { passed: false, where: "sandbox", claim: "npm test" }),
    ev(6, at(4, 10, 8), "atelier/runner", "evidence.observed", "t1", { passed: true, claim: "npm test" }),
    ev(7, at(4, 10, 9), "codex/gpt-6-astra", "item.submitted", "t1", { head: "a".repeat(40) }),
    ev(8, at(4, 11), "claude-code/opus-5.5", "review.rejected", "t1", { note: "private note" }),
    ev(9, at(4, 11, 30), "claude-code/opus-5.5", "review.approved", "t1"),
    ev(10, at(4, 12), "pavi", "item.accepted", "t1", { head: "a".repeat(40) }),
    ev(11, at(4, 12, 1), "pavi", "item.merged", "t1", { mergeCommit: "b".repeat(40) }),
    // The same move six times in ten minutes folds to one row.
    ...[0, 2, 4, 6, 8, 10].map((m, i) => ev(12 + i, at(5, 8, m), "zcode/glm-5.3", "item.claimed", "t2")),
  ].reverse();
  const items = [{ id: "t1", title: "Publish main", state: "merged" }, { id: "t2", title: "Tidy", state: "claimed" }] as never;
  const built = buildStory("built", items, evs as never, "pavi", false, "Built", { redact: true, ownerLabel: "PAVI" });
  const idle = buildStory("idle", [], [], "pavi", false, "Idle", { redact: true, ownerLabel: "PAVI" });
  const anon = buildStory("secret-name", [{ id: "t1", title: "Secret task title", state: "claimed" }] as never,
    [ev(2, at(3, 9, 1), "codex/gpt-6-astra", "item.claimed", "t1"), ev(1, at(3, 9), "pavi", "item.created", "t1")] as never,
    "pavi", false, "an iOS app", { redact: true, ownerLabel: "PAVI", anon: true });
  return { built, idle, anon };
}

const card = (s: Story, mode: "named" | "anonymous" = "named", allTimeMerged?: number): ShownProject =>
  ({ project: { name: s.project, repo: s.project, policy: { checks: [], protected: [] }, createdAt: "" }, mode, story: s, ...(allTimeMerged === undefined ? {} : { allTimeMerged }) });

function page(): string {
  const { built, idle, anon } = seeded();
  return renderShowcase([built, idle, anon], built.tally, "pavi", "PAVI", false, new Map(), [card(built, "named", 12), card(idle), card(anon, "anonymous")]);
}
const section = (html: string, id: string) => html.split(`id="${id}"`)[1].split("</section>")[0];

it("folds an acceptance into its merge, and a repeated move into one row that says how many and how long", () => {
  const m = (when: string, kind: string, text: string, item = "t1", project = "P") => ({ at: when, kind, text, item, project });
  const rows = foldMoves([
    m(at(4, 12), "item.accepted", "PAVI accepted t1"),
    m(at(4, 12, 1), "item.merged", "t1 merged into main as bbbbbbbb"),
    ...[0, 2, 4, 6, 8, 10].map((min) => m(at(5, 8, min), "item.claimed", "glm-5.3 took t2", "t2")),
    m(at(5, 8, 3), "item.claimed", "glm-5.3 took t2", "t2", "Other"),
  ]);
  expect(rows.map((r) => [r.project, r.text, r.times])).toEqual([
    ["P", "glm-5.3 took t2", 4],                    // 08:10 back to 08:04
    ["Other", "glm-5.3 took t2", 1],                // 08:03, another project, breaks the run
    ["P", "glm-5.3 took t2", 2],                    // 08:02 and 08:00
    ["P", "PAVI accepted t1; merged into main as bbbbbbbb", 1],
  ]);
  expect([rows[0].at, rows[0].since]).toEqual([at(5, 8, 10), at(5, 8, 4)]);
  expect(rows[3].kind).toBe("item.merged");
  expect(foldMoves([m(at(1, 1), "item.claimed", "a took t1"), m(at(1, 2), "item.claimed", "b took t1")], 1)).toHaveLength(1);
});

it("draws the canvas's sections in its order, every figure from the seeded tally", () => {
  const html = page();
  const order = ['id="top"', 'id="tally-h"', 'id="portfolio-h"', 'id="story-h"', 'id="travels-h"', 'id="moves-h"', 'id="where-h"', 'class="show-foot"'].map((m) => html.indexOf(m));
  expect(order.every((i) => i > 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // The tally: the headline, its window and four figures.
  const tally = section(html, "tally-h");
  expect(tally).toContain(">PAVI made 1 decision. 3 agents did the other 12 moves.</h2>");
  expect(tally).toContain('<p class="show-window">3 Oct to 5 Oct</p>');
  expect(tally).toContain("<div><dt>agent moves</dt><dd>12</dd></div>");
  expect(tally).toContain('<div class="you"><dt>PAVI&#39;s decisions</dt><dd>1</dd></div>');
  expect(tally).toContain('<div class="cloud"><dt>checks run on a clean copy, 1 in Cloudflare</dt><dd>2</dd></div>');
  expect(tally).toContain('<div class="catch"><dt>times a model sent work back</dt><dd>1</dd></div>');
  expect(tally).toContain('<span class="grade observed">Observed</span>counts');
  expect(tally).toContain('<span class="grade reported">Reported</span>shown, not counted');
  expect(tally).toContain('<span class="grade pending">Pending</span>not yet run');
  // The seven steps, each counted.
  const steps = [...section(html, "travels-h").matchAll(/<h3>(\w+)<\/h3><p>[^<]*<\/p><span class="travel-count[^"]*">([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]);
  expect(steps).toEqual([["Planned", "3 planned"], ["Claimed", "8 claims, 0 handoffs"], ["Worked", "1 push"], ["Checked", "2 observed, 1 in Cloudflare"], ["Reviewed", "1 approved, 1 sent back"], ["Decided", "1 accepted"], ["Merged", "1 merged"]]);
});

it("draws a card per shown project, an idle one dashed, and an anonymised one by its kind alone", () => {
  const html = page();
  const cards = section(html, "portfolio-h");
  const built = cards.split('id="card-1"')[1].split("</li>\n")[0];
  expect(built).toContain("<h3>Built</h3>");
  expect(built).toContain("<dt>merged, last two weeks</dt><dd>1</dd>");
  expect(built).toContain("<dt>merged, all time</dt><dd>12</dd>");
  expect(built).toContain("<dt>sent back, last two weeks</dt><dd>1</dd>");
  expect(built).toContain("<dt>in progress, last two weeks</dt><dd>1</dd>");
  expect(built).toMatch(/<i style="--c:var\(--m-anthropic\)"><\/i>Claude<\/li><li><i style="--c:var\(--m-openai\)"><\/i>GPT<\/li><li><i style="--c:var\(--m-zai\)"><\/i>GLM<\/li><li><i style="--c:var\(--m-owner\)"><\/i>PAVI<\/li>/);
  expect(cards).toContain('<li class="show-card idle" id="card-2"><h3>Idle</h3><p class="idle-note">No agent has worked here yet.</p></li>');
  expect(cards).toContain("<h3>An iOS app</h3>");
  for (const secret of ["secret-name", "Secret task title", "private note"]) expect(html, secret).not.toContain(secret);
});

it("tells one task as it happened, and the latest moves with a glyph per kind and no family colour", () => {
  const html = page();
  expect(section(html, "story-h")).toContain('<p class="show-window">t1 · Publish main · Built</p>');
  expect(section(html, "story-h")).toContain('class="graph');
  const moves = section(html, "moves-h");
  expect(moves).not.toContain("--m-");
  expect(moves).toContain('<p class="show-window">times in UTC</p>');
  expect(moves).toContain('<span class="glyph " aria-hidden="true">□</span><time datetime="2026-10-05T08:10:00.000Z">10/05 08:10</time><p><span class="meta">Built · </span>glm-5.3 took t2 <span class="fold">×6 in 10 min</span></p>');
  expect(moves).toContain('<span class="glyph merge" aria-hidden="true">●</span>');
  expect(moves).toContain("PAVI accepted t1; merged into main as bbbbbbbb");
  expect(moves).toContain('<span class="glyph catch" aria-hidden="true">▽</span>');
  expect(moves).toContain("A check on t1 failed in a Cloudflare container");
  expect(moves).toContain('<span class="glyph " aria-hidden="true">◇</span>');
  expect(moves).toContain('<span class="meta">An iOS app · </span>gpt-6-astra took t1');
});

it("compares a project known only from git with the record Atelier kept, as two articles", () => {
  const { built, idle } = seeded();
  const h = buildImported([{ hash: "a", committedAt: 100, message: "x\n\nAgent: codex/gpt-6" }, { hash: "b", committedAt: 200, message: "y" }], null, true);
  const html = renderShowcase([built, idle], built.tally, "pavi", "PAVI", false, new Map([["idle", h]]));
  const compare = html.split('aria-labelledby="compare-h"')[1].split("</section>")[0];
  expect(html.indexOf('id="compare-h"')).toBeLessThan(html.indexOf('id="tally-h"'));
  expect(compare).toContain(">Git keeps what a commit claims. Atelier keeps what happened.</h2>");
  expect(compare).toContain('<p class="compare-kicker"><span>Before Atelier · from git</span><span>Idle</span></p>');
  expect(compare).toContain("<b>50%</b><span>of commits name an agent. Nothing else about them is recorded.</span>");
  expect(compare).toContain('<div class="none"><dt>—</dt><dd>reviews by another model</dd></div>');
  expect(compare).toContain('<p class="compare-kicker"><span>With Atelier · observed</span><span>Built</span></p>');
  expect(compare).toContain("<b>50%</b><span>of reviews sent the work back: 1 of 2.</span>");
  expect(compare).toContain("<div><dt>2</dt><dd>checks run on a clean copy of the exact revision</dd></div>");
  expect(compare).not.toContain("<a ");
  // Without imported history there is nothing to compare.
  expect(page()).not.toContain('id="compare-h"');
});

it("keeps every touch target 44 px, stacks at phone width and never scrolls sideways", () => {
  expect(layout).toMatch(/\.public-bar nav a \{[^}]*min-height: 44px/);
  expect(layout).toMatch(/\.show-foot-links a \{[^}]*min-height: 44px/);
  // Every grid falls to one column inside the phone's width.
  for (const rule of [".compare {", ".show-cards {", ".show-tally {"]) expect(layout.split(rule)[1].split("}")[0]).toContain("minmax(min(100%,");
  const phone = layout.slice(layout.indexOf(".show-foot-links a {"));
  expect(phone).toMatch(/@media \(max-width: 720px\) \{[\s\S]*\.runs-on > div \{ grid-template-columns: 1fr;/);
  expect(layout).toMatch(/\.feed p \{[^}]*overflow-wrap: anywhere/);
  expect(layout).toMatch(/\.show-story \.stage-scroll \{ overflow-x: auto; \}/);
});
