import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRigs, DIAL_CAUTION, DIAL_FAULT, rigsBody, yardOf } from "../src/rigs.ts";
import { MACHINE_STALE_MS, type MachineReading } from "../src/runners/machine.ts";
import type { TodayInputs } from "../src/today.ts";

// The pure half of Rigs (t608): buildRigs and rigsBody over runner offers alone. The page through
// worker.fetch is test/rigs.spec.ts; these call the same functions the route calls (src/index.ts).

const NOW = new Date("2026-11-09T18:00:00.000Z");
const inputs: TodayInputs = { projects: [], unread: [], owner: "owner" };
const offer = (runner: string, extra: Record<string, unknown> = {}, at = NOW.getTime() - 20_000) =>
  ({ runner, kind: "home" as const, agents: [{ agent: "claude-code", models: ["sonnet-5.5"] }], at: new Date(at).toISOString(), ...extra });
const reading = (change: Partial<MachineReading> = {}): MachineReading => ({ host: "ai-studio-256", cpus: 10, loadavg: [1, 1, 1], memFreePercent: 40, testSlots: { capacity: 3, inUse: 1 }, ...change });
const head = (r: Partial<MachineReading> | null, at = NOW.getTime() - 20_000) => {
  const view = buildRigs(inputs, [offer("home:studio-atelier-build", r ? { machine: reading(r) } : {}, at)], NOW);
  return { view, html: rigsBody(view) };
};
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

test("criterion 1: yards are ordered Studio, mini, MacBook, then other machines by name, one per machine", () => {
  const runners = ["home:rack7-build", "cloud:atelier", "home:macbook-atelier-build", "home:mini-atelier-build", "home:studio-atelier-build", "home:studio-atelier-review", "home:abacus-build"];
  const view = buildRigs(inputs, runners.map((r) => offer(r)), NOW);
  assert.deepEqual(view.yards.map((y) => y.title), ["Mac Studio", "Mac mini", "MacBook Pro", "abacus", "cloud:atelier", "rack7"]);
  assert.deepEqual(view.yards[0].tracks.map((t) => t.name), ["atelier-build", "atelier-review"]);
  assert.deepEqual(yardOf("home:studio-miqra-build"), { key: "studio", title: "Mac Studio", rank: 0, track: "miqra-build" });
  // A runner that is not live (silent past the offer window) has no yard.
  assert.equal(buildRigs(inputs, [offer("home:mini-x", {}, NOW.getTime() - 3 * 3_600_000)], NOW).yards.length, 0);
});

test("criterion 4: the dial is caution over 60% and fault over 90% of the cores, by the 1-minute load", () => {
  const dial = (load: number) => head({ cpus: 10, loadavg: [load, load, load] }).view.yards[0].head!.dial;
  assert.equal(DIAL_CAUTION, 0.6);
  assert.equal(DIAL_FAULT, 0.9);
  assert.deepEqual([0, 5.9, 6, 6.1, 9, 9.1, 25].map(dial), ["ok", "ok", "ok", "warm", "warm", "hot", "hot"]);
  // The 15-minute load does not move it.
  assert.equal(head({ cpus: 10, loadavg: [1, 1, 20] }).view.yards[0].head!.dial, "ok");
  const warm = head({ cpus: 10, loadavg: [7, 1, 1] }).html;
  assert.match(warm, /<svg class="gauge warm" data-dial="warm"/);
  assert.match(head({ cpus: 10, loadavg: [9.5, 1, 1] }).html, /<svg class="gauge hot" data-dial="hot"/);
  assert.match(head({ cpus: 10, loadavg: [1, 1, 1] }).html, /<svg class="gauge " data-dial="ok"/);
});

test("criterion 4: the 15-minute load is in words, with memory used and test slots used of capacity", () => {
  const { html } = head({ cpus: 36, loadavg: [18.33, 16.2, 15.1], memFreePercent: 34, testSlots: { capacity: 3, inUse: 1 } });
  const words = text(html);
  assert.match(words, /load, 1 min · over 15 minutes the load averaged 15\.1 on 36 cores, light/);
  assert.match(words, /18\.3 \/ 36/);
  assert.match(words, /memory 66% used/);
  assert.match(words, /test slots 1 of 3/);
  assert.equal([...html.matchAll(/<i class="on"><\/i>/g)].length, 1);
  assert.equal([...html.matchAll(/<div class="plats"[^>]*>(.*?)<\/div>/g)][0][1].match(/<i/g)!.length, 3);
  assert.match(text(head({ cpus: 10, loadavg: [1, 1, 7] }).html), /averaged 7 on 10 cores, busy/);
  assert.match(text(head({ cpus: 10, loadavg: [1, 1, 9.5] }).html), /averaged 9\.5 on 10 cores, overloaded/);
  assert.match(text(head({ testSlots: null }).html), /no test pool on this machine/);
});

test("criterion 4: a stale reading shows 'no reading' and no dial", () => {
  const stale = head({}, NOW.getTime() - MACHINE_STALE_MS - 1000);
  assert.equal(stale.view.yards[0].head!.dial, "none");
  assert.match(text(stale.html), /no reading/);
  assert.doesNotMatch(stale.html, /<svg class="gauge/);
  assert.doesNotMatch(text(stale.html), /test slots|memory/);
  // The same reading a moment inside the limit is drawn.
  assert.match(head({}, NOW.getTime() - MACHINE_STALE_MS + 1000).html, /<svg class="gauge/);
});

test("criterion 4: a machine whose runners sent no reading shows 'no reading' and no dial", () => {
  const none = head(null);
  assert.equal(none.view.yards[0].head!.dial, "none");
  assert.match(text(none.html), /no reading/);
  assert.doesNotMatch(none.html, /<svg class="gauge/);
});

test("the offers could not be read: the page says so and draws no yard", () => {
  const html = rigsBody(buildRigs(inputs, null, NOW));
  assert.match(text(html), /could not be read/);
  assert.doesNotMatch(html, /class="yard"/);
  assert.match(text(rigsBody(buildRigs(inputs, [], NOW))), /No runner is live\./);
});

// Criterion 9: nothing moves under prefers-reduced-motion. The rules that animate or transition sit only inside the
// no-preference query (src/rigs.css); the browser check is in test/rigs.spec.ts.
test("criterion 9: src/rigs.css animates and transitions only inside prefers-reduced-motion: no-preference", () => {
  const css = readFileSync(new URL("../src/rigs.css", import.meta.url), "utf8");
  const open = css.indexOf("@media (prefers-reduced-motion: no-preference) {");
  assert.ok(open > -1);
  let depth = 0, end = open;
  for (let i = css.indexOf("{", open); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  const outside = css.slice(0, open) + css.slice(end);
  assert.doesNotMatch(outside, /\banimation\b|\btransition\b|@keyframes/);
  assert.match(css.slice(open, end), /animation: rigs-breathe[^;]*infinite/);
  assert.match(css.slice(open, end), /transition: left/);
  assert.doesNotMatch(css, /-gradient\(/);
});
