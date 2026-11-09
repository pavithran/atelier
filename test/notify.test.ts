import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { noticeLines, noticeText, type Notice } from "../src/notify.ts";

// t533 (PAVI, 2026-11-07: "drop ntfy"): the three former notifications are
// ledger events read in chat. These tests cover the lines they read as, that no
// code builds an ntfy.sh URL or reads NTFY_TOPIC, and that the docs say where
// notices are read.

const ROOT = new URL("..", import.meta.url).pathname;
function files(dir: string, keep: (path: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (name === "node_modules" || name === ".git" || name === ".scratch") continue;
    if (statSync(join(ROOT, rel)).isDirectory()) files(rel, keep, out);
    else if (keep(rel)) out.push(rel);
  }
  return out;
}
const isCode = (p: string) => /\.(ts|mjs|js|json|toml|sh)$/.test(p) && !/(^|\/)(test|node_modules)\//.test(p) && !/\.(test|spec)\.(ts|mjs)$/.test(p);

test("no module builds an ntfy.sh URL", () => {
  const offenders = [...files("src", isCode), ...files("cli", isCode)].filter((p) => /ntfy\.sh/i.test(readFileSync(join(ROOT, p), "utf8")));
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(readFileSync(join(ROOT, "package.json"), "utf8"), /ntfy\.sh/i);
});

test("no module reads the NTFY_TOPIC secret", () => {
  const offenders = [...files("src", isCode), ...files("cli", isCode)].filter((p) => /NTFY_TOPIC/.test(readFileSync(join(ROOT, p), "utf8")));
  assert.deepEqual(offenders, []);
});

test("the build refusal for the ntfy command stays", () => {
  assert.match(readFileSync(join(ROOT, "src/checks.ts"), "utf8"), /case "ntfy":/);
});

test("docs name no ntfy setup step and say notices are read through atelier status", () => {
  const docs = [...files("docs", (p) => p.endsWith(".md")), "README.md"];
  for (const p of docs) {
    const text = readFileSync(join(ROOT, p), "utf8");
    assert.doesNotMatch(text, /ntfy/i, `${p} names ntfy`);
  }
  const setup = readFileSync(join(ROOT, "docs/setup.md"), "utf8");
  assert.match(setup, /atelier status/);
  assert.match(setup, /read in chat/i);
});

test("each former notification reads as one line", () => {
  assert.equal(noticeText("inbox.notice", { title: "Add café", brief: "Ready to decide.\nChecks pass.", reason: "submitted" }), "Add café is waiting on you: Ready to decide. Checks pass.");
  assert.equal(noticeText("inbox.notice", { title: "T", brief: "b", reason: "round-cap" }), "T is held after the round cap: b");
  assert.equal(noticeText("usage.alert", { title: "codex: weekly window 81% used", body: "ignored" }), "codex: weekly window 81% used");
  assert.equal(noticeText("stuck.digest_notice", { episodes: [{ item: "t1", reason: "no push" }] }), "1 stuck episode: t1: no push");
});

const n = (at: string, over: Partial<Notice> = {}): Notice => ({ at, kind: "usage.alert", project: null, item: null, text: "x", ...over });

test("the status section lists the notices as the server returned them, newest first, and none when there are none", () => {
  assert.deepEqual(noticeLines({ notices: [], unread: [] }), []);
  assert.deepEqual(noticeLines(null), []);
  const lines = noticeLines({ notices: [n("2026-11-09T10:00:00.000Z", { project: "p", item: "t1", kind: "inbox.notice", text: "T is waiting on you: b" }), n("2026-11-09T09:00:00.000Z", { text: "codex: weekly window 81% used" })], unread: [] });
  assert.deepEqual(lines, [
    "Notices (last 24 hours, newest first)",
    "  2026-11-09T10:00:00.000Z p t1: T is waiting on you: b",
    "  2026-11-09T09:00:00.000Z usage: codex: weekly window 81% used",
  ]);
});

test("a project the server could not read is named, not passed over as having no notices", () => {
  assert.deepEqual(noticeLines({ notices: [], unread: ["broken"] }), ["Notices (last 24 hours, newest first)", "  not read: broken"]);
});
