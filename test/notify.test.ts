import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationRequest, usageAlertRequest } from "../src/notify.ts";
import { briefFor } from "../src/brief.ts";
import { gate } from "../src/rules.ts";
import type { Detail } from "../src/ui.ts";

function detail(title = "Review café ☕"): Detail {
  const item: Detail["item"] = {
    id: "t1", title, scope: [], state: "submitted", owner: "codex/gpt-6-astra",
    fork: "p--t1", base: "0".repeat(40), head: "a".repeat(40), acceptedHead: null,
    createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z", lastPushAt: null,
  };
  const policy = { checks: [], protected: [] };
  return { item, policy, evidence: [], reviews: [], events: [], gate: gate(item, policy, [], []) };
}

test("notification uses the existing decision brief, encoded title and absolute task URL", async () => {
  const d = detail();
  const r = notificationRequest("random-topic", "https://atelier.test/api/ignored?x=1", "café project", d);
  assert.equal(r.url, "https://ntfy.sh/random-topic");
  assert.equal(r.method, "POST");
  assert.equal(r.headers.get("Click"), "https://atelier.test/p/caf%C3%A9%20project/t1");
  assert.equal(r.headers.get("Priority"), "default");
  assert.equal(r.headers.get("Tags"), "inbox_tray");
  for (const value of r.headers.values()) assert.match(value, /^[\x20-\x7e]*$/);
  const title = r.headers.get("Title")!;
  assert.equal(Buffer.from(title.slice(10, -2), "base64").toString("utf8"), "Atelier: Review café ☕");
  assert.equal(await r.text(), briefFor(d).decided);
});

test("notification caps the brief at 500 Unicode characters without splitting a character", async () => {
  const r = notificationRequest("topic", "https://atelier.test", "p", detail("🦉".repeat(700)));
  const text = await r.text();
  assert.equal(Array.from(text).length, 500);
  assert.ok(text.endsWith("🦉"));
  assert.ok(!text.includes("�"));
});

test("title control characters cannot become headers and the body stays on one line", async () => {
  const r = notificationRequest("topic", "https://atelier.test", "p", detail("Title\r\nPriority: max"));
  assert.equal(r.headers.get("Priority"), "default");
  assert.doesNotMatch(await r.text(), /[\r\n]/);
});

test("a usage alert goes to the same topic, opens the Usage page, and keeps its body to one line", async () => {
  const r = usageAlertRequest("random-topic", "https://atelier.test/api/usage/codex", "codex: weekly window 81% used", "codex on home:studio has used 81%\nof its weekly window.");
  assert.equal(r.url, "https://ntfy.sh/random-topic");
  assert.equal(r.headers.get("Click"), "https://atelier.test/usage");
  assert.equal(r.headers.get("Tags"), "warning");
  assert.equal(Buffer.from(r.headers.get("Title")!.slice(10, -2), "base64").toString("utf8"), "Atelier: codex: weekly window 81% used");
  assert.equal(await r.text(), "codex on home:studio has used 81% of its weekly window.");
});
