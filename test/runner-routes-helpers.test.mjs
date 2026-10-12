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
//   http(s) request or a socket in a command's module, or in any helper of
//   cli/atelier.mjs it reaches (imported, or named by one it reaches), is a
//   bypass and fails here, save serverVersion's declared preflight read
//   (the scanner is test/runner-routes-scan.test.mjs, shared with the
//   runner's own modules);
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
//   declaration nothing sends is dropped rather than kept as a spare door.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { agentRoute, callParts, RUNNER_CALLS, RUNNER_COMMANDS, runnerRoute } from "../src/tokens.ts";
// The bypass scanner this file shares with test/runner-routes.test.mjs, which
// applies the same one to the runner's own modules.
import { bypasses, codeOnly } from "./runner-routes-scan.test.mjs";

const read = (path) => readFileSync(resolve(path), "utf8");
const ATELIER = read("cli/atelier.mjs");
const ITEM = "/projects/{project}/items/{item}";
const KEYWORDS = new Set(["true", "false", "null", "undefined"]);
// The CLI's transport: the functions a command calls to reach the server,
// which are followed to no further call site of their own.
const TRANSPORT = new Set(["call", "request", "postEvidence"]);

// The body of an exported function of cli/atelier.mjs: from its declaration
// to the first line that is its closing brace alone.
function exported(name) {
  const start = ATELIER.search(new RegExp(`^export (?:async )?function ${name}\\(`, "m"));
  if (start < 0) return null;
  const end = ATELIER.indexOf("\n}\n", start);
  return ATELIER.slice(start, end < 0 ? undefined : end + 2);
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

// The argument list of a call starting at `open` (the index of its "("),
// split at top-level commas; strings and templates are kept whole.
function argumentsOf(source, open) {
  const parts = [];
  let depth = 0, quote = null, start = open + 1;
  for (let i = open + 1; i < source.length; i++) {
    const ch = source[i];
    if (quote) { if (ch === "\\") i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      if (depth === 0) { parts.push(source.slice(start, i)); return parts; }
      depth--;
    } else if (ch === "," && depth === 0) { parts.push(source.slice(start, i)); start = i + 1; }
  }
  throw new Error("an unbalanced call");
}

// The top-level and conditional property names an object-literal body sends:
// an identifier after "{" or "," and before ":", "," or "}", once strings and
// templates are blanked, so `head: ws.head`, `{ note }` and
// `...(x ? { merged: true, mainHead } : {})` yield head, note, merged and
// mainHead, and a value's identifiers yield nothing.
function bodyKeys(text) {
  const blank = text.replace(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  const keys = new Set();
  for (const m of blank.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*(?=[:,}])/g)) if (!KEYWORDS.has(m[1])) keys.add(m[1]);
  return [...keys];
}

// Every server call a source makes: through `call`, `request` or
// postEvidence, with the method, the path as declared, and the body's keys
// (null for a body that is not an object literal or a conditional on one).
function callSites(source, where) {
  const sites = [];
  for (const m of source.matchAll(/(?<![.\w])(call|request|postEvidence)\(/g)) {
    const args = argumentsOf(source, m.index + m[0].length - 1);
    const [method, path, body] = m[1] === "postEvidence" ? ["POST", args[0], args[1]] : [args[0].trim().replace(/^"|"$/g, ""), args[1], args[2]];
    const declared = declaredPath(path);
    assert.ok(declared, `${where}: a server call to a path this check cannot read: ${path.trim()}`);
    const keys = body === undefined || body.trim() === "undefined" ? [] : bodyKeys(body);
    sites.push({ where, method, path: declared, keys, text: `${method} ${path.trim()}` });
  }
  return sites;
}

// The top-level declarations of cli/atelier.mjs, by name: a function from
// its declaration to the first line that is its closing brace alone, a const
// or let to the next line that starts at the margin with neither a closing
// bracket nor whitespace.
function declarations(source) {
  const decls = new Map();
  for (const m of source.matchAll(/^(?:export )?(?:async )?(?:function\*? ([A-Za-z_$][\w$]*)\(|(?:const|let) ([A-Za-z_$][\w$]*) =)/gm)) {
    const name = m[1] ?? m[2];
    let end;
    if (m[1]) { end = source.indexOf("\n}\n", m.index); end = end < 0 ? source.length : end + 2; }
    else { const rest = /\n(?![\s})\]])/.exec(source.slice(m.index + 1)); end = rest ? m.index + 1 + rest.index : source.length; }
    if (!decls.has(name)) decls.set(name, source.slice(m.index, end));
  }
  return decls;
}
const DECLS = declarations(ATELIER);

// The helpers of cli/atelier.mjs a command reaches: those it imports, and
// every top-level declaration any of them names, transitively. The
// transport itself is not followed: its fetch is the one the CLI makes.
function reachable(names, decls = DECLS) {
  const seen = new Set(), queue = names.filter((n) => decls.has(n) && !TRANSPORT.has(n));
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const code = codeOnly(decls.get(name));
    for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\b/g)) {
      if (m[1] !== name && decls.has(m[1]) && !TRANSPORT.has(m[1]) && !seen.has(m[1])) queue.push(m[1]);
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

// The server calls a helper body makes, failing on any bypass of the
// transport. serverVersion is the one helper that fetches: its fetch is the
// declared public preflight read, judged by preflightFetches below, and any
// other bypass in it still fails.
function helperCalls(name, body) {
  const where = `cli/atelier.mjs ${name}()`;
  const found = bypasses(body);
  if (name === "serverVersion") {
    preflightFetches(body);
    const others = found.filter((b) => b !== "fetch(");
    assert.deepEqual(others, [], `${where} reaches the server outside the CLI's transport: ${others.join(", ")}`);
  } else {
    assert.deepEqual(found, [], `${where} reaches the server outside the CLI's transport: ${found.join(", ")}`);
  }
  const sites = /(?<![.\w])(call|request|postEvidence)\(/.test(codeOnly(body)) ? callSites(body, where) : [];
  return name === "resolveTokenActor" ? identityRead(sites, where) : sites;
}

// The calls a command makes: its module's own, and those of every helper of
// cli/atelier.mjs it reaches, each scanned for a bypass of the transport.
function commandCalls(command, decls = DECLS) {
  const file = `cli/commands/${command}.mjs`;
  assert.ok(existsSync(resolve(file)), `${command} is declared with no module at ${file}`);
  const source = read(file);
  const own = bypasses(source);
  assert.deepEqual(own, [], `${file} reaches the server outside the CLI's transport: ${own.join(", ")}`);
  const sites = callSites(source, file);
  const imports = /import \{([^}]*)\} from "\.\.\/atelier\.mjs"/.exec(source);
  const names = (imports?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const name of reachable(names, decls)) sites.push(...helperCalls(name, decls.get(name)));
  return sites;
}

const CLI_CALLS = RUNNER_CALLS.filter((c) => c.via === "cli");
const byRoute = (method, path) => CLI_CALLS.filter((c) => c.method === method && c.path === path);

test("the commands the runner spawns reach the server through the CLI's transport, on declared routes, with declared bodies", () => {
  const made = new Set();
  for (const command of RUNNER_COMMANDS) {
    const mine = CLI_CALLS.filter((c) => c.command === command);
    const credential = new Set(mine.map((c) => c.credential));
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
      assert.equal(allowed(site.method, callParts(declared[0]), body), true, `${site.where}: ${site.text} is not allowed for a ${[...credential][0]} token`);
    }
    for (const c of mine) assert.ok(sites.some((s) => s.method === c.method && s.path === c.path), `${c.name} is declared as atelier ${command}'s call, which does not make it`);
  }
  assert.deepEqual([...made].sort(), CLI_CALLS.map((c) => c.name).sort(), "a declared cli call is made by no command the runner spawns");
});

test("the source check reads call sites as the commands write them", () => {
  assert.equal(declaredPath("I(name, id)"), ITEM);
  assert.equal(declaredPath("I(name,id)"), ITEM);
  assert.equal(declaredPath("`${I(name, id)}/review-skip`"), `${ITEM}/review-skip`);
  assert.equal(declaredPath("`${I(name, id)}/sandbox/${encodeURIComponent(runId)}`"), `${ITEM}/sandbox/{run}`);
  assert.equal(declaredPath('"/runs"'), "/runs");
  assert.equal(declaredPath("P(name)"), "/projects/{project}");
  assert.equal(declaredPath("`${P(name)}/baseline-token`"), "/projects/{project}/baseline-token");
  assert.equal(declaredPath("`${P(name)}/items`"), null, "a path on another helper is not read, and fails the check");
  assert.deepEqual(bodyKeys('{ head, ...(rebasedFrom ? { rebasedFrom } : {}) }'), ["head", "rebasedFrom"]);
  assert.deepEqual(bodyKeys('{ kind: "check", claim: cmd, head: ws.head, passed: r.passed, changedPaths: changed, outputTail: `${r.output.slice(-3500)}`, ...(mainHead ? { merged: true, mainHead } : {}) }'),
    ["kind", "claim", "head", "passed", "changedPaths", "outputTail", "merged", "mainHead"]);
  assert.deepEqual(bodyKeys('args.summary === undefined ? {} : { summary: args.summary }'), ["summary"]);
  assert.deepEqual(bodyKeys('{ approve: args.approve === true, note: args.note ?? "", head: args.head ?? d.item.head, ...(findings !== undefined ? { findings } : {}) }'), ["approve", "note", "head", "findings"]);
  assert.deepEqual(bodyKeys("{}"), []);
  const sites = callSites('const r = await call("POST", `${I(name, id)}/claim`, {}, as, runner ? { "x-atelier-runner": runner } : {});\nawait request("GET", I(name,id), undefined, as);', "x");
  assert.deepEqual(sites.map((s) => [s.method, s.path, s.keys]), [["POST", `${ITEM}/claim`, []], ["GET", ITEM, []]]);
  // A call the table does not declare, or a field it does not name, fails.
  assert.throws(() => callSites('await call("POST", `${P(name)}/items`, { title }, as);', "x"), /a path this check cannot read/);
  const [site] = callSites('await call("POST", `${I(name, id)}/release`, { note: "", secret: token }, as);', "x");
  assert.deepEqual(site.keys, ["note", "secret"]);
  assert.equal(byRoute("POST", `${ITEM}/handoff`).length, 0, "handoff is no runner helper's call");
  assert.equal(byRoute("POST", `${ITEM}/release`)[0].body.includes("secret"), false);
});

// The capability check (t458) every spawned command makes before its
// handler: requireCapabilities reaches the server only through
// serverVersion, and each fetch serverVersion makes goes to a declared
// public preflight call's path (callPath(declaredCall(NAME))), never a
// literal URL. A fetch added there without a declaration fails here.
const PREFLIGHT = RUNNER_CALLS.filter((c) => c.via === "preflight");
function preflightFetches(source) {
  const names = [];
  for (const m of source.matchAll(/(?<![.\w])fetch\(/g)) {
    const [url] = argumentsOf(source, m.index + m[0].length - 1);
    const named = /^server\(\) \+ "\/api" \+ callPath\(declaredCall\("([a-z-]+)"\)\)$/.exec(url.trim());
    assert.ok(named, `serverVersion fetches ${url.trim()}, not a declared call's path`);
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
  assert.match(check, /(?<![.\w])serverVersion\(\)/, "requireCapabilities no longer reads the version through serverVersion");
  for (const bypass of [/(?<![.\w])fetch\(/, /(?<![.\w])(call|request)\(/]) assert.doesNotMatch(check, bypass, "requireCapabilities reaches the server outside serverVersion");
  assert.doesNotMatch(version, /(?<![.\w])(call|request)\(/, "serverVersion makes a call through the authenticated transport");
  const made = preflightFetches(version);
  assert.ok(made.length, "serverVersion makes no fetch this check can see");
  assert.deepEqual([...new Set(made)].sort(), PREFLIGHT.map((c) => c.name).sort(), "a declared preflight call is made by no capability check");
  // A literal URL, or a name nobody declared, fails the check.
  assert.throws(() => preflightFetches('await fetch(server() + "/api/version", { signal });'), /not a declared call's path/);
  assert.throws(() => preflightFetches('await fetch(server() + "/api" + callPath(declaredCall("frobnicate")));'), /frobnicate, which is not a declared preflight call/);
  assert.deepEqual(preflightFetches('await fetch(server() + "/api" + callPath(declaredCall("capabilities")), { signal });'), ["capabilities"]);
});

// A helper the runner's commands reach is scanned for a bypass as the
// command's own module is: one it imports (claimWorkspace, which atelier
// claim runs) and one reached only through another (setWorkspaceIdentity,
// which claimWorkspace runs). A fetch added to either fails the check
// before any route is judged.
test("a helper a spawned command reaches fails the check when it bypasses the transport", () => {
  for (const name of ["claimWorkspace", "setWorkspaceIdentity", "workspacePath"]) assert.ok(DECLS.has(name), `${name} is gone from cli/atelier.mjs; update this check`);
  const claimReaches = reachable(["actor", "args", "claimWorkspace", "itemArg", "project"]);
  assert.ok(claimReaches.includes("setWorkspaceIdentity"), "the walk does not follow claimWorkspace to the helpers it runs");
  assert.ok(!claimReaches.includes("call") && !claimReaches.includes("request"), "the walk follows the transport itself");
  assert.doesNotThrow(() => commandCalls("claim"));
  const injected = (name, line) => {
    const decls = new Map(DECLS), body = decls.get(name);
    decls.set(name, body.replace(/\{\n/, `{\n${line}\n`));
    return decls;
  };
  for (const name of ["claimWorkspace", "setWorkspaceIdentity"]) {
    assert.throws(() => commandCalls("claim", injected(name, '  await fetch(server() + "/api/runners", { method: "POST" });')),
      new RegExp(`cli/atelier\\.mjs ${name}\\(\\) reaches the server outside the CLI's transport: fetch\\(`));
  }
  assert.throws(() => commandCalls("claim", injected("claimWorkspace", '  const { request: send } = await import("node:https"); send(server());')), /import\("node:https"\)/);
  assert.throws(() => commandCalls("claim", injected("claimWorkspace", "  const get = globalThis.fetch;")), /globalThis\.fetch/);
  assert.throws(() => commandCalls("claim", injected("claimWorkspace", "  https.request(new URL(server()));")), /https\.request/);
  // A call through the transport from a helper reached only through another
  // is the command's own call, judged against the table like the rest.
  const site = commandCalls("claim", injected("setWorkspaceIdentity", '  await call("GET", "/runners", undefined, as);')).find((s) => s.path === "/runners");
  assert.deepEqual(site && [site.where, site.method], ["cli/atelier.mjs setWorkspaceIdentity()", "GET"]);
  assert.equal(byRoute("GET", "/runners").length, 0, "the injected route is one the table does not declare");
});

test("the bypass scan reads code, not strings or comments", () => {
  assert.deepEqual(bypasses('git(["fetch", "--quiet", "origin"]); // a fetch( in a comment\nconsole.log(`run git fetch first, then ${count(n, "fetch")}`); /* fetch( */'), []);
  assert.deepEqual(bypasses("const ok = /fetch\\(/.test(text);"), []);
  assert.deepEqual(bypasses('console.log(`${await fetch(url)}`);'), ["fetch("]);
  assert.deepEqual(bypasses('import { request } from "node:http";'), ['import from "node:http"']);
  assert.deepEqual(bypasses("const go = fetch;"), ["fetch;"]);
  assert.deepEqual(bypasses("new WebSocket(url);"), ["new WebSocket("]);
  // serverVersion keeps its declared preflight read, and nothing else.
  assert.deepEqual(helperCalls("serverVersion", DECLS.get("serverVersion")), []);
  assert.throws(() => helperCalls("serverVersion", DECLS.get("serverVersion").replace(/\{\n/, '{\n  await fetch(server() + "/api/runners");\n')), /not a declared call's path/);
  assert.throws(() => helperCalls("serverVersion", DECLS.get("serverVersion").replace(/\{\n/, "{\n  http.get(server());\n")), /http\.get/);
});
