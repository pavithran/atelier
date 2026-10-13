import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDispatch, overrideDispatch, retainDispatch, assign, type Dispatch } from "../src/dispatch/rules.ts";
import type { ProjectPolicy } from "../src/rules.ts";

// Releasing a held dispatch (t447) changes only its overlap override.
const T = "2026-10-04T12:00:00.000Z";
const item = (over: Record<string, unknown> = {}) => ({
  id: "t1", title: "Work", scope: [], state: "open", owner: null, fork: null, base: null, head: null,
  acceptedHead: null, createdAt: T, updatedAt: T, lastPushAt: null, dispatch: null, ...over,
}) as never as { dispatch: ReturnType<typeof makeDispatch> };
const policy = { checks: [], protected: [] } as unknown as ProjectPolicy;

test("releasing a held dispatch keeps its builder, job, head, note and place, and changes only what is given", () => {
  const head = "b".repeat(40);
  const held = item({ dispatch: { ...makeDispatch({ to: "home", agent: "opencode", model: "glm-5.3-flash", note: "careful" }, "pavi", T), job: "merge-main", head, task: true } });
  const same = retainDispatch(held as never, {}, [], policy);
  assert.deepEqual(same, { ...held.dispatch, overlapOk: true });
  assert.equal(same.at, T);
  // Repeated release is idempotent.
  assert.deepEqual(retainDispatch(item({ dispatch: same }) as never, {}, [], policy), same);
  // A partial override replaces only the field given.
  const m = retainDispatch(held as never, { model: "qwen3-coder-next" }, [], policy);
  assert.deepEqual([m.agent, m.model, m.job, m.head, m.note], ["opencode", "qwen3-coder-next", "merge-main", head, "careful"]);
  const a = retainDispatch(held as never, { agent: "claude-code" }, [], policy);
  assert.deepEqual([a.agent, a.model], ["claude-code", "glm-5.3-flash"]);
  // An unrestricted dispatch stays unrestricted.
  const open = retainDispatch(item({ dispatch: makeDispatch({}, "pavi", T) }) as never, {}, [], policy);
  assert.deepEqual([open.agent, open.model, open.to], [null, null, "any"]);
  // An invalid resulting pair is refused.
  assert.throws(() => retainDispatch(held as never, { model: "bad model" }, [], policy), /not a valid model/);
});

test("releasing a hold refuses a task with no dispatch and one a runner has claimed", () => {
  assert.throws(() => retainDispatch(item() as never, {}, [], policy), /no dispatch to release/);
  const claimed = item({ state: "claimed", owner: "codex/gpt-6", dispatch: makeDispatch({}, "pavi", T) });
  assert.throws(() => retainDispatch(claimed as never, {}, [], policy), /held by codex\/gpt-6/);
});

// An overlap override sent as a dispatch edits the existing offer (t491).
const prior = makeDispatch({ to: "home", agent: "codex", model: "shared", note: "keep this" }, "owner", "before");
const cases = [
  [{}, "codex", "shared"],
  [{ agent: "" }, null, "shared"],
  [{ model: "" }, "codex", null],
  [{ agent: "", model: "" }, null, null],
  [{ agent: "other" }, "other", "shared"],
  [{ model: "new" }, "codex", "new"],
  [{ agent: "other", model: "new" }, "other", "new"],
] as const;
for (const [input, agent, model] of cases) {
  test(`override retains omitted fields and applies ${JSON.stringify(input)}`, () => {
    const d = overrideDispatch({ overlapOk: true, ...input }, prior, "owner", "after");
    assert.deepEqual(d, { ...prior, agent, model, overlapOk: true, at: "after" });
    for (const a of ["codex", "other"]) for (const m of ["shared", "new"]) {
      const result = assign(d, { runner: "home:test", kind: "home", agents: [{ agent: a, models: [m] }] });
      assert.equal(!!result, (!agent || a === agent) && (!model || m === model));
    }
  });
}

test("fresh dispatch and ordinary redispatch keep their defaults", () => {
  assert.deepEqual(overrideDispatch({}, prior, "owner", "now"), makeDispatch({}, "owner", "now"));
  assert.deepEqual(overrideDispatch({ overlapOk: true }, null, "owner", "now"), makeDispatch({ overlapOk: true }, "owner", "now"));
});

test("override preserves job payload and validates merged restrictions", () => {
  const job: Dispatch = { ...prior, job: "merge-main", head: "a".repeat(40), planHead: "b".repeat(40), part: "part", partId: "t3" };
  assert.deepEqual(overrideDispatch({ overlapOk: true, agent: "" }, job, "owner", "now"), { ...job, agent: null, overlapOk: true, at: "now" });
  assert.throws(() => overrideDispatch({ overlapOk: true, agent: "invalid agent" }, prior, "owner", "now"), /valid agent/);
  assert.throws(() => overrideDispatch({ overlapOk: true }, { ...job, head: "bad" }, "owner", "now"), /full commit hash/);
});

test("undefined override fields retain the full dispatch payload", () => {
  for (const job of ["plan", "review", "integrate", "refresh", "merge-main"] as const) {
    const previous: Dispatch = { ...prior, job, head: "a".repeat(40), part: "part", partId: "t3", planHead: "b".repeat(40) };
    const updated = overrideDispatch({ overlapOk: true, to: undefined, agent: undefined, model: undefined, note: undefined, job: undefined, head: undefined }, previous, "owner", "now");
    assert.deepEqual(updated, { ...previous, overlapOk: true, at: "now" });
  }
});

test("merged validation checks retained fields even when clearing another restriction", () => {
  assert.throws(() => overrideDispatch({ overlapOk: true, agent: "" }, { ...prior, model: "invalid model" }, "owner", "now"), /valid model/);
  assert.throws(() => overrideDispatch({ overlapOk: true, model: "" }, { ...prior, agent: "invalid agent" }, "owner", "now"), /valid agent/);
});

test("override replaces target and clears note without changing omitted restrictions or job payload", () => {
  const previous: Dispatch = { ...prior, job: "merge-main", head: "a".repeat(40), task: true };
  const updated = overrideDispatch({ overlapOk: true, to: "cloud", note: "" }, previous, "owner", "now");
  assert.deepEqual(updated, { ...previous, to: "cloud", note: "", overlapOk: true, at: "now" });
  const offer = { runner: "home:test", kind: "home" as const, agents: [{ agent: "codex", models: ["shared"] }], jobs: ["merge-main-task"] };
  assert.equal(assign(updated, offer), null);
  assert.equal(assign(updated, { ...offer, runner: "cloud:test", kind: "cloud" })?.actor, "codex/shared");
});

// Exercise the command handler with its HTTP and terminal boundaries injected;
// no CLI process or live service is needed. The command reads the item first
// when --overlap-ok comes alone (t447); `before` answers that read, and the
// dispatch request's body is the one recorded.
const source = readFileSync(new URL("../cli/commands/dispatch.mjs", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace("export default async function dispatchCommand", "return async function dispatchCommand");
const command = new Function("args", "project", "itemArg", "call", "I", "OWNER", "die", "console", source);
async function cli(args: Record<string, unknown>, response: unknown, before: unknown = { state: "open", owner: null, dispatch: null }) {
  const lines: string[] = [], requests: unknown[] = [];
  await command(args, () => "demo", () => "t2", async (method: string, _path: string, body: unknown) => {
    if (method === "GET") return { item: before };
    requests.push(body); return response;
  }, () => "/item", "owner", (s: string) => { throw Error(s); }, { log: (s: string) => lines.push(s) })();
  return { lines, body: JSON.parse(JSON.stringify(requests[0])) };
}
for (const [input, agent, model] of cases) {
  test(`CLI forwards explicit clears and omitted fields: ${JSON.stringify(input)}`, async () => {
    const r = await cli({ "overlap-ok": true, ...input }, { retainedDispatch: true, dispatch: { ...prior, agent, model, overlapOk: true } });
    assert.deepEqual(r.body, { ...input, overlapOk: true, ...(!("agent" in input) ? { suggest: true } : {}) });
    assert.equal(r.lines[0], "t2: overlap override recorded.");
    assert.equal(r.lines[1], `t2 is waiting for a home runner${agent ? `, ${agent}` : ""}${model ? ` with ${model}` : ""}.`);
    assert.ok(!r.lines.some(s => /Warning|released/.test(s)));
  });
}
test("CLI names only an actual released core hold", async () => {
  const r = await cli({ "overlap-ok": true, agent: "codex" }, { dispatch: { ...prior, overlapOk: true }, releasedCoreHold: { id: "t1", core: "src/**" } });
  assert.equal(r.lines[0], "t2: released core-file hold waiting on t1; both scopes reach core pattern src/**.");
  const fresh = await cli({}, { dispatch: prior, suggestion: { actor: "codex/shared", reasons: ["Available."] } });
  assert.equal(fresh.body.suggest, true);
  assert.equal(fresh.lines[0], "Builder: codex/shared. Available.");
});

test("CLI reports no released hold when refuseOverlap rejects the dispatch", async () => {
  const lines: string[] = [];
  await assert.rejects(command({ "overlap-ok": true }, () => "demo", () => "t2",
    async () => { throw Error("t2 overlaps live t1"); }, () => "/item", "owner",
    (s: string) => { throw Error(s); }, { log: (s: string) => lines.push(s) })(), /overlaps live t1/);
  assert.deepEqual(lines, []);
});

test("CLI reports only the override for a fresh dispatch without a core hold", async () => {
  const r = await cli({ "overlap-ok": true, agent: "" }, {
    dispatch: makeDispatch({ overlapOk: true }, "owner", "now"),
  });
  assert.deepEqual(r.body, { agent: "", overlapOk: true });
  assert.deepEqual(r.lines, ["t2: overlap override recorded.", "t2 is waiting for any runner."]);
});

test("CLI hold-only release forwards explicit clears and names the released hold before the kept builder", async () => {
  const waiting = { state: "open", owner: null, dispatch: { ...prior } };
  const r = await cli({ "overlap-ok": true, agent: "" }, { retainedDispatch: true, dispatch: { ...prior, agent: null, overlapOk: true }, releasedCoreHold: { id: "t1", core: "src/**" } }, waiting);
  assert.deepEqual(r.body, { agent: "", overlapOk: true, retain: true, retainAt: prior.at });
  assert.deepEqual(r.lines, [
    "t2: released core-file hold waiting on t1; both scopes reach core pattern src/**.",
    "t2 keeps its dispatch; builder: any agent / shared; job: build.",
    "t2 is waiting for a home runner with shared.",
  ]);
  const none = await cli({ "overlap-ok": true }, { retainedDispatch: true, dispatch: { ...prior, overlapOk: true } }, waiting);
  assert.equal(none.lines[0], "t2: overlap override recorded.");
  assert.ok(!none.lines.some(s => /released/.test(s)));
});

test("hold-only release clears a restriction given as an empty string and keeps the rest", () => {
  const T = "2026-10-04T12:00:00.000Z";
  const held = item({ dispatch: makeDispatch({ to: "home", agent: "codex", model: "shared", note: "keep" }, "pavi", T) });
  const a = retainDispatch(held as never, { agent: "" }, [], policy);
  assert.deepEqual([a.agent, a.model, a.to, a.note, a.at], [null, "shared", "home", "keep", T]);
  const m = retainDispatch(held as never, { model: "" }, [], policy);
  assert.deepEqual([m.agent, m.model], ["codex", null]);
  const both = retainDispatch(held as never, { agent: "", model: "" }, [], policy);
  assert.deepEqual([both.agent, both.model], [null, null]);
});
