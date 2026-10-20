// atelier status --new (t43): what someone else filed or edited since the
// caller last looked. The finding it answers: on 2026-10-15/16 an orchestrator
// never saw about twenty tasks a project session filed, because nothing in its
// loop listed new filings. The first tests hold the pure reading (cli/new-since.mjs);
// the rest run the CLI against a stand-in server whose project route answers
// the newest 50 events, as src/index.ts does, with the bookmark in a folder
// under os.tmpdir().
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bookmarkKey, formatNew, newSince, parseSince, readBookmark, writeBookmark } from "../cli/new-since.mjs";

const cli = resolve("cli/atelier.mjs");
const at = (n) => new Date(Date.UTC(2026, 9, 16, 8, 0, 0) + n * 60000).toISOString();
const ev = (seq, itemId, actor, kind = "item.edited", minute = seq) => ({ seq, itemId, actor, kind, at: at(minute), data: {} });
const items = [{ id: "t1", title: "One", state: "open" }, { id: "t2", title: "Two", state: "merged" }, { id: "t3", title: "Three", state: "claimed" }];
const newest = (events) => [...events].sort((a, b) => b.seq - a.seq);

test("own events are excluded before grouping, so a task shows the latest edit by someone else", () => {
  const events = newest([ev(1, "t1", "agent/a", "item.created"), ev(2, "t1", "owner"), ev(3, "t1", "agent/b"), ev(4, "t1", "owner"), ev(5, "t2", "owner")]);
  const r = newSince({ events, items, as: "owner", from: { seq: 0 } });
  assert.deepEqual(r.tasks.map((t) => [t.id, t.actor, t.kind, t.at]), [["t1", "agent/b", "edited", at(3)]]);
  assert.equal(r.upper, 5);
  assert.equal(r.complete, true);
});

test("mixed authors, a task seen once, closed tasks included, other event kinds ignored", () => {
  const events = newest([ev(1, "t1", "agent/a", "item.created"), ev(2, "t1", "agent/a"), ev(3, "t2", "agent/b"), ev(4, "t3", "agent/c", "item.claimed"), ev(5, "t1", "agent/c")]);
  const r = newSince({ events, items, as: "owner", from: { seq: 0 } });
  assert.deepEqual(r.tasks.map((t) => [t.id, t.actor, t.state]), [["t1", "agent/c", "open"], ["t2", "agent/b", "merged"]]);
  // A task filed and never edited says filed.
  const filed = newSince({ events: [ev(7, "t3", "agent/z", "item.created")], items, as: "owner", from: { seq: 6 } });
  assert.equal(filed.tasks[0].kind, "filed");
});

test("only events after the bookmark count; a tie on time is told apart by sequence", () => {
  const events = newest([ev(1, "t1", "agent/a", "item.edited", 5), ev(2, "t2", "agent/a", "item.edited", 5)]);
  const r = newSince({ events, items, as: "owner", from: { seq: 1 } });
  assert.deepEqual(r.tasks.map((t) => t.id), ["t2"]);
});

test("a full window that does not reach back to the bookmark may be incomplete; one that does is complete", () => {
  const full = (from) => newest(Array.from({ length: 50 }, (_, i) => ev(from + i, "t1", "agent/a")));
  assert.equal(newSince({ events: full(20), items, as: "owner", from: { seq: 10 } }).complete, false);
  assert.equal(newSince({ events: full(10), items, as: "owner", from: { seq: 10 } }).complete, true);
  // By time: the oldest event must be strictly before the instant.
  assert.equal(newSince({ events: full(1), items, as: "owner", from: { ms: Date.parse(at(1)) } }).complete, false);
  assert.equal(newSince({ events: full(1), items, as: "owner", from: { ms: Date.parse(at(2)) } }).complete, true);
  assert.equal(newSince({ events: newest([ev(1, "t1", "a")]), items, as: "owner", from: { seq: 0 } }).complete, true);
});

test("a list the CLI cannot read is unread, never none", () => {
  for (const bad of [undefined, "x", [{ seq: "1" }], [ev(1, "t1", "a"), { ...ev(2, "t1", "a"), at: "soon" }]]) {
    assert.ok(newSince({ events: bad, items, as: "owner", from: { seq: 0 } }).unread);
  }
  assert.ok(newSince({ events: [], items: undefined, as: "owner", from: { seq: 0 } }).unread);
  assert.match(formatNew({ result: { unread: "no list" }, project: "demo", as: "owner", how: "x" }), /unread\. no list\. Nothing is known/);
});

test("a bookmark ahead of the server's record falls back to the first-run window", () => {
  const r = newSince({ events: [ev(3, "t1", "agent/a", "item.edited", 3)], items, as: "owner", from: { seq: 90, ms: 0 } });
  assert.equal(r.behind, true);
  const none = newSince({ events: [], items, as: "owner", from: { seq: 4 } });
  assert.equal(none.behind, true);
});

test("--since needs an instant with a zone, refuses an invalid or future one", () => {
  const now = Date.parse("2026-10-17T00:00:00Z");
  assert.equal(parseSince("2026-10-16T08:00Z", now).ms, Date.parse("2026-10-16T08:00Z"));
  assert.equal(parseSince("2026-10-16T08:00:00+02:00", now).ms, Date.parse("2026-10-16T06:00Z"));
  for (const bad of ["2026-10-16", "2026-10-16T08:00", "3d", "yesterday", "2026-10-16 08:00Z", "2026-02-30T00:00Z", "2026-13-01T00:00Z", "2026-10-16T25:00Z", true, undefined]) {
    assert.match(parseSince(bad, now).error, /--since/, String(bad));
  }
  assert.match(parseSince("2026-10-17T00:00:01Z", now).error, /future/);
  assert.equal(parseSince("2026-10-17T00:00:00Z", now).ms, now);
});

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-new-since-"));
  t.after(() => { try { chmodSync(dir, 0o700); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test("a bookmark file is kept per key, corrupt ones are unreadable and left alone, an unwritable one says why", (t) => {
  const dir = folder(t), file = join(dir, "sub", "new-since.json");
  const a = bookmarkKey("https://s", "demo", "owner"), b = bookmarkKey("https://s", "demo", "agent/x");
  assert.deepEqual(readBookmark(a, file), { mark: null });
  assert.equal(writeBookmark(a, { seq: 4, at: "t" }, file), null);
  assert.equal(writeBookmark(b, { seq: 9, at: "u" }, file), null);
  assert.deepEqual(readBookmark(a, file), { mark: { seq: 4, at: "t" } });
  assert.deepEqual(readBookmark(b, file), { mark: { seq: 9, at: "u" } });
  assert.deepEqual(readBookmark(bookmarkKey("https://other", "demo", "owner"), file), { mark: null });
  for (const bad of ["{not json", "[]", "{}", JSON.stringify({ bookmarks: { [a]: { seq: "x" } } })]) {
    writeFileSync(file, bad);
    assert.ok(readBookmark(a, file).unreadable, bad);
    assert.match(writeBookmark(a, { seq: 1, at: "t" }, file), /./);
    assert.equal(readFileSync(file, "utf8"), bad);
  }
  const dirAsFile = join(dir, "isdir");
  mkdirSync(dirAsFile);
  assert.match(readBookmark(a, dirAsFile).unreadable, /cannot be read/);
  chmodSync(dir, 0o500);
  assert.match(writeBookmark(a, { seq: 1, at: "t" }, join(dir, "new.json")), /cannot be written/);
});

// The stand-in server and the CLI run.
async function world(t, answer) {
  const dir = folder(t), config = join(dir, "config");
  mkdirSync(config);
  const state = { events: [], items, status: 200, reads: 0 };
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      let status = 200, body;
      if (req.url === "/api/version") body = { commit: "c".repeat(40), routeLevel: 99, capabilities: [] };
      else if (req.url === "/api/projects/demo") { state.reads++; status = state.status; body = status === 200 ? { project: { name: "demo" }, items: state.items, events: newest(state.events).slice(0, 50) } : { error: "boom", detail: "down" }; }
      else { status = 404; body = { error: "unexpected", detail: req.url }; }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(config, "config.json"), JSON.stringify({ server: url, owner: "owner", projects: {} }));
  const file = join(config, "new-since.json");
  const run = async (argv, { actor = "owner", now } = {}) => {
    const env = { ...process.env, HOME: dir, ATELIER_CONFIG_DIR: config, ATELIER_CACHE: join(dir, "cache"), ATELIER_SERVER: url, ATELIER_SECRET_STORE: "file", ATELIER_TOKEN: "test-token", ATELIER_ACTOR: actor };
    const child = spawn(process.execPath, [cli, ...argv], { cwd: dir, env });
    let out = "", err = "";
    child.stdout.on("data", (s) => out += s);
    child.stderr.on("data", (s) => err += s);
    const code = await new Promise((done) => child.on("close", done));
    return { code, out, err };
  };
  return { state, run, file, config, url };
}

const recent = (seq, itemId, actor, kind = "item.edited") => ({ seq, itemId, actor, kind, at: new Date(Date.now() - 3600_000 + seq * 1000).toISOString(), data: {} });

test("first run reads the last 24 hours and says so, then the bookmark moves; a later run shows only what is newer", async (t) => {
  const w = await world(t);
  w.state.events = [{ ...ev(1, "t2", "agent/old"), at: new Date(Date.now() - 48 * 3600_000).toISOString() }, recent(2, "t1", "agent/a", "item.created"), recent(3, "t1", "owner")];
  const first = await w.run(["status", "--new", "--project", "demo"]);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /since the last 24 hours \(this is the first run for owner here/);
  assert.match(first.out, /t1  filed by agent\/a at .*  open  One/);
  assert.doesNotMatch(first.out, /t2|agent\/old/);
  assert.equal(JSON.parse(readFileSync(w.file, "utf8")).bookmarks[bookmarkKey(w.url, "demo", "owner")].seq, 3);
  // An event that arrives after that read is shown next time, once.
  w.state.events.push(recent(4, "t3", "agent/b"));
  const second = await w.run(["status", "--new", "--project", "demo"]);
  assert.match(second.out, /since your last look/);
  assert.match(second.out, /t3  edited by agent\/b/);
  assert.doesNotMatch(second.out, /t1/);
  const third = await w.run(["status", "--new", "--project", "demo"]);
  assert.match(third.out, /Nothing new\./);
  assert.equal(third.code, 0);
});

test("two actors keep separate bookmarks, and --as names the caller", async (t) => {
  const w = await world(t);
  w.state.events = [recent(1, "t1", "agent/a"), recent(2, "t2", "owner")];
  await w.run(["status", "--new", "--project", "demo"]);
  w.state.events.push(recent(3, "t3", "agent/b"));
  const other = await w.run(["status", "--new", "--project", "demo", "--as", "agent/a"]);
  assert.match(other.out, /not by agent\/a/);
  assert.match(other.out, /t2  edited by owner/);
  assert.match(other.out, /t3/);
  assert.doesNotMatch(other.out, /t1/);
  const owner = await w.run(["status", "--new", "--project", "demo"]);
  assert.match(owner.out, /t3/);
  assert.doesNotMatch(owner.out, /t2/);
  assert.equal(Object.keys(JSON.parse(readFileSync(w.file, "utf8")).bookmarks).length, 2);
});

test("a window that does not reach back says so and keeps the bookmark", async (t) => {
  const w = await world(t);
  w.state.events = [recent(1, "t1", "agent/a")];
  await w.run(["status", "--new", "--project", "demo"]);
  const kept = readFileSync(w.file, "utf8");
  w.state.events = Array.from({ length: 60 }, (_, i) => recent(2 + i, "t3", "agent/b"));
  const r = await w.run(["status", "--new", "--project", "demo"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /may be incomplete.*newest 50 events/s);
  assert.match(r.out, /t3  edited by agent\/b/);
  assert.equal(readFileSync(w.file, "utf8"), kept);
  const json = JSON.parse((await w.run(["status", "--new", "--project", "demo", "--json"])).out);
  assert.equal(json.status, "incomplete");
  assert.equal(json.complete, false);
});

test("a corrupt bookmark prints unread, exits 1, reads nothing and is kept", async (t) => {
  const w = await world(t);
  writeFileSync(w.file, "{broken");
  const r = await w.run(["status", "--new", "--project", "demo"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /unread\. the bookmark is unreadable/);
  assert.doesNotMatch(r.out, /Nothing new/);
  assert.equal(readFileSync(w.file, "utf8"), "{broken");
  assert.equal(w.state.reads, 0);
  // --since does not need the bookmark, and leaves it alone.
  const since = await w.run(["status", "--new", "--project", "demo", "--since", "2020-01-01T00:00Z"]);
  assert.equal(since.code, 0, since.err);
  assert.equal(readFileSync(w.file, "utf8"), "{broken");
});

test("an unreadable project prints unread, exits 1 and keeps the bookmark", async (t) => {
  const w = await world(t);
  w.state.events = [recent(1, "t1", "agent/a")];
  await w.run(["status", "--new", "--project", "demo"]);
  const kept = readFileSync(w.file, "utf8");
  w.state.status = 500;
  for (const flags of [[], ["--json"], ["--brief"]]) {
    const r = await w.run(["status", "--new", "--project", "demo", ...flags]);
    assert.equal(r.code, 1);
    assert.match(r.out, /unread/);
    assert.doesNotMatch(r.out, /Nothing new|"tasks"/);
  }
  assert.equal(readFileSync(w.file, "utf8"), kept);
});

test("a bookmark that cannot be saved says unread after the list and exits 1", async (t) => {
  const w = await world(t);
  w.state.events = [recent(1, "t1", "agent/a")];
  chmodSync(w.config, 0o500);
  const r = await w.run(["status", "--new", "--project", "demo"]);
  chmodSync(w.config, 0o700);
  assert.equal(r.code, 1);
  assert.match(r.out, /t1  filed|t1  edited/);
  assert.match(r.out, /Bookmark: unread\. the bookmark could not be saved/);
  assert.equal(existsSync(w.file), false);
});

test("--since is refused when invalid or future, and never moves the bookmark", async (t) => {
  const w = await world(t);
  w.state.events = [recent(1, "t1", "agent/a")];
  for (const bad of ["2026-10-16", "3d", "2999-01-01T00:00Z", "2026-02-30T00:00Z"]) {
    const r = await w.run(["status", "--new", "--project", "demo", "--since", bad]);
    assert.equal(r.code, 1, bad);
    assert.match(r.err, /--since/);
  }
  assert.equal(w.state.reads, 0);
  const ok = await w.run(["status", "--new", "--project", "demo", "--since", "2020-01-01T00:00Z"]);
  assert.match(ok.out, /since 2020-01-01T00:00Z/);
  assert.match(ok.out, /t1/);
  assert.equal(existsSync(w.file), false);
  const alone = await w.run(["status", "--since", "2020-01-01T00:00Z", "--project", "demo"]);
  assert.equal(alone.code, 1);
  assert.match(alone.err, /--since belongs to status --new/);
});

test("--brief is one line and --json names the status, the since and the tasks", async (t) => {
  const w = await world(t);
  w.state.events = [recent(1, "t1", "agent/a"), recent(2, "t2", "agent/b")];
  const brief = await w.run(["status", "--new", "--project", "demo", "--brief", "--since", "2020-01-01T00:00Z"]);
  assert.equal(brief.out.trim().split("\n").length, 1);
  assert.match(brief.out, /t2 \(edited by agent\/b\), t1 \(edited by agent\/a\)/);
  const json = JSON.parse((await w.run(["status", "--new", "--project", "demo", "--json"])).out);
  assert.deepEqual([json.project, json.actor, json.status, json.complete], ["demo", "owner", "ok", true]);
  assert.deepEqual(json.tasks.map((x) => [x.id, x.actor, x.kind]), [["t2", "agent/b", "edited"], ["t1", "agent/a", "edited"]]);
});

test("a bookmark ahead of the server's record is set aside, said so and replaced", async (t) => {
  const w = await world(t);
  w.state.events = [recent(1, "t1", "agent/a")];
  writeFileSync(w.file, JSON.stringify({ bookmarks: { [bookmarkKey(w.url, "demo", "owner")]: { seq: 500, at: "2026-10-01T00:00:00.000Z" } } }));
  const r = await w.run(["status", "--new", "--project", "demo"]);
  assert.match(r.out, /is ahead of the server's record/);
  assert.match(r.out, /t1/);
  assert.equal(JSON.parse(readFileSync(w.file, "utf8")).bookmarks[bookmarkKey(w.url, "demo", "owner")].seq, 1);
});
