import { test } from "node:test";
import assert from "node:assert/strict";
import { csp, decideRefresh, headsIn, LIVE_SCRIPT, newNonce } from "../src/live.ts";

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
