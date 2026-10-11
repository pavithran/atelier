import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDispatch, retainDispatch, assign, type Dispatch } from "../src/dispatch/rules.ts";

const prior = makeDispatch({ to: "home", agent: "codex", model: "shared", note: "keep this" }, "owner", "before");
const cases = [
  [{}, "codex", "shared"],
  [{ agent: "" }, null, "shared"],
  [{ model: "" }, "codex", null],
  [{ agent: "", model: "" }, null, null],
  [{ agent: "other", model: "new" }, "other", "new"],
] as const;
for (const [input, agent, model] of cases) {
  test(`override retains omitted fields and applies ${JSON.stringify(input)}`, () => {
    const d = retainDispatch({ overlapOk: true, ...input }, prior, "owner", "after");
    assert.deepEqual(d, { ...prior, agent, model, overlapOk: true, at: "after" });
    for (const a of ["codex", "other"]) for (const m of ["shared", "new"]) {
      const result = assign(d, { runner: "home:test", kind: "home", agents: [{ agent: a, models: [m] }] });
      assert.equal(!!result, (!agent || a === agent) && (!model || m === model));
    }
  });
}

test("fresh dispatch and ordinary redispatch keep their defaults", () => {
  assert.deepEqual(retainDispatch({}, prior, "owner", "now"), makeDispatch({}, "owner", "now"));
  assert.deepEqual(retainDispatch({ overlapOk: true }, null, "owner", "now"), makeDispatch({ overlapOk: true }, "owner", "now"));
});

test("override preserves job payload and validates merged restrictions", () => {
  const job: Dispatch = { ...prior, job: "merge-main", head: "a".repeat(40), planHead: "b".repeat(40), part: "part", partId: "t3" };
  assert.deepEqual(retainDispatch({ overlapOk: true, agent: "" }, job, "owner", "now"), { ...job, agent: null, overlapOk: true, at: "now" });
  assert.throws(() => retainDispatch({ overlapOk: true, agent: "invalid agent" }, prior, "owner", "now"), /valid agent/);
  assert.throws(() => retainDispatch({ overlapOk: true }, { ...job, head: "bad" }, "owner", "now"), /full commit hash/);
});

// Exercise the command handler with its HTTP and terminal boundaries injected;
// no CLI process or live service is needed.
const source = readFileSync(new URL("../cli/commands/dispatch.mjs", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace("export default async function dispatchCommand", "return async function dispatchCommand");
const command = new Function("args", "project", "itemArg", "call", "I", "OWNER", "die", "console", source);
async function cli(args: Record<string, unknown>, response: unknown) {
  const lines: string[] = [], requests: unknown[] = [];
  await command(args, () => "demo", () => "t2", async (_method: string, _path: string, body: unknown) => { requests.push(body); return response; }, () => "/item", "owner", (s: string) => { throw Error(s); }, { log: (s: string) => lines.push(s) })();
  return { lines, body: JSON.parse(JSON.stringify(requests[0])) };
}
for (const [input, agent, model] of cases) {
  test(`CLI forwards explicit clears and omitted fields: ${JSON.stringify(input)}`, async () => {
    const r = await cli({ "overlap-ok": true, ...input }, { retainedDispatch: true, dispatch: { ...prior, agent, model, overlapOk: true } });
    assert.deepEqual(r.body, { ...input, overlapOk: true, ...(!("agent" in input) ? { suggest: true } : {}) });
    assert.equal(r.lines[0], "t2: overlap override recorded.");
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
