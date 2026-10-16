// The scanner the runner-routes checks share (t478), tested on its own:
// test/helpers/source-scan.mjs reads JavaScript and TypeScript with the
// TypeScript compiler's parser, and test/runner-routes.test.mjs (the runner's
// modules, transitively) and test/runner-routes-helpers.test.mjs (the
// commands the runner spawns, transitively, and the helpers of cli/atelier.mjs
// they reach) apply it. Their mutation cases try the forms against the real
// modules; these cases pin what the scanner reads, form by form, so a change
// to it cannot quietly stop reading one.
//
// Scope: the scan guards against an accidental undeclared call by an honest
// builder (a new helper, an import, an alias, a re-export). The runtime guards
// and the gateway remain the enforcement; code written to hide a reach (eval,
// a name or a specifier assembled at run time) is out of scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assignmentsTo, bareCalls, bypasses, callsTo, importClosure, importsOf, namesIn, objectKeys, parseModule, references, resolveImport, staticString, usesOf, withFiles } from "./helpers/source-scan.mjs";

test("the scan reads code, not strings, templates, regular expressions or comments", () => {
  assert.deepEqual(bypasses('git(["fetch", "--quiet", "origin"]); // a fetch( in a comment\nconsole.log(`run git fetch first, then ${count(n, "fetch")}`); /* fetch( */'), []);
  assert.deepEqual(bypasses("const ok = /fetch\\(/.test(text);"), []);
  assert.deepEqual(bypasses("const ok = a / fetch / b;"), ["fetch"], "a division is not a regular expression");
  assert.deepEqual(bypasses("console.log(`${await fetch(url)}`);"), ["fetch("]);
  assert.deepEqual(bypasses('const o = { "fetch": 1, fetchAll: 2 }; o.fetchAll(); const t = "serverFetch(";'), []);
  assert.deepEqual(bypasses("function f(x: typeof fetch) {}".replace("typeof fetch", "x")), []);
  assert.deepEqual(parseModule("export const f = (a: typeof fetch) => a;", "x.ts").imports, []);
  assert.deepEqual(bypasses(parseModule("export const f = (a: typeof fetch) => a;", "x.ts")), [], "a type query is not a reach");
});

// Every form of a reach, as the reference the scanner reads it as.
test("every form of a server reach is read", () => {
  const forms = [
    ["await fetch(u);", ["fetch("]],
    ["const go = fetch;", ["fetch"]],
    ["await serverFetch(u);", ["serverFetch("]],
    ["const go = serverFetch;", ["serverFetch"]],
    ["await globalThis.fetch(u);", ["globalThis.fetch("]],
    ["await globalThis?.fetch(u);", ["globalThis?.fetch("]],
    ["await self.fetch(u); await window.fetch(u); await io.fetch(u);", ["self.fetch(", "window.fetch(", "io.fetch("]],
    ["const send = transport?.serverFetch;", ["transport?.serverFetch"]],
    ["const { fetch: f } = globalThis;", ["fetch: f"]],
    ["const { fetch } = globalThis;", ["fetch:"]],
    ["function g({ server, fetch = globalThis.fetch }) {}", ["fetch = globalThis.fetch", "globalThis.fetch"]],
    ['await globalThis["fetch"](u); x[`serverFetch`](u); y["server" + "Fetch"](u); z["fe" + "tch"](u); w[\'fetch\'](u);', ['globalThis["fetch"](', "x[`serverFetch`](", 'y["server" + "Fetch"](', 'z["fe" + "tch"](', "w['fetch']("]],
    ['const a = o["fetchAll"]; const b = o["server" + "Name"]; const c = o[`${name}`];', []],
    ["https.request(u); http.get(u);", ["https.request(", "http.get("]],
    ["new WebSocket(u); new EventSource(u); new XMLHttpRequest();", ["new WebSocket(", "new EventSource(", "new XMLHttpRequest("]],
    ['import { request } from "node:http";', ['import from "node:http"']],
    ['import https from "https"; import net from "node:net"; import * as tls from "node:tls"; import { Agent } from "undici"; import "node:dgram";', ['import from "https"', 'import from "node:net"', 'import from "node:tls"', 'import from "undici"', 'import from "node:dgram"']],
    ['import * as transport from "../server-fetch.mjs"; import { serverFetch as send } from "./server-fetch.mjs"; import send2 from "./server-fetch";', ['import from "../server-fetch.mjs"', 'import from "./server-fetch.mjs"', 'import from "./server-fetch"']],
    ['const t = await import("../server-fetch.mjs"); (await import("./server-fetch.mjs")).default;', ['import("../server-fetch.mjs")', 'import("./server-fetch.mjs")']],
    ['const { request } = await import("node:https"); await import("undici");', ['import("node:https")', 'import("undici")']],
    ['process.getBuiltinModule("node:https"); createRequire(import.meta.url)("node:http");', ["getBuiltinModule", "createRequire("]],
    ['require("node:http"); const r = require(name);', ["require(", "require("]],
    ['await import("node:" + "http"); const m = "undici"; await import(m); await import(`${m}`);', ["import(<not a literal>)", "import(<not a literal>)", "import(<not a literal>)"]],
    ['import x = require("node:http");', ["require("]],
  ];
  for (const [code, expected] of forms) assert.deepEqual(bypasses(code), expected, code);
});

// astra's first fifth-round finding: re-exports were recognised by the
// import reader and ignored by the reach check.
test("a re-export of a network or transport module is a reach, in every form", () => {
  const forms = [
    ['export { request as send } from "node:https";', 'export from "node:https"'],
    ['export { request } from "http";', 'export from "http"'],
    ['export * from "node:http";', 'export from "node:http"'],
    ['export * as net from "node:https";', 'export from "node:https"'],
    ['export { default } from "undici";', 'export from "undici"'],
    ['export { serverFetch } from "./server-fetch.mjs";', 'export from "./server-fetch.mjs"'],
    ['export type { Agent } from "undici"; export { a } from "node:net";', 'export from "node:net"'],
  ];
  for (const [code, expected] of forms) assert.ok(bypasses(code).includes(expected), code);
  assert.deepEqual(bypasses('export { x } from "./fine.mjs"; export * from "./also-fine.ts"; export { y }; export const z = 1;'), []);
  // The line-start rule of the earlier scanner: indentation, several to a line, a multiline clause.
  assert.deepEqual(bypasses('  export {\n    request as send,\n  } from "node:https"; export * from "node:http";'), ['export from "node:https"', 'export from "node:http"']);
});

test("a property key named fetch is a name, not a reach, and is still reported for a caller that counts it", () => {
  const source = 'const io = { fetch: (cwd) => run(cwd), async serverFetch() {} };\nconst usage = { fetch: { text: "x" } };';
  assert.deepEqual(bypasses(source), []);
  assert.deepEqual(references(source).map((r) => [r.kind, r.text, r.line]), [["property-key", "fetch:", 1], ["property-key", "serverFetch:", 1], ["property-key", "fetch:", 2]]);
  assert.deepEqual(bypasses("const o = { fetch };"), ["fetch"], "a shorthand property reads the global");
});

test("imports are read in every form: side-effect, re-export, dynamic, require, aliased, namespace, type-only, several to a line", () => {
  const forms = importsOf([
    'import "./side.mjs";',
    "import { a as b, type C } from './named.mjs'; import d, * as e from \"./both.mjs\";",
    'import {\n  x,\n  y as z,\n} from "../multi.mjs";',
    'export { q } from "./re.mjs"; export * from "./all.ts"; export * as ns from "./ns.ts";',
    'const m = await import("./lazy.mjs"); import type { T } from "./types.ts";',
    'const { go, stop: halt } = await import("./destructured.mjs"); const { server } = api ?? await import("./either.mjs");',
    'const r = require("./cjs.cjs"); const { f } = require("./cjs-names.cjs"); import q = require("./eq.cjs");',
    'import { type A, type B } from "./all-types.ts"; export type { U } from "./types-re.ts";',
  ].join("\n"));
  const spec = (s) => forms.find((f) => f.spec === s);
  assert.deepEqual(forms.map((f) => f.spec).sort(), ["../multi.mjs", "./all-types.ts", "./all.ts", "./both.mjs", "./cjs-names.cjs", "./cjs.cjs", "./destructured.mjs", "./either.mjs", "./eq.cjs", "./lazy.mjs", "./named.mjs", "./ns.ts", "./re.mjs", "./side.mjs", "./types-re.ts", "./types.ts"]);
  assert.deepEqual(spec("./named.mjs").bound, [{ imported: "a", local: "b" }, { imported: "C", local: "C" }]);
  assert.deepEqual(spec("../multi.mjs").bound, [{ imported: "x", local: "x" }, { imported: "y", local: "z" }]);
  assert.deepEqual(spec("./both.mjs").bound, [{ imported: "default", local: "d" }, { imported: "*", local: "e" }]);
  assert.deepEqual(spec("./re.mjs").bound, [{ imported: "q", local: "q" }]);
  assert.deepEqual(spec("./ns.ts").bound, [{ imported: "*", local: "ns" }]);
  assert.deepEqual(spec("./destructured.mjs").bound, [{ imported: "go", local: "go" }, { imported: "stop", local: "halt" }]);
  assert.deepEqual(spec("./either.mjs").bound, [{ imported: "server", local: "server" }], "either side of ?? may be the import");
  assert.deepEqual(spec("./cjs-names.cjs").bound, [{ imported: "f", local: "f" }]);
  for (const s of ["./both.mjs", "./all.ts", "./ns.ts", "./lazy.mjs", "./cjs.cjs", "./eq.cjs"]) assert.equal(spec(s).opaque, true, s);
  for (const s of ["./named.mjs", "../multi.mjs", "./re.mjs", "./destructured.mjs", "./either.mjs", "./cjs-names.cjs", "./side.mjs"]) assert.equal(spec(s).opaque, false, s);
  assert.deepEqual(forms.filter((f) => f.typeOnly).map((f) => f.spec).sort(), ["./all-types.ts", "./types-re.ts", "./types.ts"]);
  assert.deepEqual(forms.filter((f) => f.kind === "dynamic").map((f) => f.spec).sort(), ["./destructured.mjs", "./either.mjs", "./lazy.mjs"]);
  assert.deepEqual(importsOf('await import(name); require(name);').map((f) => [f.kind, f.spec]), [["dynamic", null], ["require", null]]);
});

test("aliases of a module's exports are followed: renamed imports, plain aliases, destructuring, namespaces, assignments", () => {
  const uses = (code) => usesOf(parseModule(code, "cli/commands/x.mjs")).filter((u) => u.module.endsWith("atelier.mjs") && u.name !== "*").map((u) => `${u.name}:${u.local}:${u.role}`);
  assert.deepEqual(uses('import { call as send } from "../atelier.mjs"; send(1);'), ["call:send:callee"]);
  assert.deepEqual(uses('import { call } from "../atelier.mjs"; const a = call; const b = a; b(1);'), ["call:call:alias", "call:a:alias", "call:b:callee"]);
  assert.deepEqual(uses('import { call } from "../atelier.mjs"; let f; f = (call); f(1);'), ["call:f:alias", "call:call:alias", "call:f:callee"]);
  assert.deepEqual(uses('const { call: send, request } = await import("../atelier.mjs"); send(1); request(2);'), ["call:send:callee", "request:request:callee"]);
  assert.deepEqual(uses('import * as ns from "../atelier.mjs"; ns.call(1); const r = ns["request"]; r(2);'), ["call:ns.call:callee", "request:ns[\"request\"]:alias", "request:r:callee"]);
  assert.deepEqual(uses('const ns = await import("../atelier.mjs"); const { call } = ns; call(1);'), ["call:call:callee"]);
  assert.deepEqual(uses('import { call } from "../atelier.mjs"; go(call); const o = { call }; export { call };'), ["call:call:value", "call:call:value", "call:call:value"]);
  assert.deepEqual(uses('import { call } from "../atelier.mjs"; function f(call) { return call; }'), ["call:call:value"], "a shadowing parameter is read as the import: it only widens what the check judges");
  assert.deepEqual(uses('import { other } from "../atelier.mjs"; const call = other; call(1);'), ["other:other:alias", "other:call:callee"]);
  // calls
  const found = callsTo(parseModule('import { call as send, request } from "../atelier.mjs"; await send("POST", "/runs", {}); const r = request; r("GET", "/x");', "cli/commands/x.mjs"), (m) => m.endsWith("atelier.mjs"), new Set(["call", "request"]));
  assert.deepEqual(found.calls.map((c) => [c.name, c.args.length]), [["call", 3], ["request", 2]]);
  assert.deepEqual(found.leaks, []);
  // A module's own names are its bindings with `self`, so an alias inside it resolves.
  const self = parseModule("export async function call() {}\nexport function f() { const ask = call; return ask(1); }", "cli/atelier.mjs", { self: true });
  assert.deepEqual(callsTo(self, (m) => m === "cli/atelier.mjs", new Set(["call"])).calls.map((c) => c.name), ["call"]);
});

test("names, declarations, calls to a bare name and object keys are read from the syntax", () => {
  const m = parseModule("export async function a(x) { return b(x.c, { d }); }\nconst b = (y) => y, e = 1;\nlet { f, g: h } = o;\nclass K {}");
  assert.deepEqual([...m.declarations.keys()], ["a", "b", "e", "f", "h", "K"]);
  assert.equal(m.declarations.get("a").exported, true);
  assert.deepEqual([...namesIn(m, m.declarations.get("a").node)].sort(), ["b", "d", "x"], "property names and declared names are not uses");
  assert.deepEqual(bareCalls('await serverFetch(a, 1); x.fetch(2); fetch(3);', new Set(["serverFetch", "fetch"])).map((c) => [c.name, c.args.length]), [["serverFetch", 2], ["fetch", 1]]);
  const keys = (code) => objectKeys(parseModule(`x(${code});`).sf.statements[0].expression.arguments[0]);
  assert.deepEqual(keys('{ "a": 1, b, c: d, ...rest, ...(p ? { q } : { r: 1 }), [s]: 1 }'), ["a", "b", "c", "q", "r"]);
  assert.equal(staticString(parseModule('x("a" + `b` + "c");').sf.statements[0].expression.arguments[0]), "abc");
  assert.equal(staticString(parseModule("x(`a${b}`);").sf.statements[0].expression.arguments[0]), undefined);
  assert.deepEqual(assignmentsTo("const io = { a }; io = runnerIO; function f(io = other) {} io = g();", "io").map((a) => [a.kind, a.text]), [["object", "{ a }"], ["identifier", "runnerIO"], ["identifier", "other"], ["other", "g()"]]);
});

test("specifiers resolve as the loaders resolve them, and the walk follows every runtime import but not a type-only one", () => {
  const files = { exists: (path) => ["src/a.ts", "cli/b.mjs", "cli/c/index.mjs", "cli/d.cjs"].includes(path) };
  assert.equal(resolveImport("cli/commands/x.mjs", "../../src/a.js", files), "src/a.ts", "a .js specifier names the .ts beside it");
  assert.equal(resolveImport("cli/commands/x.mjs", "../b", files), "cli/b.mjs", "an extensionless specifier gets a source extension");
  assert.equal(resolveImport("cli/commands/x.mjs", "../c", files), "cli/c/index.mjs");
  assert.equal(resolveImport("cli/commands/x.mjs", "../d", files), "cli/d.cjs");
  assert.equal(resolveImport("cli/commands/x.mjs", "node:fs", files), null);
  assert.equal(resolveImport("cli/commands/x.mjs", null, files), null);
  assert.equal(resolveImport("cli/commands/x.mjs", "../../../outside.mjs", { exists: () => true }), null, "a file outside the repository is not followed");
  const tree = {
    "cli/entry.mjs": 'import "./side.mjs"; import { a } from "./named.mjs"; export { r } from "./re.mjs"; export * from "./star.mjs"; const { l } = await import("./lazy.mjs"); const c = require("./cjs.cjs"); import type { T } from "../src/types.ts"; import "./atelier.mjs"; import "./server-fetch.mjs";',
    "cli/side.mjs": 'import "../src/deep.js";', "cli/named.mjs": "", "cli/re.mjs": "", "cli/star.mjs": "", "cli/lazy.mjs": "", "cli/cjs.cjs": "",
    "src/deep.ts": 'import "../cli/loop.mjs";', "cli/loop.mjs": 'import "./entry.mjs";', "src/types.ts": "", "cli/atelier.mjs": 'import "./never.mjs";', "cli/server-fetch.mjs": "", "cli/never.mjs": "",
  };
  const fs = withFiles(tree, { read: () => { throw new Error("outside the tree"); }, exists: () => false });
  const stop = (p) => /(?:atelier|server-fetch)\.mjs$/.test(p);
  assert.deepEqual(importClosure("cli/entry.mjs", { files: fs, stop }), ["cli/side.mjs", "src/deep.ts", "cli/loop.mjs", "cli/named.mjs", "cli/re.mjs", "cli/star.mjs", "cli/lazy.mjs", "cli/cjs.cjs"]);
  assert.deepEqual(importClosure("cli/entry.mjs", { files: fs }).includes("cli/never.mjs"), true, "without a stop, the walk enters cli/atelier.mjs too");
});

test("a dynamic or require call that names no literal is unreadable, and a literal one is followed", () => {
  assert.deepEqual(references('const m = await import(name);').map((r) => [r.kind, r.text]), [["unreadable", "import(<not a literal>)"]]);
  assert.deepEqual(references('await import("./x.mjs");').map((r) => r.text), []);
  assert.deepEqual(references('require("./x.cjs");').map((r) => [r.kind, r.text]), [["unreadable", "require("]]);
});
