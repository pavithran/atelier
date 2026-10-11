import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROLES, rolePrompt, guideText } from "../src/usage.ts";
import { AGENTS_SECTION, agentsMdOffer, formatStanding } from "../cli/atelier.mjs";
import { formatStatus, formatStatusBrief, statusJson } from "../cli/status.mjs";

// Pure renderers only: no init, credentials, checkout or server is needed.
for (const role of ROLES) {
  test(`built-in ${role} guide snapshot`, (t) => {
    const text = rolePrompt(role);
    t.assert.snapshot(text);
    assert.match(text, /The project owner runs `atelier land ID --reviewer H\/M`/);
    assert.match(text, /Manual fallback:/);
    assert.match(text, /Builders and reviewers do not accept or merge their own work/);
  });
}
test("init offer and general project guide snapshots", (t) => {
  t.assert.snapshot(AGENTS_SECTION);
  t.assert.snapshot(agentsMdOffer(null));
  assert.equal(guideText(), readFileSync(new URL("./fixtures/cli/guide.txt", import.meta.url), "utf8"));
});

const items = [
  { id: "t1", state: "submitted", title: "Ready for owner", owner: "builder/model" },
  { id: "t2", state: "submitted", title: "Needs assessment", owner: "builder/model" },
  { id: "t3", state: "accepted", title: "Already accepted", owner: "builder/model" },
];
const inbox = items.map((i, n) => ({ project: "demo", itemId: i.id, title: i.title,
  kind: ["accept", "assess", "merge"][n], reason: "Recorded gate result",
  ...(n === 1 ? { reviewer: "reviewer/model" } : {}),
}));
const views = [{ name: "demo", title: "Demo", items, inbox }];
const standing = {
  project: { name: "demo", title: "Demo" }, generatedAt: "2026-10-10T12:00:00Z",
  live: items, waiting: inbox.map(({ itemId, ...w }) => ({ ...w, id: itemId })),
  queued: [], merged: [], handoffs: [],
};
const brief = { standing, version: null, queue: [], lease: null, usage: null };

for (const [form, render] of [
  ["status", () => formatStatus(views)],
  ["status --project", () => formatStanding(standing)],
  ["status --brief", () => formatStatusBrief(brief)],
]) {
  test(`${form} snapshot: submitted tasks land, accepted tasks merge`, (t) => {
    const text = render();
    t.assert.snapshot(text);
    assert.match(text, /atelier land t1 --reviewer H\/M --project demo/);
    assert.match(text, /atelier land t2 --reviewer reviewer\/model --project demo/);
    assert.match(text, /atelier merge t3 --project demo/);
    assert.doesNotMatch(text, /atelier land t3/);
  });
}
test("status JSON forms preserve their records", (t) => {
  t.assert.snapshot(statusJson(views));
  // Project JSON passes the standing record through, while brief JSON wraps
  // the very same lines as the text form (cli/commands/status.mjs).
  t.assert.snapshot({ project: standing });
  t.assert.snapshot({ brief: formatStatusBrief(brief).split("\n") });
});
