import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let serial = 0;
async function handler(file, mocks) {
  const key = `taskSize${serial++}`;
  globalThis[key] = mocks;
  const url = new URL(`../cli/commands/${file}.mjs`, import.meta.url);
  const source = readFileSync(url, "utf8").replace(/from "([^"]+)"/g, (_, path) => {
    if (!mocks[path]) return `from "${new URL(path, url).href}"`;
    const body = Object.keys(mocks[path]).map((name) => name === "default"
      ? `export default globalThis.${key}[${JSON.stringify(path)}].default;`
      : `export const ${name} = globalThis.${key}[${JSON.stringify(path)}].${name};`).join("\n");
    return `from "data:text/javascript,${encodeURIComponent(body)}"`;
  });
  try { return (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default; }
  finally { delete globalThis[key]; }
}

test("new warns once above five criteria and still creates the task", async (t) => {
  const warnings = [];
  t.mock.method(console, "error", (line) => warnings.push(line));
  t.mock.method(console, "log", () => {});
  for (const count of [5, 6, 9]) {
    warnings.length = 0;
    let created = 0;
    const run = await handler("new", { "../atelier.mjs": {
      OWNER: "owner", P: () => "/project", actor: async () => "owner",
      args: { _: ["new", "Small task"], "duplicate-ok": true },
      call: async () => { created++; return { id: "t1", title: "Small task", scope: [] }; },
      die: (message) => { throw Error(message); }, fieldsArg: () => ({ accept: Array(count).fill("criterion") }),
      flat: String, formatFields: () => [], listArg: () => [], pointToGuide: () => {}, project: () => "demo",
    } });
    await run();
    assert.equal(created, 1);
    assert.equal(warnings.length, count > 5 ? 1 : 0);
    if (count > 5) assert.match(warnings[0], new RegExp(`${count} acceptance criteria.*split`, "i"));
  }
});

test("done warns once above 15 baseline files and continues through submission", async (t) => {
  const warnings = [];
  t.mock.method(console, "error", (line) => warnings.push(line));
  for (const [command, count] of [["done", 15], ["done", 16], ["done", 21], ["done", null], ["finish", 21], ["ship", 21]]) {
    warnings.length = 0;
    const steps = [], baseline = { remote: "trusted", defaultBranch: "main" };
    const doneChecks = [];
    const run = await handler("finish", {
      "../atelier.mjs": {
        I: () => "/task", actor: async () => "builder", isRunnerForbidden: () => false,
        noLongerHolds: () => "lost", takenBackNotice: () => null, args: { _: [command] }, cliState: { doneStep: "prepare" },
        call: async () => ({ item: { head: "head" } }), die: (message) => { throw Error(message); }, doneChecks,
        git: (args) => args[0] === "status" ? "" : "head", itemArg: () => "t1", project: () => "demo",
        request: async () => ({ item: { owner: "builder", state: "claimed" } }), requireWorkspace: () => {}, summaryArg: () => {},
      },
      "../read-grant.mjs": { baseReadGrant: async () => baseline },
      "../review-notice.mjs": {
        workspaceNotice: () => null,
        changedFromMain: (_git, _dir, grant) => { assert.equal(grant, baseline); return count === null ? null : Array.from({ length: count }, (_, i) => `file${i}`); },
      },
      "./push.mjs": { default: async () => steps.push("push") },
      "./check.mjs": { default: async () => steps.push("check") },
      "./submit.mjs": { default: async () => { steps.push("submit"); return { submitted: true }; } },
    });
    assert.equal((await run()).submitted, true);
    assert.deepEqual(steps, ["push", "check", "submit"]);
    const warned = command === "done" && count > 15;
    assert.equal(warnings.length, warned ? 1 : 0);
    if (warned) assert.match(warnings[0], new RegExp(`${count} files.*split`, "i"));
  }
});
