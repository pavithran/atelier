import { test } from "node:test";
import assert from "node:assert/strict";
import { csp, decideRefresh, headsIn, LIVE_SCRIPT, newNonce, refreshShell } from "../src/live.ts";

const H1 = "a".repeat(40), H2 = "b".repeat(40);
const form = (head: string, verb = "accept") => `<form method="post" action="/ui/p/t1/${verb}"><input type="hidden" name="head" value="${head}"><button>Go</button></form>`;
const pageA = `<header><h2>Task</h2></header>${form(H1)}${form(H1, "reject")}<input type="text" name="note" value="">`;

test("the revisions a page's forms bind to are its hidden head inputs, in order", () => {
  assert.deepEqual(headsIn(pageA), [H1, H1]);
  assert.deepEqual(headsIn(`${form(H1)}${form(H2, "handoff")}`), [H1, H2]);
  assert.deepEqual(headsIn('<input name="head" type="hidden" value="x">'), ["x"], "attribute order does not matter");
  assert.deepEqual(headsIn('<input type="hidden" name="to" value="x"><input name="headline" value="y">'), [], "only inputs named head");
  assert.deepEqual(headsIn("<div class=\"flow\"></div>"), []);
});

test("a fetched copy is swapped, held or declared stale from the heads and the owner's hands", () => {
  // The same revisions, in whatever order the page draws them: swap when the
  // owner is free, hold while a field or control has their attention.
  assert.equal(decideRefresh([H1, H1], [H1, H1], false), "swap");
  assert.equal(decideRefresh([H1, H1], [H1, H1], true), "hold");
  assert.equal(decideRefresh([H2, H1], [H1, H2], false), "swap", "reordering the page does not move a revision");
  // Pages without decision forms, Flow among them, always may.
  assert.equal(decideRefresh([], [], false), "swap");
  // A push moved the head while the task stayed in review: stale, even mid-form.
  assert.equal(decideRefresh([H1, H1], [H2, H2], false), "stale");
  assert.equal(decideRefresh([H1, H1], [H2, H2], true), "stale", "the owner hears about it while typing");
  assert.equal(decideRefresh([H1], [H1, H2], false), "stale", "one form at a new revision is enough");
  // A form appeared where the page showed none (work was pushed): stale.
  assert.equal(decideRefresh([], [H1], false), "stale");
  // A form disappeared (the task was decided elsewhere): stale, not a quiet swap.
  assert.equal(decideRefresh([H1, H1], [], false), "stale");
  assert.equal(decideRefresh([H1, H1], [H1], false), "stale");
});

test("the script carries those two functions as they are, decides before it swaps, and says what to do", () => {
  // Whatever stripped the types left the signatures, spaced as it liked.
  assert.match(LIVE_SCRIPT, /function headsIn\(html\s*\)/, "headsIn is in the script");
  assert.match(LIVE_SCRIPT, /function decideRefresh\(current\s*,\s*fetched\s*,\s*dirty\s*\)/, "decideRefresh is in the script");
  assert.doesNotMatch(LIVE_SCRIPT, /: string|: boolean|: Refresh|RegExpExecArray/, "no type annotation survives into the script");
  // The copies in the script are valid JavaScript and decide as the originals do.
  const src = LIVE_SCRIPT.slice(0, LIVE_SCRIPT.indexOf("(() => {"));
  const copies = new Function(`${src}; return { headsIn, decideRefresh };`)() as { headsIn: typeof headsIn; decideRefresh: typeof decideRefresh };
  assert.deepEqual(copies.headsIn(pageA), [H1, H1]);
  assert.equal(copies.decideRefresh(headsIn(pageA), [H2], false), "stale");
  assert.equal(copies.decideRefresh(headsIn(pageA), [H1, H1], true), "hold");
  assert.equal(copies.decideRefresh(headsIn(pageA), [H1, H1], false), "swap");
  // The decision guards the swap, reads the last copy served and the page's own dirt, and is not skipped before the fetch.
  const decideAt = LIVE_SCRIPT.indexOf("decideRefresh(headsIn(last), headsIn(copy), dirty())");
  assert.ok(decideAt > -1 && decideAt < LIVE_SCRIPT.indexOf("swap(fresh);"));
  assert.ok(LIVE_SCRIPT.includes('if (what === "stale") { stale(); return; }'));
  assert.ok(LIVE_SCRIPT.includes('if (what === "hold") return;'));
  assert.ok(!LIVE_SCRIPT.includes("document.hidden || dirty()"), "a dirty page still fetches, so a new revision is not missed");
  // The refusal says a new revision arrived with a link that reloads, and refreshing stops.
  assert.ok(LIVE_SCRIPT.includes('"A new revision arrived. "'));
  assert.ok(LIVE_SCRIPT.includes('"Reload to review it"'));
  assert.ok(LIVE_SCRIPT.includes("a.href = window.location.href"));
  assert.ok(LIVE_SCRIPT.includes("clearInterval(ticker)"));
  // A fetched copy is compared with the last copy served, never with what the script has drawn.
  assert.ok(LIVE_SCRIPT.includes("var last = main.innerHTML;"));
  assert.ok(LIVE_SCRIPT.includes("if (copy === last) return;"));
  assert.ok(LIVE_SCRIPT.includes("last = copy;"));
  assert.ok(!LIVE_SCRIPT.includes("fresh.innerHTML !== main.innerHTML"));
});

// A stand-in for a parsed page: its parts marked data-shell, by key.
const doc = (parts: Record<string, string>) => {
  const nodes = Object.entries(parts).map(([key, html]) => ({ key, innerHTML: html, getAttribute: (n: string) => (n === "data-shell" ? key : null) }));
  return {
    nodes,
    querySelectorAll: (sel: string) => (sel === "[data-shell]" ? nodes : []),
    querySelector: (sel: string) => nodes.find((n) => sel === `[data-shell="${n.key}"]`) ?? null,
  };
};
const badge = (n: number) => ` <span class="badge"><span class="visually-hidden">, waiting on you: </span>${n}</span>`;

test("every copy fetched brings the bar's counts up to date, outside <main> (gate finding 1)", () => {
  // The Decisions badge, the switcher's list and the Tasks count follow the fetched copy.
  const page = doc({ waiting: badge(2), projects: '<a href="/home">All projects</a>', tasks: " (3)" });
  const fetched = doc({ waiting: badge(3), projects: '<a href="/home">All projects</a>', tasks: " (4)" });
  assert.equal(refreshShell(page, fetched), 2);
  assert.deepEqual(page.nodes.map((n) => n.innerHTML), [badge(3), '<a href="/home">All projects</a>', " (4)"]);
  // Nothing waiting any more: the badge goes, it does not stay at its old number.
  assert.equal(refreshShell(page, doc({ waiting: "", tasks: " (4)" })), 1);
  assert.equal(page.nodes[0].innerHTML, "");
  // A copy without a part (the bar could not be read) leaves the part as it is.
  assert.equal(refreshShell(page, doc({})), 0);
  assert.equal(page.nodes[2].innerHTML, " (4)");
  // The script carries it, valid as it is, and runs it on every copy fetched,
  // before the copy of <main> is compared, held or found stale.
  assert.match(LIVE_SCRIPT, /function refreshShell\(page\s*,\s*fetched\s*\)/);
  const src = LIVE_SCRIPT.slice(0, LIVE_SCRIPT.indexOf("(() => {"));
  const copy = new Function(`${src}; return refreshShell;`)() as typeof refreshShell;
  const again = doc({ waiting: badge(1) });
  assert.equal(copy(again, doc({ waiting: badge(5) })), 1);
  assert.equal(again.nodes[0].innerHTML, badge(5));
  const at = LIVE_SCRIPT.indexOf("refreshShell(document, doc);");
  assert.ok(at > -1);
  assert.ok(at < LIVE_SCRIPT.indexOf("if (copy === last) return;"), "an unchanged <main> still updates the counts");
  assert.ok(at < LIVE_SCRIPT.indexOf('if (what === "hold") return;'), "a held copy still updates the counts");
});

test("the policy admits only the fonts without a nonce, and only the nonced script with one", () => {
  const plain = csp();
  assert.ok(plain.startsWith("default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com"));
  assert.doesNotMatch(plain, /script-src|connect-src/);
  const nonced = csp("abc+/=");
  assert.ok(nonced.includes("script-src 'nonce-abc+/='; connect-src 'self';"));
  assert.ok(nonced.includes("font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'"));
  assert.doesNotMatch(nonced, /unsafe-inline'[^;]*script|'self'[^;]*script-src/);
});

test("a nonce is 24 characters of base64, and no two are alike", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const n = newNonce();
    assert.match(n, /^[A-Za-z0-9+/]{24}$/);
    seen.add(n);
  }
  assert.equal(seen.size, 50);
});
