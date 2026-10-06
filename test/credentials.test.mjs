import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { chooseBackend, describeStore, promptSecret, readSecret, secretsFile, writeSecret } from "../cli/credentials.mjs";

// The stores are stubbed: `spawn` records every command and answers from a
// table, and the file store lives in a temporary directory. Nothing here reads
// or writes a real Keychain, Secret Service or credentials file.
const SECRET = "s3cr3t-token-value";

function fixture(t, over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-cred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const answers = over.answers ?? {};
  const spawn = (cmd, argv, opts = {}) => {
    calls.push({ cmd, argv, input: opts.input });
    if (over.missing?.includes(cmd)) return { error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), status: null };
    const key = `${cmd} ${argv[0]}`;
    return answers[key] ?? { status: 0, stdout: "" };
  };
  const deps = { platform: "linux", env: { ATELIER_CONFIG_DIR: dir }, spawn, home: dir, user: () => "pavi", ...over.deps };
  return { dir, calls, deps };
}

test("the backend follows the platform: Keychain, Secret Service when usable, else the file", (t) => {
  const bus = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };
  assert.equal(chooseBackend(fixture(t, { deps: { platform: "darwin" } }).deps), "keychain");
  assert.equal(chooseBackend(fixture(t, { deps: { env: bus } }).deps), "secret-service");
  assert.equal(chooseBackend(fixture(t).deps), "file", "no session bus");
  assert.equal(chooseBackend(fixture(t, { deps: { env: bus }, missing: ["secret-tool"] }).deps), "file", "secret-tool is not installed");
  assert.equal(chooseBackend(fixture(t, { deps: { platform: "win32", env: { APPDATA: "C:\\Users\\p\\AppData\\Roaming" } } }).deps), "file");
  assert.equal(chooseBackend(fixture(t, { deps: { platform: "freebsd" } }).deps), "file");
  assert.equal(chooseBackend(fixture(t, { deps: { platform: "darwin", env: { ATELIER_SECRET_STORE: "file" } } }).deps), "file", "a store can be named outright");
  assert.equal(chooseBackend(fixture(t, { deps: { env: { ATELIER_SECRET_STORE: "nonsense" } } }).deps), "file");
});

test("the file lives where each system keeps user config", () => {
  const home = "/home/p";
  assert.equal(secretsFile({ platform: "linux", env: {}, home }), "/home/p/.config/atelier/secrets.json");
  assert.equal(secretsFile({ platform: "linux", env: { XDG_CONFIG_HOME: "/x" }, home }), "/x/atelier/secrets.json");
  assert.equal(secretsFile({ platform: "win32", env: { APPDATA: "/appdata" }, home }), "/appdata/atelier/secrets.json");
  assert.equal(secretsFile({ platform: "linux", env: { ATELIER_CONFIG_DIR: "/c" }, home }), "/c/secrets.json");
});

test("macOS: reads with find-generic-password and writes through stdin, never an argument", (t) => {
  const f = fixture(t, { deps: { platform: "darwin" }, answers: { "security find-generic-password": { status: 0, stdout: `${SECRET}\n` } } });
  assert.equal(readSecret("API_TOKEN", f.deps), SECRET);
  assert.deepEqual(f.calls[0].argv, ["find-generic-password", "-s", "atelier.API_TOKEN", "-w"]);
  const where = writeSecret("API_TOKEN", SECRET, f.deps);
  assert.match(where, /macOS Keychain, item atelier\.API_TOKEN/);
  const write = f.calls.at(-1);
  assert.deepEqual(write.argv, ["-i"]);
  // The item names /usr/bin/security alone as the application that may read it
  // without asking; without -T every process the owner runs could.
  assert.match(write.input, /^add-generic-password -U -T \/usr\/bin\/security -s "atelier\.API_TOKEN" -a "pavi" -w "s3cr3t-token-value"\n$/);
  for (const c of f.calls) assert.ok(!c.argv.join(" ").includes(SECRET), "no secret on a command line");
});

test("macOS: a quote or backslash in a value is escaped for the security parser", (t) => {
  const f = fixture(t, { deps: { platform: "darwin" } });
  writeSecret("API_TOKEN", 'a"b\\c', f.deps);
  assert.ok(f.calls[0].input.includes('-w "a\\"b\\\\c"'));
});

test("Linux: secret-tool looks up and stores by service and account, the value on stdin", (t) => {
  const bus = { DBUS_SESSION_BUS_ADDRESS: "x" };
  const f = fixture(t, { deps: { env: bus }, answers: { "secret-tool lookup": { status: 0, stdout: SECRET } } });
  assert.equal(readSecret("API_TOKEN", f.deps), SECRET);
  const lookup = f.calls.find((c) => c.argv[0] === "lookup");
  assert.deepEqual(lookup.argv, ["lookup", "service", "atelier", "account", "API_TOKEN"]);
  assert.match(writeSecret("API_TOKEN", SECRET, f.deps), /Linux Secret Service, service atelier, account API_TOKEN/);
  const store = f.calls.find((c) => c.argv[0] === "store");
  assert.deepEqual(store.argv, ["store", "--label", "Atelier API_TOKEN", "service", "atelier", "account", "API_TOKEN"]);
  assert.equal(store.input, SECRET);
  for (const c of f.calls) assert.ok(!c.argv.join(" ").includes(SECRET));
});

test("a store that has no entry reads as null, and a failed write says so without the value", (t) => {
  const f = fixture(t, { deps: { platform: "darwin" }, answers: { "security find-generic-password": { status: 44, stdout: "" }, "security -i": { status: 1, stdout: "" } } });
  assert.equal(readSecret("API_TOKEN", f.deps), null);
  assert.throws(() => writeSecret("API_TOKEN", SECRET, f.deps), (e) => /could not write to the macOS Keychain/.test(e.message) && !e.message.includes(SECRET));
});

test("the file store writes mode 0600, round trips, and keeps other keys", (t) => {
  const f = fixture(t);
  assert.equal(readSecret("API_TOKEN", f.deps), null);
  const where = writeSecret("API_TOKEN", SECRET, f.deps);
  const file = join(f.dir, "secrets.json");
  assert.equal(where, `the file ${file}`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeSecret("OTHER", "second", f.deps);
  assert.equal(readSecret("API_TOKEN", f.deps), SECRET);
  assert.equal(readSecret("OTHER", f.deps), "second");
  assert.deepEqual(f.calls.filter((c) => c.cmd === "security"), []);
});

test("the file store refuses a file readable by others, for reading and writing, without naming a value", (t) => {
  const f = fixture(t);
  writeSecret("API_TOKEN", SECRET, f.deps);
  const file = join(f.dir, "secrets.json");
  for (const mode of [0o644, 0o640, 0o604, 0o666]) {
    chmodSync(file, mode);
    for (const act of [() => readSecret("API_TOKEN", f.deps), () => writeSecret("API_TOKEN", "new", f.deps)]) {
      assert.throws(act, (e) => e.message.includes(`mode ${mode.toString(8)}`) && e.message.includes("chmod 600") && !e.message.includes(SECRET));
    }
  }
  assert.ok(!readFileSync(file, "utf8").includes("new"), "a refused write changes nothing");
  chmodSync(file, 0o600);
  assert.equal(readSecret("API_TOKEN", f.deps), SECRET);
});

test("a malformed secrets file is an error that does not echo its content", (t) => {
  const f = fixture(t);
  const file = join(f.dir, "secrets.json");
  writeFileSync(file, `{"API_TOKEN": "${SECRET}"`, { mode: 0o600 });
  assert.throws(() => readSecret("API_TOKEN", f.deps), (e) => /not valid JSON/.test(e.message) && !e.message.includes(SECRET));
});

test("ATELIER_TOKEN wins over every store and no store is asked", (t) => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const f = fixture(t, { deps: { platform, env: { ATELIER_CONFIG_DIR: "/nonexistent", ATELIER_TOKEN: "  from-env \n", DBUS_SESSION_BUS_ADDRESS: "x" } } });
    assert.equal(readSecret("API_TOKEN", f.deps), "from-env");
    assert.deepEqual(f.calls, []);
  }
  const f = fixture(t);
  writeSecret("API_TOKEN", SECRET, f.deps);
  assert.equal(readSecret("API_TOKEN", { ...f.deps, env: { ...f.deps.env, ATELIER_TOKEN: "env" } }), "env");
  assert.equal(readSecret("API_TOKEN", { ...f.deps, env: { ...f.deps.env, ATELIER_TOKEN: "   " } }), SECRET, "a blank variable does not hide the store");
});

test("a value with a newline or control character is refused before any store is touched", (t) => {
  const f = fixture(t, { deps: { platform: "darwin" } });
  for (const bad of ["a\nb", "a\u0000b", "", "tab\there"]) assert.throws(() => writeSecret("API_TOKEN", bad, f.deps), /one line of text/);
  assert.deepEqual(f.calls, []);
});

test("a piped token is its first line; nothing else is kept", async () => {
  const piped = Object.assign(Readable.from([`${SECRET}\nsecond line\n`]), { isTTY: false });
  assert.equal(await promptSecret("Token: ", piped, { write() { throw new Error("no prompt when piped"); } }), SECRET);
  assert.equal(await promptSecret("Token: ", Object.assign(Readable.from([""]), { isTTY: false })), "");
});

// The CLI, with the file store forced and a stand-in server, so no real store is touched.
async function login(t, flags, { input, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-login-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(req.headers.authorization === `Bearer ${SECRET}` ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ownerActor: "pavi", ownerName: "Pavi", error: "unauthorised" }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const base = { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file" };
  delete base.ATELIER_TOKEN;
  const child = spawn(process.execPath, [resolve("cli/atelier.mjs"), "login", ...flags(server.address().port)], { cwd: dir, env: { ...base, ...env } });
  let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
  if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  const status = await new Promise((done) => child.on("close", done));
  return { status, output, dir, seen, secrets: join(dir, "secrets.json") };
}

test("login asks for a token when none is stored, stores it only once the server accepts it, and names the store", async (t) => {
  const ok = await login(t, (p) => ["--server", `http://127.0.0.1:${p}`], { input: `${SECRET}\n` });
  assert.equal(ok.status, 0, ok.output);
  assert.match(ok.output, /is now stored in the file .*secrets\.json/);
  assert.ok(!ok.output.includes(SECRET));
  assert.equal(JSON.parse(readFileSync(ok.secrets, "utf8")).API_TOKEN, SECRET);
  assert.equal(statSync(ok.secrets).mode & 0o777, 0o600);
  assert.deepEqual(ok.seen, [`Bearer ${SECRET}`]);
  const bad = await login(t, (p) => ["--server", `http://127.0.0.1:${p}`], { input: "wrong-token\n" });
  assert.notEqual(bad.status, 0);
  assert.ok(!existsSync(bad.secrets), "a token the server refused is not stored");
  assert.ok(!bad.output.includes("wrong-token"));
  const none = await login(t, (p) => ["--server", `http://127.0.0.1:${p}`], { input: "" });
  assert.notEqual(none.status, 0);
  assert.match(none.output, /no token entered/);
});

test("login --store names the store and whether a token is in it, never the token", async (t) => {
  const empty = await login(t, () => ["--store"]);
  assert.equal(empty.status, 0, empty.output);
  assert.match(empty.output, /The token store is the file .*secrets\.json\. No token is stored\./);
  const env = await login(t, () => ["--store"], { env: { ATELIER_TOKEN: SECRET } });
  assert.match(env.output, /ATELIER_TOKEN is set in the environment and is used instead/);
  assert.ok(!env.output.includes(SECRET));
  assert.match(describeStore("API_TOKEN", { platform: "darwin", env: {}, home: "/h" }), /^the macOS Keychain, item atelier\.API_TOKEN$/);
});
