// The helpers the runner spawns make only the calls RUNNER_CALLS declares,
// checked against their source (t478). test/runner-routes.test.mjs holds
// the runner's own calls to runnerTransport and exercises every declared
// call through the real gateway; this file reads the atelier commands the
// runner spawns as children (claim, finish, check, release and the rest,
// `via: "cli"` in src/tokens.ts) and the helpers in cli/atelier.mjs they
// import, and judges each server call they make against the table:
//
// - every call goes through the CLI's shared transport, `call` or `request`
//   in cli/atelier.mjs (postEvidence wraps `request`); a bare fetch, an
//   http(s) request or a socket in a command's module, in any module it
//   imports (transitively, through import, re-export, dynamic import and
//   side-effect import alike), or in any helper of cli/atelier.mjs it reaches
//   (imported, aliased, or named by one it reaches), is a bypass and fails
//   here, save serverVersion's declared preflight read;
// - every call's method and path is one the table declares as a cli call,
//   so a command that starts calling an undeclared route fails npm test
//   until the route is declared (and, by the other file, allowed and
//   exercised);
// - every body field a call sends is one the declared call names;
// - every path a command calls is allowed for the credential the table gives
//   that command: runnerRoute for a runner-token command, agentRoute for a
//   reviewer's or the integrator's, so a runner-token helper that starts
//   calling an agent-only route is caught before the gateway refuses it;
// - every declared cli call is made by the command the table names, so a
//   declaration nothing sends is dropped rather than kept as a spare door;
// - every helper of cli/atelier.mjs that sends to the server without
//   request() refuses a spawned helper at run time, before it fetches.
//
// All of it is read with one parser-based scanner, test/helpers/source-scan.mjs
// (the TypeScript compiler's parser): imports in every form, identifier
// aliases, calls and references to a server outside the transport. The scan
// guards against accidental undeclared calls by honest builders; the runtime
// guards (declaredHelperCall, refuseSpawnedHelper, the fetch guard) and the
// gateway remain the enforcement, and deliberately obfuscated code (eval,
// computed names built at run time) is out of scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { agentRoute, callParts, callPath, declaredHelperCall, RUNNER_CALLS, RUNNER_COMMANDS, runnerRoute } from "../src/tokens.ts";
import { args, call, request, cliState } from "../cli/atelier.mjs";
import { runnerTransport } from "../cli/runner.mjs";
import { bareCalls, bypasses, callsTo, fileSystem, importClosure, namesIn, objectKeys, parseModule, references, resolveImport, staticString, usesOf, withFiles } from "./helpers/source-scan.mjs";

const read = (path) => readFileSync(resolve(path), "utf8");
const ITEM = "/projects/{project}/items/{item}";
// The CLI's transport: the functions a command calls to reach the server,
// which are followed to no further call site of their own.
const TRANSPORT = new Set(["call", "request", "postEvidence"]);
const ATELIER_FILE = "cli/atelier.mjs";
const ATELIER_MODULE = /(?:^|\/)atelier\.mjs$/;
const TRANSPORT_FILE = /(?:^|\/)server-fetch\.mjs$/;
const isAtelier = (module) => ATELIER_MODULE.test(module);
const boundary = (path) => isAtelier(path) || TRANSPORT_FILE.test(path);
// cli/atelier.mjs read with its own names as bindings, so an alias of one of
// its helpers inside it resolves like an alias of an import.
const atelierOf = (files = fileSystem) => parseModule(files.read(ATELIER_FILE), ATELIER_FILE, { self: true });
const ATELIER = atelierOf();

test("the helper transport refuses undeclared operations at runtime regardless of call spelling", async (t) => {
  const before = args._;
  const login = cliState.loginToken;
  t.after(() => { args._ = before; cliState.loginToken = login; });
  args._ = ["claim"];
  cliState.loginToken = "fixture-owner";
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url, init });
    if (url.endsWith("/config")) return Response.json({ runner: "home:fixture" });
    return Response.json({ ok: true });
  });
  for (const spelling of ["call", "call ", "call /* comment */ ", "(call)", "((send) => send)(call)"]) {
    const invoke = new Function("call", `return ${spelling}("POST", "/runners", {}, "test/actor");`);
    await assert.rejects(invoke(call), /not a call the runner helpers declare/);
    await assert.rejects(invoke(request), /not a call the runner helpers declare/);
  }
  await assert.rejects(call("GET", "/queue"), /not a call the runner helpers declare/);
  await assert.rejects(call("POST", "/projects/p/items/t1/claim", { secret: true }), /does not send secret/);
  const transport = runnerTransport({ server: "https://atelier.test", credential: "fixture" });
  for (const spelling of ["send", "send ", "send /* comment */ ", "(send)"]) {
    await assert.rejects(new Function("send", `return ${spelling}("undeclared");`)(transport.send), /not a call the runner declares/);
  }
  assert.equal(sent.length, 0, "refusal precedes even the identity request");
  // A declared request still passes through the actual call/request boundary.
  const oldServer = cliState.loginServer;
  t.after(() => { cliState.loginServer = oldServer; });
  cliState.loginServer = "https://atelier.test";
  await call("POST", "/projects/p/items/t1/claim", {}, "test/actor");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].init.method, "POST");
  cliState.loginToken = "atl_fixture_runner";
  await assert.rejects(call("POST", "/projects/p/items/t1/review-claim", {}, "test/actor"), /not a call/);
  assert.equal(sent.length, 2, "only the identity read is sent before learning the token kind");
  await assert.rejects(call("POST", "/projects/p/items/t1/base-token", { scope: "write" }, "test/actor"), /only requests read scope/);
  assert.equal(sent.length, 2, "a known runner cannot send agent operations or request write tokens");
});

// The reviewer's finding on the first round: the guard judged every form of
// atelier fast, so the owner's fast status failed
// before they sent anything. Only fast take and fast ready are the runner's.
test("the owner's fast status still reaches the server; only the runner's fast take and ready are held to the declarations", async (t) => {
  const before = args._, login = cliState.loginToken, server = cliState.loginServer;
  t.after(() => { args._ = before; cliState.loginToken = login; cliState.loginServer = server; });
  cliState.loginToken = "fixture-owner";
  cliState.loginServer = "https://atelier.test";
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url, method: init?.method });
    if (url.endsWith("/config")) return Response.json({ runner: "home:fixture" });
    return Response.json({ ok: true });
  });
  args._ = ["fast", "status"];
  await call("GET", "/projects/p/mode", undefined, "test/actor");
  assert.ok(sent.some((r) => r.url.endsWith("/projects/p/mode")), "fast status reached the server");
  const count = sent.length;
  for (const sub of ["take", "ready"]) {
    args._ = ["fast", sub];
    await assert.rejects(call("GET", "/projects/p/mode", undefined, "test/actor"), /not a call the runner helpers declare/);
  }
  assert.equal(sent.length, count, "the runner's forms are still refused before sending");
});

test("the runtime helper boundary resolves the same declarations exercised at the gateway", () => {
  for (const c of RUNNER_CALLS.filter((c) => c.via === "cli" || c.name === "config")) {
    const path = callPath(c, { project: "p", item: "t1", run: "run:1" });
    const body = c.method === "GET" ? undefined : {};
    const resolved = declaredHelperCall(c.method, path, body);
    assert.equal(resolved.path, c.path);
    assert.equal(resolved.credential, c.credential);
    if (c.credential === "runner") {
      assert.equal(runnerRoute(c.method, callParts(c), {}), true, c.name);
      assert.doesNotThrow(() => declaredHelperCall(c.method, path, body, true));
    } else assert.throws(() => declaredHelperCall(c.method, path, body, true), /not a call/);
  }
  assert.throws(() => declaredHelperCall("POST", "/projects/p/items/t1/base-token", { scope: "write" }, true), /only requests read scope/);
  for (const path of ["/projects//items/t1/claim", "/projects/p/items/t1/claim?extra=1", "/projects/p/items/t1/claim/extra"]) {
    assert.throws(() => declaredHelperCall("POST", path, {}), /not a call/);
  }
});

// The exported function of cli/atelier.mjs by name, as its node, or null.
function exported(name, atelier = ATELIER) {
  const d = atelier.declarations.get(name);
  return d?.exported && d.node.body ? d.node : null;
}

// The path a call site names, as the table writes it: I(name, id) is the
// item, a template on it is the item's verb, a run id under sandbox is
// {run}, P(name) is the project, and a plain string is itself.
function declaredPath(expr) {
  const text = expr.trim();
  if (/^I\(\s*name\s*,\s*id\s*\)$/.test(text)) return ITEM;
  if (/^P\(\s*name\s*\)$/.test(text)) return "/projects/{project}";
  const template = /^`\$\{I\(\s*name\s*,\s*id\s*\)\}((?:\/[a-z-]+)*)(\/\$\{encodeURIComponent\(runId\)\})?`$/.exec(text);
  if (template) return `${ITEM}${template[1]}${template[2] ? "/{run}" : ""}`;
  // The project-level baseline read (t435), the one project route below the project record a runner token may call.
  if (/^`\$\{P\(\s*name\s*\)\}\/baseline-token`$/.test(text)) return "/projects/{project}/baseline-token";
  const literal = /^"(\/[a-z/-]+)"$/.exec(text);
  if (literal) return literal[1];
  return null;
}

// Every server call within `roots` of a module (default the whole module):
// through `call`, `request` or postEvidence of cli/atelier.mjs under any
// name the module binds them to (an alias, a destructuring, an import under
// another name), with the method, the path as declared, and the body's keys
// ([] for a body that is not an object literal or a conditional on one). The
// transport passed on where the check cannot follow it (handed to another
// function, returned, stored in an object) fails: it could be called there.
function callSitesIn(input, roots, where) {
  const module = typeof input === "string" ? parseModule(input) : input;
  const { calls, leaks } = callsTo(module, isAtelier, TRANSPORT, roots);
  assert.deepEqual(leaks.map((l) => `${l.name} as ${l.text} (line ${l.line})`), [], `${where}: passes the CLI's transport (call, request, postEvidence) on, where this check cannot follow a call through it`);
  return calls.map((c) => {
    const [first, second, third] = c.name === "postEvidence" ? [undefined, c.args[0], c.args[1]] : c.args;
    const method = c.name === "postEvidence" ? "POST" : staticString(first);
    assert.ok(method, `${where}: a server call whose method this check cannot read: ${c.text}`);
    assert.ok(second, `${where}: a server call without a path: ${c.text}`);
    const pathText = second.getText().trim();
    const declared = declaredPath(pathText);
    assert.ok(declared, `${where}: a server call to a path this check cannot read: ${pathText}`);
    const keys = third === undefined || third.getText().trim() === "undefined" ? [] : objectKeys(third);
    return { where, method, path: declared, keys, text: `${method} ${pathText}` };
  });
}

// The helpers of cli/atelier.mjs a command reaches: those it imports, and
// every top-level declaration any of them names, transitively. The
// transport itself is not followed: its fetch is the one the CLI makes.
function reachable(names, atelier = ATELIER) {
  const decls = atelier.declarations;
  const seen = new Set(), queue = names.filter((n) => decls.has(n) && !TRANSPORT.has(n));
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    for (const n of namesIn(atelier, decls.get(name).node)) {
      if (n !== name && decls.has(n) && !TRANSPORT.has(n) && !seen.has(n)) queue.push(n);
    }
  }
  return [...seen];
}

// The transport's own identity read: request asks resolveTokenActor, which
// reads GET /config once per agent token before the command's first call,
// so every command the runner spawns makes it. It is the declared config
// call, which a runner token and an agent token may both make; it is judged
// here rather than counted as one command's call.
function identityRead(sites, where) {
  assert.ok(sites.length, `${where} makes no server call this check can see`);
  for (const site of sites) {
    const declared = RUNNER_CALLS.filter((c) => c.method === site.method && c.path === site.path);
    assert.ok(declared.length, `${where}: ${site.text} is not a call RUNNER_CALLS declares (src/tokens.ts)`);
    assert.deepEqual(site.keys, [], `${where}: ${site.text} sends a body`);
    for (const allowed of [runnerRoute, agentRoute]) assert.equal(allowed(site.method, callParts(declared[0]), {}), true, `${where}: ${site.text} is not allowed for every token a spawned command holds`);
  }
  return [];
}

// The server calls a helper of cli/atelier.mjs makes, failing on any bypass
// of the transport. serverVersion is the one helper that fetches: its fetch
// is the declared public preflight read, judged by preflightFetches below,
// and any other bypass in it still fails.
function helperCalls(name, atelier = ATELIER) {
  const where = `cli/atelier.mjs ${name}()`;
  const node = atelier.declarations.get(name).node;
  const found = bypasses(atelier, node);
  if (name === "serverVersion") {
    preflightFetches(atelier, node);
    const others = found.filter((b) => b !== "fetch(" && b !== "serverFetch(");
    assert.deepEqual(others, [], `${where} reaches the server outside the CLI's transport: ${others.join(", ")}`);
  } else {
    assert.deepEqual(found, [], `${where} reaches the server outside the CLI's transport: ${found.join(", ")}`);
  }
  const sites = callSitesIn(atelier, node, where);
  return name === "resolveTokenActor" ? identityRead(sites, where) : sites;
}

// A command module that holds more than the runner's part: atelier fast also
// reads the mode and closes it (the developer's, under the owner's token, on
// routes no runner token may call), and the runner spawns only fast take and
// fast ready. The calls judged are those of the named top-level functions and
// whatever they reach, in this module and in the modules they import; every
// module is still scanned whole for a bypass of the transport, and
// helperCommand (cli/runner.mjs) refuses any other form of fast at run time.
const RUNNER_PART = { fast: ["fastTake", "fastReadyReport"] };

// What one module contributes to a command's calls: its call sites, the
// names it takes from cli/atelier.mjs, and the modules it hands on. With
// `seeds`, only the top-level declarations those names start, and what they
// reach in the module; null judges the module whole. A module that imports
// cli/atelier.mjs as a namespace, a default or dynamically as a namespace
// fails, wherever the use: it reaches every helper in it and cannot be
// followed.
function judge(file, seeds, files, state) {
  const key = `${file}\0${seeds ? [...seeds].sort().join(",") : "*"}`;
  if (state.seen.has(key)) return;
  state.seen.add(key);
  const module = parseModule(files.read(file), file);
  const atelierImports = module.imports.filter((e) => !e.typeOnly && e.spec !== null && isAtelier(e.spec));
  for (const entry of atelierImports) assert.ok(!entry.opaque, `${file} imports cli/atelier.mjs as a namespace, a default or dynamically, which reaches every helper in it and cannot be followed`);
  let roots = [module.sf];
  if (seeds) {
    const decls = module.declarations, used = new Set(), queue = [...seeds].filter((n) => decls.has(n));
    while (queue.length) {
      const name = queue.shift();
      if (used.has(name)) continue;
      used.add(name);
      for (const n of namesIn(module, decls.get(name).node)) if (decls.has(n) && !used.has(n)) queue.push(n);
    }
    roots = [...used].map((n) => decls.get(n).node);
  }
  state.sites.push(...callSitesIn(module, roots, file));
  const uses = usesOf(module, roots);
  state.names.push(...uses.filter((u) => isAtelier(u.module) && !["*", "default"].includes(u.name)).map((u) => u.name));
  const taken = (entry) => entry.bound.filter((b) => !["*", "default"].includes(b.imported) && (!seeds || entry.kind !== "re-export" || seeds.has(b.local))).map((b) => b.imported);
  if (!seeds) state.names.push(...atelierImports.flatMap(taken));
  else state.names.push(...atelierImports.filter((e) => e.kind === "re-export").flatMap(taken));
  if (!seeds) return;
  // The modules this part reaches, narrowed to the names it takes from each.
  for (const entry of module.imports) {
    if (entry.typeOnly || entry.spec === null || entry.kind === "side-effect") continue;
    const path = resolveImport(file, entry.spec, files);
    if (!path || boundary(path)) continue;
    let next;
    if (entry.kind === "re-export") {
      if (entry.opaque && !entry.bound.length) next = seeds;
      else {
        const hit = entry.bound.filter((b) => seeds.has(b.local));
        if (!hit.length) continue;
        next = hit.some((b) => ["*", "default"].includes(b.imported)) ? null : new Set(hit.map((b) => b.imported));
      }
    } else {
      const names = uses.filter((u) => u.module === entry.spec).map((u) => u.name);
      if (!names.length) continue;
      next = names.some((n) => ["*", "default"].includes(n)) ? null : new Set(names);
    }
    if (next) judge(path, next, files, state);
    else for (const f of [path, ...importClosure(path, { files, stop: boundary })]) judge(f, null, files, state);
  }
}

// The calls a command makes, and the helpers of cli/atelier.mjs it reaches:
// its module's own and those of every module it imports (transitively, of
// any import form and file kind), each scanned whole for a bypass of the
// transport, their call sites judged where they stand, and the helpers of
// cli/atelier.mjs any of them names followed as the command's.
function commandFacts(command, files = fileSystem, file = `cli/commands/${command}.mjs`) {
  assert.ok(files.exists(file), `${command} is declared with no module at ${file}`);
  const own = bypasses(parseModule(files.read(file), file));
  assert.deepEqual(own, [], `${file} reaches the server outside the CLI's transport: ${own.join(", ")}`);
  const modules = importClosure(file, { files, stop: boundary });
  for (const module of modules) {
    const found = bypasses(parseModule(files.read(module), module));
    assert.deepEqual(found, [], `${module}, imported by atelier ${command}, reaches the server outside the CLI's transport: ${found.join(", ")}`);
  }
  const state = { sites: [], names: [], seen: new Set() };
  if (RUNNER_PART[command]) {
    const declared = parseModule(files.read(file), file).declarations;
    for (const name of RUNNER_PART[command]) assert.ok(declared.has(name), `${name} is gone from the command module; update RUNNER_PART`);
    judge(file, new Set(RUNNER_PART[command]), files, state);
  } else for (const f of [file, ...modules]) judge(f, null, files, state);
  return state;
}

function commandCalls(command, files = fileSystem, file) {
  const { sites, names } = commandFacts(command, files, file);
  const atelier = atelierOf(files);
  for (const name of reachable(names, atelier)) sites.push(...helperCalls(name, atelier));
  return sites;
}

const CLI_CALLS = RUNNER_CALLS.filter((c) => c.via === "cli");
const byRoute = (method, path) => CLI_CALLS.filter((c) => c.method === method && c.path === path);

test("the commands the runner spawns reach the server through the CLI's transport, on declared routes, with declared bodies", () => {
  const made = new Set();
  for (const command of RUNNER_COMMANDS) {
    const mine = CLI_CALLS.filter((c) => c.command === command);
    // An owner call (atelier push --owner-port) is the developer's own and
    // is judged by the gateway case that refuses it to every other token.
    const credential = new Set(mine.filter((c) => c.credential !== "owner").map((c) => c.credential));
    assert.equal(credential.size, 1, `${command} is declared under more than one credential kind`);
    const allowed = [...credential][0] === "agent" ? agentRoute : runnerRoute;
    const sites = commandCalls(command);
    assert.ok(sites.length, `${command} makes no server call this check can see`);
    for (const site of sites) {
      const declared = byRoute(site.method, site.path);
      assert.ok(declared.length, `${site.where}: ${site.text} is not a call RUNNER_CALLS declares (src/tokens.ts)`);
      for (const c of declared) made.add(c.name);
      const fields = declared.flatMap((c) => c.body === "document" ? [] : c.body);
      for (const key of site.keys) assert.ok(fields.includes(key), `${site.where}: ${site.text} sends ${key}, which ${declared.map((c) => c.name).join("/")} does not declare`);
      // The path a command calls is one its credential may call. A route
      // declared for one command and called by another (finish and the rest
      // read the item, declared under finish) is judged by this command's
      // credential; base-token asks for a read scope, never a write one.
      const body = site.keys.includes("scope") ? { scope: "read" } : {};
      if (declared.every((c) => c.credential === "owner")) {
        assert.deepEqual([runnerRoute(site.method, callParts(declared[0]), body), agentRoute(site.method, callParts(declared[0]), body)], [false, false], `${site.where}: ${site.text} is an owner call a runner or agent token may make`);
        continue;
      }
      assert.equal(allowed(site.method, callParts(declared[0]), body), true, `${site.where}: ${site.text} is not allowed for a ${[...credential][0]} token`);
    }
    for (const c of mine) assert.ok(sites.some((s) => s.method === c.method && s.path === c.path), `${c.name} is declared as atelier ${command}'s call, which does not make it`);
  }
  assert.deepEqual([...made].sort(), CLI_CALLS.map((c) => c.name).sort(), "a declared cli call is made by no command the runner spawns");
});

// The call sites as a snippet writes them, with the transport imported as a
// command would.
const PRELUDE = 'import { call, request, postEvidence } from "../atelier.mjs";\n';
const snippetSites = (code) => callSitesIn(parseModule(PRELUDE + code, "cli/commands/x.mjs"), undefined, "x");

test("the source check reads call sites as the commands write them", () => {
  assert.equal(declaredPath("I(name, id)"), ITEM);
  assert.equal(declaredPath("I(name,id)"), ITEM);
  assert.equal(declaredPath("`${I(name, id)}/review-skip`"), `${ITEM}/review-skip`);
  assert.equal(declaredPath("`${I(name, id)}/sandbox/${encodeURIComponent(runId)}`"), `${ITEM}/sandbox/{run}`);
  assert.equal(declaredPath('"/runs"'), "/runs");
  assert.equal(declaredPath("P(name)"), "/projects/{project}");
  assert.equal(declaredPath("`${P(name)}/baseline-token`"), "/projects/{project}/baseline-token");
  assert.equal(declaredPath("`${P(name)}/items`"), null, "a path on another helper is not read, and fails the check");
  const keysOf = (code) => objectKeys(parseModule(`x(${code});`).sf.statements[0].expression.arguments[0]);
  assert.deepEqual(keysOf("{ head, ...(rebasedFrom ? { rebasedFrom } : {}) }"), ["head", "rebasedFrom"]);
  assert.deepEqual(keysOf('{ kind: "check", claim: cmd, head: ws.head, passed: r.passed, changedPaths: changed, outputTail: `${r.output.slice(-3500)}`, ...(mainHead ? { merged: true, mainHead } : {}) }'),
    ["kind", "claim", "head", "passed", "changedPaths", "outputTail", "merged", "mainHead"]);
  assert.deepEqual(keysOf("args.summary === undefined ? {} : { summary: args.summary }"), ["summary"]);
  assert.deepEqual(keysOf('{ approve: args.approve === true, note: args.note ?? "", head: args.head ?? d.item.head, ...(findings !== undefined ? { findings } : {}) }'), ["approve", "note", "head", "findings"]);
  assert.deepEqual(keysOf("{}"), []);
  assert.deepEqual(keysOf("body"), [], "a body that is not an object literal names no key");
  const sites = snippetSites('const r = await call("POST", `${I(name, id)}/claim`, {}, as, runner ? { "x-atelier-runner": runner } : {});\nawait request("GET", I(name,id), undefined, as);');
  assert.deepEqual(sites.map((s) => [s.method, s.path, s.keys]), [["POST", `${ITEM}/claim`, []], ["GET", ITEM, []]]);
  assert.deepEqual(snippetSites('await postEvidence(`${I(name, id)}/evidence`, { kind });').map((s) => [s.method, s.path, s.keys]), [["POST", `${ITEM}/evidence`, ["kind"]]]);
  // A call the table does not declare, or a field it does not name, fails.
  assert.throws(() => snippetSites('await call("POST", `${P(name)}/items`, { title }, as);'), /a path this check cannot read/);
  assert.throws(() => snippetSites('await call(verb, "/runs", {}, as);'), /whose method this check cannot read/);
  const [site] = snippetSites('await call("POST", `${I(name, id)}/release`, { note: "", secret: token }, as);');
  assert.deepEqual(site.keys, ["note", "secret"]);
  assert.equal(byRoute("POST", `${ITEM}/handoff`).length, 0, "handoff is no runner helper's call");
  assert.equal(byRoute("POST", `${ITEM}/release`)[0].body.includes("secret"), false);
  // The transport under another name is the transport: an import alias, a
  // plain alias, a destructured dynamic import.
  const aliased = (code) => callSitesIn(parseModule(code, "cli/commands/x.mjs"), undefined, "x").map((s) => [s.method, s.path]);
  assert.deepEqual(aliased('import { call as send } from "../atelier.mjs";\nawait send("POST", "/runs", {}, as);'), [["POST", "/runs"]]);
  assert.deepEqual(aliased('import { call } from "../atelier.mjs";\nconst send = call;\nawait send("POST", "/runs", {}, as);'), [["POST", "/runs"]]);
  assert.deepEqual(aliased('import { request } from "../atelier.mjs";\nlet go;\ngo = (request);\nawait go("GET", "/runs", undefined, as);'), [["GET", "/runs"]]);
  assert.deepEqual(aliased('const { postEvidence: post } = await import("../atelier.mjs");\nawait post("/runs", {});'), [["POST", "/runs"]]);
});

// The transport handed on where a call through it cannot be read is a leak.
test("the CLI's transport passed on, stored or returned instead of called fails the check", () => {
  for (const code of ['go(call);', 'const table = { send: call };', 'export { call };', 'const all = [request];', 'export default postEvidence;', 'const { send } = { send: call };']) {
    assert.throws(() => callSitesIn(parseModule(PRELUDE + code, "cli/commands/x.mjs"), undefined, "x"), /passes the CLI's transport \(call, request, postEvidence\) on/, code);
  }
});

// The capability check (t458) every spawned command makes before its
// handler: requireCapabilities reaches the server only through
// serverVersion, and each fetch serverVersion makes goes to a declared
// public preflight call's path (callPath(declaredCall(NAME))), never a
// literal URL. A fetch added there without a declaration fails here.
const PREFLIGHT = RUNNER_CALLS.filter((c) => c.via === "preflight");
function preflightFetches(input, root) {
  const names = [];
  for (const m of bareCalls(input, new Set(["serverFetch", "fetch"]), root)) {
    const url = m.args[0]?.getText().trim() ?? "";
    const named = /^server\(\) \+ "\/api" \+ callPath\(declaredCall\("([a-z-]+)"\)\)$/.exec(url);
    assert.ok(named, `serverVersion fetches ${url}, not a declared call's path`);
    assert.ok(PREFLIGHT.some((c) => c.name === named[1]), `serverVersion fetches ${named[1]}, which is not a declared preflight call`);
    names.push(named[1]);
  }
  return names;
}

test("the capability check every spawned command makes reads only a declared public preflight call", () => {
  assert.ok(PREFLIGHT.length, "the capability check's version read is not declared");
  for (const c of PREFLIGHT) assert.deepEqual([c.credential, c.method, c.body, c.command], ["public", "GET", [], undefined], `${c.name}: a preflight call is a public GET naming no command`);
  const version = exported("serverVersion"), check = exported("requireCapabilities");
  assert.ok(version && check, "serverVersion or requireCapabilities is gone from cli/atelier.mjs; update this check");
  assert.ok(namesIn(ATELIER, check).has("serverVersion"), "requireCapabilities no longer reads the version through serverVersion");
  assert.deepEqual(bypasses(ATELIER, check), [], "requireCapabilities reaches the server outside serverVersion");
  assert.deepEqual(callsTo(ATELIER, isAtelier, TRANSPORT, check).calls, [], "requireCapabilities reaches the server outside serverVersion");
  assert.deepEqual(callsTo(ATELIER, isAtelier, TRANSPORT, version).calls, [], "serverVersion makes a call through the authenticated transport");
  const made = preflightFetches(ATELIER, version);
  assert.ok(made.length, "serverVersion makes no fetch this check can see");
  assert.deepEqual([...new Set(made)].sort(), PREFLIGHT.map((c) => c.name).sort(), "a declared preflight call is made by no capability check");
  // A literal URL, or a name nobody declared, fails the check.
  assert.throws(() => preflightFetches('await serverFetch(server() + "/api/version", { signal });'), /not a declared call's path/);
  assert.throws(() => preflightFetches('await serverFetch(server() + "/api" + callPath(declaredCall("frobnicate")));'), /frobnicate, which is not a declared preflight call/);
  assert.deepEqual(preflightFetches('await serverFetch(server() + "/api" + callPath(declaredCall("capabilities")), { signal });'), ["capabilities"]);
});

// The files with a statement added at the top of a function of
// cli/atelier.mjs, for the mutation cases below.
function atelierWith(name, line) {
  const open = ATELIER.source.indexOf("{\n", ATELIER.declarations.get(name).node.getStart());
  assert.ok(open > 0, `${name} is gone from cli/atelier.mjs; update this check`);
  return withFiles({ [ATELIER_FILE]: `${ATELIER.source.slice(0, open + 2)}${line}\n${ATELIER.source.slice(open + 2)}` });
}
const claimWith = (extra, tree = {}) => withFiles({ "cli/commands/claim.mjs": `${read("cli/commands/claim.mjs")}\n${extra}\n`, ...tree });
const claimCalls = (extra, tree) => commandCalls("claim", claimWith(extra, tree));

// A helper the runner's commands reach is scanned for a bypass as the
// command's own module is: one it imports (claimWorkspace, which atelier
// claim runs) and one reached only through another (setWorkspaceIdentity,
// which claimWorkspace runs). A fetch added to either fails the check
// before any route is judged.
test("a helper a spawned command reaches fails the check when it bypasses the transport", () => {
  for (const name of ["claimWorkspace", "setWorkspaceIdentity", "workspacePath"]) assert.ok(ATELIER.declarations.has(name), `${name} is gone from cli/atelier.mjs; update this check`);
  const claimReaches = reachable(["actor", "args", "claimWorkspace", "itemArg", "project"]);
  assert.ok(claimReaches.includes("setWorkspaceIdentity"), "the walk does not follow claimWorkspace to the helpers it runs");
  assert.ok(!claimReaches.includes("call") && !claimReaches.includes("request"), "the walk follows the transport itself");
  assert.doesNotThrow(() => commandCalls("claim"));
  for (const name of ["claimWorkspace", "setWorkspaceIdentity"]) {
    assert.throws(() => commandCalls("claim", atelierWith(name, '  await fetch(server() + "/api/runners", { method: "POST" });')),
      new RegExp(`cli/atelier\\.mjs ${name}\\(\\) reaches the server outside the CLI's transport: fetch\\(`));
  }
  assert.throws(() => commandCalls("claim", atelierWith("claimWorkspace", '  const { request: send } = await import("node:https"); send(server());')), /import\("node:https"\)/);
  assert.throws(() => commandCalls("claim", atelierWith("claimWorkspace", "  const get = globalThis.fetch;")), /globalThis\.fetch/);
  assert.throws(() => commandCalls("claim", atelierWith("claimWorkspace", '  await serverFetch(server() + "/api/runners");')), /claimWorkspace\(\) reaches the server outside the CLI's transport: serverFetch\(/);
  assert.throws(() => commandCalls("claim", atelierWith("claimWorkspace", "  https.request(new URL(server()));")), /https\.request/);
  // A call through the transport from a helper reached only through another
  // is the command's own call, judged against the table like the rest.
  const site = commandCalls("claim", atelierWith("setWorkspaceIdentity", '  await call("GET", "/runners", undefined, as);')).find((s) => s.path === "/runners");
  assert.deepEqual(site && [site.where, site.method], ["cli/atelier.mjs setWorkspaceIdentity()", "GET"]);
  assert.equal(byRoute("GET", "/runners").length, 0, "the injected route is one the table does not declare");
  // The same through an alias of the transport inside cli/atelier.mjs.
  const aliasedSite = commandCalls("claim", atelierWith("setWorkspaceIdentity", '  const ask = call;\n  await ask("GET", "/runners", undefined, as);')).find((s) => s.path === "/runners");
  assert.deepEqual(aliasedSite && aliasedSite.method, "GET");
});

// The fifth-round reviewer's findings, in the shape of the forms they named.
// astra 1: a re-export of a network module, which binds no name but gives any
// importer a way to the network.
test("a re-export of a network module, in a command's module or in one it imports, is a bypass", () => {
  for (const line of ['export { request as send } from "node:https";', 'export * from "node:http";', 'export * as net from "node:https";', 'export { serverFetch } from "../server-fetch.mjs";']) {
    assert.throws(() => claimCalls(line), /export from "/, `in the command's module: ${line}`);
    assert.throws(() => claimCalls('import "../route-probe.mjs";', { "cli/route-probe.mjs": line.replace('"../server-fetch.mjs"', '"./server-fetch.mjs"') }), /cli\/route-probe\.mjs, imported by atelier claim, reaches the server outside the CLI's transport: export from "/, `in an imported module: ${line}`);
  }
  assert.deepEqual(bypasses('export { request as send } from "node:https";'), ['export from "node:https"']);
  assert.deepEqual(bypasses('export { x } from "./fine.mjs"; export * from "./also-fine.mjs";'), []);
  // The helper in cli/atelier.mjs the reviewer mutated: claim itself.
  assert.throws(() => commandCalls("claim", atelierWith("claimWorkspace", 'const { request: send } = await import("node:https");')), /import\("node:https"\)/);
});

// astra 2 for the runner's modules is in test/runner-routes.test.mjs. argon 2:
// aliased imports from cli/atelier.mjs, both the transport and the helpers.
test("aliased imports from cli/atelier.mjs, the transport or a helper, are followed in a command's module, in an imported one and in a fast helper", () => {
  const sitesOf = (extra, tree) => claimCalls(extra, tree).filter((s) => s.path === "/runs");
  // Transport aliases: the call is read under the name it is made by.
  assert.equal(sitesOf('import { call as send } from "../atelier.mjs";\nawait send("POST", "/runs", {}, as);').length, 1);
  assert.equal(sitesOf('import { request as ask } from "../atelier.mjs";\nawait ask("GET", "/runs", undefined, as);').length, 1);
  assert.equal(sitesOf('import { postEvidence as post } from "../atelier.mjs";\nawait post("/runs", {});').length, 1);
  assert.equal(sitesOf('import { call } from "../atelier.mjs";\nconst send = call;\nawait send("POST", "/runs", {}, as);').length, 1);
  assert.equal(sitesOf('const { call: send } = await import("../atelier.mjs");\nawait send("POST", "/runs", {}, as);').length, 1);
  assert.equal(sitesOf('import "../hop.mjs";', { "cli/hop.mjs": 'import { call as send } from "./atelier.mjs";\nexport const go = () => send("POST", "/runs", {}, as);' }).length, 1, "through a module");
  assert.equal(byRoute("POST", "/runs").length, 0, "the route is one the table does not declare, so the command check fails on each");
  assert.throws(() => claimCalls('import { call as send } from "../atelier.mjs";\nconsole.log(send);'), /passes the CLI's transport/, "an alias that is not called is a leak");
  // Helper aliases, from the command's module and from a module it imports.
  assert.throws(() => claimCalls('import { landingLease as lease } from "../atelier.mjs";\nawait lease("p");'), /landingLease\(\) reaches the server outside the CLI's transport: serverFetch\(/);
  assert.throws(() => claimCalls('import "../hop.mjs";', { "cli/hop.mjs": 'import { recordedApproval as approved } from "./atelier.mjs";\nexport const go = () => approved("p");' }), /recordedApproval\(\) reaches the server outside the CLI's transport/);
  assert.throws(() => claimCalls('import "../hop.mjs";', { "cli/hop.mjs": 'const { postAsRunner: report } = await import("./atelier.mjs");' }), /postAsRunner\(\) reaches the server outside the CLI's transport/);
  // The runner's part of fast: a helper alias in cli/fast.mjs, reached through
  // a function fastTake names, is the runner's; the owner's ownerOnly is not.
  const fastTree = (body) => withFiles({ "cli/fast.mjs": `import { landingLease as lease, postAsRunner as report } from "./atelier.mjs";\n${body}\nexport function ownerOnly() {\n  return report("/x", {});\n}\n` });
  assert.doesNotThrow(() => commandCalls("fast", fastTree("export function shellQuote(v) {\n  return `'${v}'`;\n}")), "the owner's ownerOnly, which the runner's part does not name, is not judged");
  assert.throws(() => commandCalls("fast", fastTree("export function shellQuote(v) {\n  return lease(v);\n}")), /cli\/atelier\.mjs landingLease\(\) reaches the server outside the CLI's transport: serverFetch\(/, "an aliased helper named by a function the runner's part reaches, one module down");
  assert.throws(() => commandCalls("fast", fastTree("export function shellQuote(v) {\n  return report(v);\n}")), /postAsRunner\(\)/);
  const viaAlias = commandCalls("fast", withFiles({ "cli/fast.mjs": 'import { call as send } from "./atelier.mjs";\nexport function shellQuote(v) {\n  return send("POST", "/runs", {}, v);\n}\n' }));
  assert.ok(viaAlias.some((s) => s.where === "cli/fast.mjs" && s.path === "/runs"), "an aliased transport call in a fast helper is a site to judge");
});

// A namespace, aliased or default import of the transport module (the second
// round), a dynamic import of it and a computed serverFetch member (the
// third), judged by the same scanner as a reach in any module a command imports.
test("a namespace, aliased, default or dynamic import of the transport is a bypass, in a command's module or in one it imports", () => {
  const tree = {
    "cli/commands/claim.mjs": 'import { thing } from "../helper.mjs";\nimport { call } from "../atelier.mjs";',
    "cli/helper.mjs": 'import { deeper } from "./deeper.mjs";',
    "cli/deeper.mjs": 'import * as transport from "./server-fetch.mjs";\nawait transport.serverFetch(server() + "/api/runners");',
    "cli/atelier.mjs": "", "cli/server-fetch.mjs": "",
  };
  const files = { read: (path) => tree[path], exists: (path) => path in tree };
  const modules = importClosure("cli/commands/claim.mjs", { files, stop: boundary });
  assert.deepEqual(modules, ["cli/helper.mjs", "cli/deeper.mjs"], "atelier.mjs and the transport are not followed; every other cli module is");
  assert.deepEqual(modules.filter((m) => bypasses(parseModule(tree[m], m)).length), ["cli/deeper.mjs"]);
  for (const probe of ['import * as transport from "../server-fetch.mjs";\nawait transport.serverFetch(u);', 'import { serverFetch as send } from "../server-fetch.mjs";\nawait send(u);', 'import send from "../server-fetch.mjs";', 'const transport = await import("../server-fetch.mjs");\nawait transport["serverFetch"](u);', 'const send = transport?.serverFetch;']) {
    assert.throws(() => claimCalls(probe), /reaches the server outside the CLI's transport/, probe);
    assert.throws(() => claimCalls('import "../route-probe.mjs";', { "cli/route-probe.mjs": probe.replace("../server-fetch", "./server-fetch") }), /cli\/route-probe\.mjs, imported by atelier claim/, probe);
  }
  // A helper a command imports only dynamically is followed too.
  assert.throws(() => claimCalls('const { go } = await import("../helper.mjs");', { "cli/helper.mjs": 'await fetch(server() + "/api/runners");' }), /cli\/helper\.mjs, imported by atelier claim, reaches the server outside the CLI's transport: fetch\(/);
});

test("the capability check keeps serverVersion's preflight read and nothing else", () => {
  assert.deepEqual(helperCalls("serverVersion"), []);
  assert.throws(() => helperCalls("serverVersion", atelierOf(atelierWith("serverVersion", '  await fetch(server() + "/api/runners");'))), /not a declared call's path/);
  assert.throws(() => helperCalls("serverVersion", atelierOf(atelierWith("serverVersion", "  http.get(server());"))), /http\.get/);
});

// The fourth-round reviewer's first finding (astra): the traversal followed
// only imports with `from` and literal dynamic imports, only for .mjs under
// cli/, so a side-effect import and a TypeScript module escaped the scan.
test("a side-effect import and an imported TypeScript module are followed and scanned", () => {
  assert.doesNotThrow(() => claimCalls("", {}));
  const sideEffect = (probe) => claimCalls('import "../route-probe.mjs";', { "cli/route-probe.mjs": probe });
  assert.throws(() => sideEffect('await fetch("https://atelier.test/api/runners");'), /cli\/route-probe\.mjs, imported by atelier claim, reaches the server outside the CLI's transport: fetch\(/);
  const ts = (specifier, module) => claimCalls(`import { audit } from "${specifier}";\nawait audit();`, { [module]: 'export async function audit() { await fetch("https://atelier.test/api/runners"); }' });
  assert.throws(() => ts("../../src/route-probe.ts", "src/route-probe.ts"), /src\/route-probe\.ts, imported by atelier claim, reaches the server outside the CLI's transport: fetch\(/);
  assert.throws(() => ts("../../src/route-probe.js", "src/route-probe.ts"), /src\/route-probe\.ts, imported by atelier claim/, "a .js specifier names a .ts file");
  assert.throws(() => ts("../../src/route-probe", "src/route-probe.ts"), /src\/route-probe\.ts, imported by atelier claim/, "an extensionless specifier");
  // Reached through a TypeScript module in turn.
  assert.throws(() => claimCalls('import "../hop.mjs";', { "cli/hop.mjs": 'import "../src/deeper.ts";', "src/deeper.ts": "export const go = () => globalThis.fetch(url);" }), /src\/deeper\.ts, imported by atelier claim.*globalThis\.fetch/);
  // And a call through the transport in a side-effect module is a site to judge.
  const [site] = claimCalls('import "../route-probe.mjs";', { "cli/route-probe.mjs": 'import { call } from "./atelier.mjs";\nawait call("POST", "/runners", {}, as);' }).filter((s) => s.where === "cli/route-probe.mjs");
  assert.deepEqual(site && [site.method, site.path], ["POST", "/runners"]);
  assert.equal(byRoute("POST", "/runners").length, 0, "the probe's route is one the table does not declare, so the command check fails on it");
});

// The fourth-round reviewer's second finding (argon 1), and the fifth
// round's: helpers of cli/atelier.mjs that send to the server themselves skip
// request(), so no declaration judges them. Each refuses a spawned helper
// before it fetches, whatever route it names, and no spawned command reaches
// one, aliased, through a namespace or through a module.
const CLASSIFIED = {
  request: "the transport: declaredHelperCall judges every call",
  serverVersion: "the declared public preflight read, judged by preflightFetches",
};
// How each owner-only fetching helper is called in the runtime case below,
// naming a route a declaration does cover, so a refusal is the helper's own.
const ATTEMPTS = {
  requestText: () => ["/projects/p"],
  recordedApproval: () => ["p"],
  landingLease: () => ["p", "test/actor"],
  postAsRunner: () => ["/projects/p/items/t1/claim", {}, "home:r", new AbortController().signal],
};
const SPAWNED_ARGV = (command) => (command === "fast" ? ["fast", "take"] : [command]);

test("every helper of cli/atelier.mjs that sends to the server itself refuses a spawned helper before it fetches, and no spawned command reaches one", async (t) => {
  const users = [...ATELIER.declarations].filter(([, d]) => references(ATELIER, d.node).some((r) => r.text === "serverFetch(")).map(([name]) => name).sort();
  const raw = users.filter((name) => !(name in CLASSIFIED));
  assert.deepEqual(raw, Object.keys(ATTEMPTS).sort(), "a helper of cli/atelier.mjs calls serverFetch outside the classified ones; route it through request, or make it refuse a spawned helper (refuseSpawnedHelper) and list it in ATTEMPTS here");
  for (const name of Object.keys(CLASSIFIED)) assert.ok(users.includes(name), `${name} no longer calls serverFetch; update CLASSIFIED`);
  for (const name of raw) {
    const node = ATELIER.declarations.get(name).node;
    // The first statement refuses; nothing, not even the identity read,
    // comes before it, and declaredHelperCall (which a declared GET passes)
    // is not what stands guard.
    assert.equal(node.body.statements[0].getText(), `refuseSpawnedHelper("${name}");`, `${name} must refuse a spawned helper in its first statement`);
    assert.equal(namesIn(ATELIER, node).has("declaredHelperCall"), false, `${name} judges a spawned helper by declaredHelperCall, which a declared route passes`);
    // No spawned command reaches it, directly, aliased or through a module.
    for (const command of RUNNER_COMMANDS) {
      const { names } = commandFacts(command);
      assert.equal(names.includes(name), false, `atelier ${command} reaches ${name}, an owner-only helper that sends to the server itself`);
    }
  }
  // refuseSpawnedHelper itself refuses unconditionally under a spawned helper.
  const guard = exported("refuseSpawnedHelper") ?? ATELIER.declarations.get("refuseSpawnedHelper").node;
  assert.ok(/if \(runnerHelper\(\)\) throw new Error\(/.test(guard.getText()), "refuseSpawnedHelper must throw for a spawned helper, not judge it");
  // At run time, for every command the runner spawns and every such helper.
  const before = args._, login = cliState.loginToken, server = cliState.loginServer;
  t.after(() => { args._ = before; cliState.loginToken = login; cliState.loginServer = server; });
  cliState.loginToken = "fixture-owner";
  cliState.loginServer = "https://atelier.test";
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url, method: init?.method });
    return Response.json({ ok: true, project: {}, lease: null });
  });
  const atelier = await import("../cli/atelier.mjs");
  for (const command of RUNNER_COMMANDS) {
    args._ = SPAWNED_ARGV(command);
    for (const name of Object.keys(ATTEMPTS)) {
      await assert.rejects(atelier[name](...ATTEMPTS[name]()), /not a call the runner helpers declare/, `atelier ${command}: ${name}`);
    }
  }
  assert.equal(sent.length, 0, "a spawned helper's raw read or report is refused before anything is sent, the identity read included");
  // The owner's commands keep them.
  args._ = ["land"];
  await atelier.recordedApproval("p");
  await atelier.landingLease("p", "test/actor");
  await atelier.requestText("/projects/p/items/t1/logs/abc");
  await atelier.postAsRunner("/models/m/status", {}, "home:r", new AbortController().signal);
  assert.ok(sent.some((r) => r.url.endsWith("/models/m/status")) && sent.some((r) => r.url.endsWith("/landing-lease")) && sent.some((r) => r.url.endsWith("/projects/p")), "the owner's land reaches the server");
});

test("a spawned command that reaches an owner-only helper, aliased or through a namespace or a module, fails the check", () => {
  for (const name of Object.keys(ATTEMPTS)) {
    assert.throws(() => claimCalls(`import { ${name} as send } from "../atelier.mjs";\nawait send("/x");`), /cli\/atelier\.mjs \w+\(\) reaches the server outside the CLI's transport: serverFetch\(/, `${name}, aliased`);
    assert.throws(() => claimCalls('import "../hop.mjs";', { "cli/hop.mjs": `import { ${name} } from "./atelier.mjs";\nawait ${name}("/x");` }), /reaches the server outside the CLI's transport: serverFetch\(/, `${name}, through a module`);
  }
  assert.throws(() => claimCalls("import { requestText } from '../atelier.mjs';"), /serverFetch\(/, "a single-quoted second import of atelier.mjs");
  assert.throws(() => claimCalls('import * as atelier from "../atelier.mjs";\nawait atelier.postAsRunner("/x");'), /imports cli\/atelier\.mjs as a namespace/);
  assert.throws(() => claimCalls('const { requestText } = await import("../atelier.mjs");'), /serverFetch\(/);
  assert.throws(() => claimCalls('const atelier = await import("../atelier.mjs");'), /imports cli\/atelier\.mjs as a namespace, a default or dynamically/);
  assert.throws(() => claimCalls('import "../hop.mjs";', { "cli/hop.mjs": 'import atelier from "./atelier.mjs";' }), /cli\/hop\.mjs imports cli\/atelier\.mjs as a namespace, a default/);
  assert.throws(() => claimCalls('export { landingLease } from "../atelier.mjs";'), /serverFetch\(/, "a re-export");
});

// The fourth-round reviewer's third finding (argon 2): call sites in the
// modules a command imports were never extracted, and a RUNNER_PART command
// dropped the atelier.mjs helpers its modules name.
test("a call in an imported module is a site to judge, and a fast helper reached through a module is followed", () => {
  // Two modules down, in a module the command imports only for its effect.
  const tree = { "cli/helper.mjs": 'import { go } from "./deeper.mjs";\nexport { go };', "cli/deeper.mjs": 'import { call } from "./atelier.mjs";\nexport const go = () => call("POST", "/runners", { title }, as);' };
  const sites = claimCalls('import { go } from "../helper.mjs";\nawait go();', tree).filter((s) => s.where === "cli/deeper.mjs");
  assert.deepEqual(sites.map((s) => [s.method, s.path, s.keys]), [["POST", "/runners", ["title"]]]);
  assert.equal(byRoute("POST", "/runners").length, 0, "no declaration matches it, so the command check fails");
  // request and postEvidence count as call does.
  assert.deepEqual(claimCalls('import "../deeper.mjs";', { "cli/deeper.mjs": 'import { request, postEvidence } from "./atelier.mjs";\nawait request("GET", "/runners", undefined, as); await postEvidence("/runners", {});' }).filter((s) => s.where === "cli/deeper.mjs").map((s) => s.method), ["GET", "POST"]);
  // An undeclared body field in a module is read as the command's own are.
  const [field] = claimCalls('import "../deeper.mjs";', { "cli/deeper.mjs": 'import { call } from "./atelier.mjs";\nawait call("POST", `${I(name, id)}/claim`, { secret }, as);' }).filter((s) => s.where === "cli/deeper.mjs");
  assert.deepEqual(field.keys, ["secret"]);
  assert.equal(byRoute("POST", `${ITEM}/claim`)[0].body.includes("secret"), false);
  // fast: only fast take and fast ready are the runner's, so a module it
  // imports is judged by the functions the runner's part names. A helper of
  // atelier.mjs such a function reaches through that module is followed ...
  const fastTree = (body) => withFiles({ "cli/fast.mjs": `import { call, landingLease, postAsRunner } from "./atelier.mjs";\n${body}\nexport function ownerOnly() {\n  return postAsRunner("/x", {});\n}\n` });
  const fast = (body) => commandCalls("fast", fastTree(body));
  assert.doesNotThrow(() => fast("export function shellQuote(v) {\n  return `'${v}'`;\n}"), "the owner's ownerOnly, which the runner's part does not name, is not judged");
  assert.throws(() => fast("export function shellQuote(v) {\n  return landingLease(v);\n}"), /cli\/atelier\.mjs landingLease\(\) reaches the server outside the CLI's transport: serverFetch\(/, "a helper named by a function the runner's part reaches, one module down");
  // ... and so is a call through the transport there.
  const viaCall = commandCalls("fast", fastTree('export function shellQuote(v) {\n  return call("POST", "/runners", {}, v);\n}'));
  assert.ok(viaCall.some((s) => s.where === "cli/fast.mjs" && s.path === "/runners"));
  // A function the runner's part never names is the owner's and is not judged.
  assert.ok(!viaCall.some((s) => s.text.includes("/x")));
  // A re-export hop and a namespace import between the runner's part and the helper.
  const hop = (head) => withFiles({ "cli/fast.mjs": 'export * from "./fast-more.mjs";', "cli/fast-more.mjs": 'import { landingLease } from "./atelier.mjs";\nexport function shellQuote(v) {\n  return landingLease(v);\n}\n', ...head });
  assert.throws(() => commandCalls("fast", hop({})), /landingLease\(\) reaches the server/);
});
