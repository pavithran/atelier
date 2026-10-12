// t537: a claim whose claiming runner stopped polling holds no other
// dispatch. Its runner's last poll (as /api/runners records it) older than
// the stuck report's runnerPollMinutes, with OFFER_REFRESH_MS of coarsening,
// orphans the claim: the core-file hold passes it by, atelier queue's held:
// line names it orphaned with the recovery, and atelier stuck lists it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { coreHold, coreOrphans, holdGraph, holdText, makeDispatch, OFFER_REFRESH_MS, orphanedBy, orphanText, type RunnerPolls } from "../src/dispatch/rules.ts";
import { REPORT_DEFAULTS, reportLimits, stuckReport } from "../src/stuck/report.ts";
import type { Item } from "../src/rules.ts";

const LIMIT = REPORT_DEFAULTS.runnerPollMinutes * 60_000;
const CLAIMED = "2026-10-10T20:51:00.000Z";
const NOW = Date.parse("2026-10-12T01:51:00.000Z"); // about 29 hours later
const iso = (ms: number) => new Date(ms).toISOString();
const item = (id: string, over: Partial<Item> = {}): Item => ({
  id, title: id, scope: ["src/dispatch/rules.ts"], state: "open", owner: null, fork: null, base: null, head: null,
  acceptedHead: null, createdAt: CLAIMED, updatedAt: CLAIMED, lastPushAt: null, dispatch: makeDispatch({}, "owner", CLAIMED), ...over,
});
const claim = (runner: string | null) => item("t463", { state: "claimed", owner: "opencode/glm-5.3-flash", runner });
const polls = (at: string, runner = "home:studio-5"): RunnerPolls => ({ polls: [{ runner, at }], limitMs: LIMIT });
const core = ["src/dispatch/rules.ts"];

test("a runner gone past the limit orphans its claim, which holds nothing", () => {
  const waiting = item("t358"), held = claim("home:studio-5");
  const edge = iso(NOW - LIMIT - OFFER_REFRESH_MS);
  // At the limit, timestamp coarsening included, the claim still holds.
  assert.equal(orphanedBy(held, polls(edge), NOW), null);
  assert.equal(coreHold(waiting, [held], core, null, NOW, polls(edge))?.id, "t463");
  // A millisecond past it, the runner is gone.
  const gone = iso(NOW - LIMIT - OFFER_REFRESH_MS - 1);
  assert.deepEqual(orphanedBy(held, polls(gone), NOW), { runner: "home:studio-5", lastPoll: gone });
  assert.equal(coreHold(waiting, [held], core, null, NOW, polls(gone)), null);
  assert.deepEqual(coreOrphans(waiting, [held], core, null, NOW, polls(gone)).map((o) => [o.id, o.runner, o.lastPoll, o.core]), [["t463", "home:studio-5", gone, core[0]]]);
  assert.deepEqual(holdGraph([waiting, held], core, null, NOW, polls(gone)).get("t358"), []);
  // Runner names compare without case, as claims do.
  assert.equal(coreHold(waiting, [held], core, null, NOW, polls(gone, "home:Studio-5")), null);
});

test("a runner that resumes polling restores the hold", () => {
  const waiting = item("t396"), held = claim("home:studio-5");
  assert.equal(coreHold(waiting, [held], core, null, NOW, polls(CLAIMED)), null);
  const back = polls(iso(NOW - 30_000));
  assert.equal(coreHold(waiting, [held], core, null, NOW, back)?.id, "t463");
  assert.deepEqual(coreOrphans(waiting, [held], core, null, NOW, back), []);
  // Of several records for one runner, the newest poll counts.
  const both: RunnerPolls = { polls: [{ runner: "home:studio-5", at: CLAIMED }, { runner: "home:studio-5", at: iso(NOW - 30_000) }], limitMs: LIMIT };
  assert.equal(coreHold(waiting, [held], core, null, NOW, both)?.id, "t463");
});

test("a claim with no runner, or a runner no poll records, keeps its hold", () => {
  const waiting = item("t478");
  const byHand = claim(null);
  assert.equal(coreHold(waiting, [byHand], core, null, NOW, polls(CLAIMED))?.id, "t463");
  assert.equal(coreHold(waiting, [{ ...byHand, runner: undefined }], core, null, NOW, polls(CLAIMED))?.id, "t463");
  // Unknown never proves a runner gone: no record of it, or no polls read.
  assert.equal(coreHold(waiting, [claim("home:studio-5")], core, null, NOW, polls(CLAIMED, "home:other"))?.id, "t463");
  assert.equal(coreHold(waiting, [claim("home:studio-5")], core, null, NOW, null)?.id, "t463");
  assert.equal(coreHold(waiting, [claim("home:studio-5")], core, null, NOW)?.id, "t463");
  // The holder of a live landing lease holds whatever its runner does.
  const lease = { item: "t463", holder: "owner", at: iso(NOW - 1000) };
  assert.equal(coreHold(waiting, [claim("home:studio-5")], core, lease, NOW, polls(CLAIMED))?.id, "t463");
});

test("the t463 case: the runner stopped after claiming, and six dispatches wait no longer", () => {
  const held = claim("home:studio-5");
  const waiting = ["t358", "t396", "t478", "t487", "t523", "t389"].map((id) => item(id));
  const runners = polls(CLAIMED);
  for (const w of waiting) {
    assert.equal(coreHold(w, [held, ...waiting], core, null, NOW, runners), null, w.id);
    const orphaned = coreOrphans(w, [held, ...waiting], core, null, NOW, runners);
    assert.deepEqual(orphaned.map((o) => o.id), ["t463"]);
    const line = orphanText(orphaned);
    assert.match(line, /^t463 \(claimed by opencode\/glm-5\.3-flash\) is orphaned, not a blocker: its runner home:studio-5 last polled at 2026-10-10 20:51 UTC/);
    assert.match(line, /recover it with atelier dispatch t463$/);
  }
  // Beside a live blocker, the hold's own text names the orphan as such.
  const live = item("t500", { state: "claimed", owner: "codex/gpt-6", runner: "home:studio-1" });
  const fresh: RunnerPolls = { polls: [{ runner: "home:studio-5", at: CLAIMED }, { runner: "home:studio-1", at: iso(NOW - 1000) }], limitMs: LIMIT };
  const hold = coreHold(waiting[0], [held, live], core, null, NOW, fresh)!;
  assert.equal(hold.id, "t500");
  const text = holdText({ ...hold, orphaned: coreOrphans(waiting[0], [held, live], core, null, NOW, fresh) });
  assert.match(text, /^waits on t500 \(claimed by codex\/gpt-6\)/);
  assert.match(text, /t463 \(claimed by opencode\/glm-5\.3-flash\) is orphaned, not a blocker/);
  assert.doesNotMatch(text, /waits on t463/);
});

const observed = new Date(NOW);
const snapshot = (items: Item[]) => ({ items, events: [], lease: null, workflows: [], reviews: [], coreFiles: core });
const offer = (runner: string, at: string) => ({ runner, kind: "home" as const, agents: [], at });

test("atelier stuck lists the orphaned claim with its runner, last poll and atelier dispatch ID", () => {
  const held = { ...claim("home:studio-5"), dispatch: makeDispatch({ to: "home", agent: "opencode", model: "glm-5.3-flash" }, "owner", CLAIMED) };
  const waiting = [item("t358"), item("t396")];
  const r = stuckReport("atelier", "https://example.org", observed, reportLimits(), snapshot([held, ...waiting]), [offer("home:studio-5", CLAIMED)], [], ["home:studio-5"]);
  const orphan = r.entries.filter((e) => e.kind === "orphaned-claim");
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0].subject, "t463");
  assert.equal(orphan[0].since, CLAIMED);
  assert.equal(orphan[0].reason, `claim by opencode/glm-5.3-flash orphaned by its runner home:studio-5, which last polled at ${CLAIMED}; it no longer holds t358, t396`);
  assert.match(orphan[0].recovery, /^atelier dispatch t463 --to home --agent opencode --model glm-5\.3-flash/);
  assert.match(orphan[0].recovery, /--project "atelier"$/);
  assert.equal(orphan[0].evidence, "https://example.org/api/runners");
  // The orphaned claim holds nothing, so no core hold is reported against it.
  assert.deepEqual(r.entries.filter((e) => e.kind === "core-hold"), []);
  // The runner back: no orphan. A claim by hand: none either.
  const back = stuckReport("atelier", "https://example.org", observed, reportLimits(), snapshot([held, ...waiting]), [offer("home:studio-5", iso(NOW - 1000))], [], ["home:studio-5"]);
  assert.deepEqual(back.entries.filter((e) => e.kind === "orphaned-claim"), []);
  const byHand = stuckReport("atelier", "https://example.org", observed, reportLimits(), snapshot([claim(null), ...waiting]), [offer("home:studio-5", CLAIMED)], [], []);
  assert.deepEqual(byHand.entries.filter((e) => e.kind === "orphaned-claim"), []);
  // The limit is the report's runnerPollMinutes.
  const wide = stuckReport("atelier", "https://example.org", observed, reportLimits({ runnerPollMinutes: 30 * 60 }), snapshot([held]), [offer("home:studio-5", CLAIMED)], [], []);
  assert.deepEqual(wide.entries.filter((e) => e.kind === "orphaned-claim"), []);
});

// atelier queue prints the orphan on the held: line, with or without a live blocker.
test("atelier queue's held: line says the claim is orphaned instead of naming it as a blocker", (t) => {
  const root = mkdtempSync(join(process.cwd(), ".orphaned-claim-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const orphaned = coreOrphans(item("t358"), [claim("home:studio-5")], core, null, NOW, polls(CLAIMED));
  const queued = [{ project: "atelier", item: { ...item("t358"), title: "Waiting work", orphaned } }];
  const preload = join(root, "server.mjs");
  writeFileSync(preload, `globalThis.fetch = async (url) => {
    if (new URL(url).pathname === "/api/queue") return Response.json(${JSON.stringify(queued)});
    throw new Error("unexpected route: " + url);
  };`);
  const r = spawnSync(process.execPath, ["--import", preload, resolve("cli/atelier.mjs"), "queue"], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, ATELIER_ACTOR: "owner", ATELIER_CONFIG_DIR: root, ATELIER_CACHE: root, ATELIER_TOKEN: "fake", ATELIER_SERVER: "https://fake.invalid" },
  });
  assert.equal(r.status, 0, r.stderr);
  const held = r.stdout.split("\n").filter((l) => l.startsWith("  held: "));
  assert.equal(held.length, 1, r.stdout);
  assert.match(held[0], /^ {2}held: t463 \(claimed by opencode\/glm-5\.3-flash\) is orphaned, not a blocker: its runner home:studio-5 last polled at 2026-10-10 20:51 UTC, so its claim on core file src\/dispatch\/rules\.ts holds nothing; recover it with atelier dispatch t463$/);
  assert.doesNotMatch(held[0], /waits on/);
});
