import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatch, retainDispatch } from "./rules.ts";
import { readFile } from "node:fs/promises";

// Exercise the command with an in-memory API, without executing the CLI or
// touching an owner's config. Only its imported CLI services are replaced.
const commandSource = await readFile(new URL("../../cli/commands/dispatch.mjs", import.meta.url), "utf8");
async function command(args, before, dispatch) {
  const calls = [], lines = [];
  const services = { args, OWNER: "owner", I: () => "/items/t1", project: () => "test", itemArg: () => "t1",
    die: (message) => { throw new Error(message); },
    call: async (method, path, body) => {
      calls.push({ method, path, body });
      return method === "GET" ? { item: before } : { dispatch };
    },
    console: { log: (line) => lines.push(line) },
  };
  const source = commandSource.replace(/^import .*;$/gm, "").replace("export default async function", "return async function");
  const run = new Function(...Object.keys(services), source)(...Object.values(services));
  await run();
  return { calls, lines };
}

test("CLI hold release keeps the observed dispatch identity and skips suggestion, including partial and unrestricted builders", async () => {
  for (const override of [{}, { model: "other" }, { agent: "codex" }]) {
    const d = { ...makeDispatch({ to: "home", agent: "opencode", model: "glm-5.3-flash", job: "merge-main", head: "b".repeat(40), note: "keep" }, "owner", "2026-10-10T12:00:00Z"), ...override, overlapOk: true };
    const result = await command({ "overlap-ok": true, ...override }, { state: "open", owner: null, dispatch: d }, d);
    assert.deepEqual(result.calls.map(c => c.method), ["GET", "POST"]);
    const body = result.calls[1].body;
    assert.equal(body.retainAt, d.at);
    assert.equal(body.retain, true);
    assert.equal(body.suggest, undefined);
    assert.equal(body.agent, override.agent);
    assert.equal(body.model, override.model);
    assert.match(result.lines[0], new RegExp(`builder: ${d.agent}/${d.model}; job: merge-main`));
  }
  const d = { ...makeDispatch({}, "owner", "now"), overlapOk: true };
  const result = await command({ "overlap-ok": true }, { state: "open", owner: null, dispatch: d }, d);
  assert.match(result.lines[0], /builder: any agent and model; job: build/);
  assert.ok(result.lines.every(line => !line.includes("Warning")));
});

test("CLI overlap override uses normal redispatch for owned work and normal dispatch when none exists", async () => {
  const d = { ...makeDispatch({ agent: "codex", model: "gpt-6-astra" }, "owner", "now"), overlapOk: true };
  for (const before of [
    { state: "claimed", owner: "opencode/glm-5.3-flash", dispatch: d },
    { state: "claimed", owner: "opencode/glm-5.3-flash", dispatch: null },
    { state: "open", owner: null, dispatch: null },
  ]) {
    const { calls, lines } = await command({ "overlap-ok": true }, before, d);
    assert.equal(calls[1].body.retain, undefined);
    assert.equal(calls[1].body.retainAt, undefined);
    assert.equal(calls[1].body.suggest, true);
    assert.equal(calls[1].body.overlapOk, true);
    assert.ok(lines.every(line => !line.includes("released from the core-file hold")));
  }
});

test("hold release rejects a replaced dispatch before applying builder overrides", () => {
  const dispatch = makeDispatch({ agent: "opencode", model: "glm-5.3-flash" }, "owner", "2026-10-10T12:00:00Z");
  const item = { id: "t1", state: "open", owner: null, dispatch };
  const policy = { checks: [], protected: [] };
  assert.throws(() => retainDispatch(item, { retainAt: "2026-10-09T12:00:00Z", model: "other" }, [], policy), /dispatch has changed/);
  assert.equal(item.dispatch, dispatch);
  assert.deepEqual(retainDispatch(item, { retainAt: dispatch.at }, [], policy), { ...dispatch, overlapOk: true });
});
