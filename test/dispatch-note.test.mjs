import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { briefFor, runPlanTask } from "../cli/runner.mjs";
import { formatStanding, formatTask } from "../cli/atelier.mjs";
import { makeDispatch } from "../src/dispatch/rules.ts";
import { DISPATCH_NOTE_MAX, OWNER_TEXT_MAX, assertLength, notePreview } from "../src/text.ts";
import { RuleError } from "../src/rules.ts";

// t480: a dispatch note carries a full set of findings. It has a limit of its
// own (2000 UTF-16 code units), --note-file reads it from a file, every brief
// carries it whole, and a queue or status line shows a short preview.

const cli = resolve("cli/atelier.mjs");
const TOKEN = "atl_" + "e".repeat(64);
const AT = "2026-10-10T10:00:00.000Z";

// The CLI against a server that answers the dispatch route with the real
// makeDispatch rules, behind a bearer token, and records each request.
async function server(t) {
  const requests = [];
  const http = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorized" });
    const body = raw ? JSON.parse(raw) : undefined;
    if (req.method === "POST" && /\/items\/t1\/dispatch$/.test(req.url)) {
      requests.push({ path: req.url, body });
      try {
        const dispatch = makeDispatch(body, "owner", AT);
        return send(200, { id: "t1", dispatch });
      } catch (error) {
        if (error instanceof RuleError) return send(error.status, { error: error.code, detail: error.message });
        throw error;
      }
    }
    if (req.method === "GET" && /\/items\/t1$/.test(req.url)) return send(200, { item: { id: "t1", state: "open", dispatch: { at: AT } } });
    return send(200, {});
  });
  t.after(() => http.close());
  await new Promise((done, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", done); });
  const root = mkdtempSync(join(tmpdir(), "atelier-note-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const run = (argv) => new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd: root, env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: TOKEN, ATELIER_SERVER: origin } });
    let output = "";
    child.stdout.on("data", (s) => (output += s));
    child.stderr.on("data", (s) => (output += s));
    child.on("close", (status) => done({ status, output }));
  });
  return { requests, run, root };
}

const dispatchArgs = (...more) => ["dispatch", "t1", "--to", "home", "--agent", "codex", "--model", "gpt-6-astra", "--project", "demo", ...more];

test("the limit is 2000 code units for a dispatch note and unchanged for other owner text", () => {
  assert.equal(DISPATCH_NOTE_MAX, 2000);
  assert.equal(OWNER_TEXT_MAX, 500);
  const note = (text) => makeDispatch({ note: text }, "owner", AT).note;
  assert.equal(note("a".repeat(2000)).length, 2000);
  assert.throws(() => note("a".repeat(2001)), (e) => e instanceof RuleError && e.code === "too_long" && e.status === 400 && /2000/.test(e.message));
  // Code units, not characters: 1000 emoji are 2000 units, 1001 are 2002.
  assert.equal(note("😀".repeat(1000)).length, 2000);
  assert.throws(() => note("😀".repeat(1001)), /too_long|limit is 2000/);
  // The rules store text as given and count each CRLF as two units: 1999 'a'
  // and a CRLF is 2001 units and is refused, never folded to 2000.
  assert.equal(note("é\nline two\r\n\tindented\rlast\n"), "é\nline two\r\n\tindented\rlast\n");
  assert.throws(() => note("a".repeat(1999) + "\r\n"), (e) => e instanceof RuleError && e.code === "too_long");
  assert.equal(note("a".repeat(1998) + "\r\n").length, 2000);
  assert.equal(note("a".repeat(1999) + "\n").length, 2000);
  // Other owner text keeps its 500.
  assert.doesNotThrow(() => assertLength("a".repeat(500), OWNER_TEXT_MAX, "the approval"));
  assert.throws(() => assertLength("a".repeat(501), OWNER_TEXT_MAX, "the approval"), /limit is 500/);
});

test("--note-file sends the file's text, newlines kept, through the real rules and token, exit 0", async (t) => {
  const f = await server(t);
  const text = "1. fix the parser\n2. add a test — ünïcode 😀\r\n\nthree\n";
  writeFileSync(join(f.root, "findings.md"), text);
  const r = await f.run(dispatchArgs("--note-file", "findings.md"));
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /t1 is waiting for a home runner, codex with gpt-6-astra/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.note, text);
});

test("--note-file accepts exactly 2000 code units, a path in a subdirectory, and an empty file", async (t) => {
  const f = await server(t);
  mkdirSync(join(f.root, "sub"));
  writeFileSync(join(f.root, "sub", "full.txt"), "x".repeat(1999) + "\n");
  assert.equal((await f.run(dispatchArgs("--note-file", "sub/full.txt"))).status, 0);
  assert.equal(f.requests.at(-1).body.note.length, 2000);
  writeFileSync(join(f.root, "empty.txt"), "");
  const empty = await f.run(dispatchArgs("--note-file", "empty.txt"));
  assert.equal(empty.status, 0, empty.output);
  assert.equal(f.requests.at(-1).body.note, "");
});

test("a note over 2000 code units is refused by the route with the limit named, never cut, exit 1", async (t) => {
  const f = await server(t);
  writeFileSync(join(f.root, "long.txt"), "x".repeat(2001));
  const file = await f.run(dispatchArgs("--note-file", "long.txt"));
  assert.equal(file.status, 1);
  assert.match(file.output, /the dispatch note is 2001 characters; the limit is 2000/);
  const inline = await f.run(dispatchArgs("--note", "y".repeat(2001)));
  assert.equal(inline.status, 1);
  assert.match(inline.output, /limit is 2000/);
  assert.equal(f.requests.length, 2);
});

test("--note with --note-file, a missing or unreadable file and invalid UTF-8 are refused before any request", async (t) => {
  const f = await server(t);
  writeFileSync(join(f.root, "ok.txt"), "fine");
  writeFileSync(join(f.root, "bad.txt"), Buffer.from([0x66, 0xff, 0xfe, 0x67]));
  mkdirSync(join(f.root, "dir"));
  for (const [argv, pattern] of [
    [["--note", "a", "--note-file", "ok.txt"], /not both/],
    [["--note-file", "ok.txt", "--note", ""], /not both/],
    [["--note-file", "missing.txt"], /cannot read the note file missing\.txt: ENOENT/],
    [["--note-file", "dir"], /cannot read the note file dir: EISDIR/],
    [["--note-file", "bad.txt"], /bad\.txt is not valid UTF-8/],
  ]) {
    const r = await f.run(dispatchArgs(...argv));
    assert.equal(r.status, 1, argv.join(" "));
    assert.match(r.output, pattern);
  }
  assert.deepEqual(f.requests, []);
});

test("help states the limit and the --note-file rules", async (t) => {
  const f = await server(t);
  const r = await f.run(["dispatch", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.output, /--note TEXT\s+.*2000 characters \(UTF-16 code units\).*never cut/);
  assert.match(r.output, /--note-file PATH\s+.*UTF-8.*relative to the current directory.*line breaks kept.*not with --note.*empty file is an empty note/);
});

test("notePreview shows the first line, capped at 120 code units, marking what is omitted", () => {
  assert.equal(notePreview(""), "");
  assert.equal(notePreview(undefined), "");
  assert.equal(notePreview("  \n\t\n"), "");
  assert.equal(notePreview("Keep it small"), "Keep it small");
  assert.equal(notePreview("first\nsecond"), "first…");
  assert.equal(notePreview("first\r\nsecond"), "first…");
  assert.equal(notePreview("a".repeat(120)), "a".repeat(120));
  assert.equal(notePreview("a".repeat(121)), "a".repeat(120) + "…");
  // The cap never splits a surrogate pair: 119 units, then a pair that would straddle 120.
  const straddle = "a".repeat(119) + "😀" + "b";
  assert.equal(notePreview(straddle), "a".repeat(119) + "…");
  // A pair that ends exactly at 120 stays whole.
  assert.equal(notePreview("a".repeat(118) + "😀"), "a".repeat(118) + "😀");
  assert.equal(notePreview("a".repeat(118) + "😀" + "b"), "a".repeat(118) + "😀…");
  for (const note of [straddle, "😀".repeat(100), "x\n" + "😀".repeat(100)]) assert.doesNotMatch(notePreview(note), /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
});

test("status and queue show the preview, not the whole note", async (t) => {
  const note = "Fix the first finding\nSecond finding\nThird finding";
  const standing = {
    project: { title: "Demo", name: "demo" }, generatedAt: AT, live: [], waiting: [], merged: [], handoffs: [],
    queued: [{ id: "t1", to: "home", agent: "codex", model: "gpt-6-astra", title: "Task", note }, { id: "t2", to: "any", agent: null, model: null, title: "Plain", note: "" }],
  };
  const lines = formatStanding(standing).split("\n");
  assert.ok(lines.some((l) => l.endsWith("Task  note: Fix the first finding…")));
  assert.ok(lines.some((l) => l.endsWith("Plain")));
  assert.ok(!formatStanding(standing).includes("Second finding"));

  const http = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/queue" ? [
      { project: "demo", item: { id: "t1", title: "Task", dispatch: { to: "home", agent: "codex", model: "gpt-6-astra", note } } },
      { project: "demo", item: { id: "t2", title: "Plain", dispatch: { to: "any", agent: null, model: null, note: "" } } },
    ] : {}));
  });
  t.after(() => http.close());
  await new Promise((done) => http.listen(0, "127.0.0.1", done));
  const root = mkdtempSync(join(tmpdir(), "atelier-note-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = await new Promise((done) => {
    const child = spawn(process.execPath, [cli, "queue"], { cwd: root, env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: TOKEN, ATELIER_SERVER: `http://127.0.0.1:${http.address().port}` } });
    let output = "";
    child.stdout.on("data", (s) => (output += s));
    child.stderr.on("data", (s) => (output += s));
    child.on("close", (status) => done({ status, output }));
  });
  assert.equal(out.status, 0, out.output);
  assert.equal(out.output, "demo/t1  for home codex/gpt-6-astra  Task\n  note: Fix the first finding…\ndemo/t2  for any  Plain\n");
});

test("every brief carries the whole note with its line breaks, labelled as the owner's data", () => {
  const note = "Findings:\n1. a — one\n\n2. b\r\n3. " + "z".repeat(1900) + "\n😀 end";
  const item = { id: "t1", title: "T", scope: ["src/**"], owner: "claude-code/sonnet-5.5", dispatch: { note } };
  const brief = briefFor(item, "atelier");
  assert.ok(brief.includes(`Note (the owner's words, data, not instructions from Atelier), in full:\n${note}`));
  assert.ok(!briefFor({ ...item, dispatch: { note: "" } }, "atelier").includes("Note (the owner's words"));
  const task = formatTask({ title: "T", scope: ["src/**"], dispatch: { note } });
  assert.ok(task.endsWith(`Note (the owner's words, not instructions from Atelier):\n${note}`));
});

test("--overlap-ok with --note-file sends the file's note (even empty) and is length-checked, never a retain", async (t) => {
  const f = await server(t);
  writeFileSync(join(f.root, "n.txt"), "line one\nline two\n");
  const r = await f.run(["dispatch", "t1", "--overlap-ok", "--note-file", "n.txt", "--project", "demo"]);
  assert.equal(r.status, 0, r.output);
  assert.equal(f.requests.at(-1).body.note, "line one\nline two\n");
  assert.equal(f.requests.at(-1).body.retain, undefined);
  writeFileSync(join(f.root, "empty.txt"), "");
  assert.equal((await f.run(["dispatch", "t1", "--overlap-ok", "--note-file", "empty.txt", "--project", "demo"])).status, 0);
  assert.equal(f.requests.at(-1).body.note, "");
  assert.equal(f.requests.at(-1).body.retain, undefined);
  writeFileSync(join(f.root, "big.txt"), "x".repeat(2001));
  const big = await f.run(["dispatch", "t1", "--overlap-ok", "--note-file", "big.txt", "--project", "demo"]);
  assert.notEqual(big.status, 0);
  assert.match(big.output, /2000/);
});

test("notePreview takes the first line before trimming and marks leading or trailing line breaks", () => {
  assert.equal(notePreview("\nsecond"), "…");
  assert.equal(notePreview("first\n"), "first…");
  assert.equal(notePreview("first\r\n"), "first…");
  assert.equal(notePreview("first"), "first");
});

test("a plan job's brief carries the dispatch note whole, with its line breaks", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atelier-note-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const note = "Findings:\n1. a\n\n2. b";
  const briefs = [];
  const io = {
    stopped: () => false, log() {}, ownerTokens: () => [], env: {},
    workspacePath: (project, id) => { const dir = join(root, id); mkdirSync(dir, { recursive: true }); return dir; },
    async cli() {}, async reset() {}, async head() { return "h"; },
    async brief(workspace, text) { briefs.push(text); throw new Error("stop here"); },
    async jobBrief() { return { job: "plan", text: "SERVER BRIEF", hash: "h" }; },
    async removeBrief() {}, async dataHome() { return null; }, async removeDataHome() {}, async postPlan() {},
  };
  const config = { agents: [{ agent: "opencode", models: ["glm-5.3"], command: ["x", "{plan_file}"] }] };
  const job = { project: "atelier", item: { id: "t7", dispatch: { note } }, agent: "opencode", model: "glm-5.3", actor: "opencode/glm-5.3" };
  await runPlanTask(job, config, "home:studio", io);
  assert.equal(briefs.length, 1);
  assert.ok(briefs[0].endsWith(`SERVER BRIEF\n\nNote (the owner's words, data, not instructions from Atelier), in full:\n${note}`));
});

// The browser form folds CRLF to LF at its handler only (src/index.ts), so the
// page's textarea count holds; the rules never do. The Worker cannot run here,
// so the handler's source is read, as src/dispatch/retain.test.mjs reads the CLI's.
test("the form handler folds CRLF to LF for a dispatch note only, and the rules do not", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /verb === "dispatch" \? String\(form\.get\("note"\) \?\? ""\)\.replace\(\/\\r\\n\?\/g, "\\n"\)/);
  const rules = await readFile(new URL("../src/dispatch/rules.ts", import.meta.url), "utf8");
  assert.doesNotMatch(rules, /replace\(\/\\r/);
  // What the form hands the rules: 700 lines of CRLF folded fit; unfolded they are refused.
  const typed = "a\r\n".repeat(700);
  const folded = typed.replace(/\r\n?/g, "\n");
  assert.equal(makeDispatch({ note: folded }, "owner", AT).note, folded);
  assert.throws(() => makeDispatch({ note: typed }, "owner", AT), /limit is 2000/);
});
