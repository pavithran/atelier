// The helpers the runner spawns make only the calls RUNNER_CALLS declares,
// checked against their source (t478). test/runner-routes.test.mjs holds
// the runner's own calls to runnerTransport and exercises every declared
// call through the real gateway; this file reads the atelier commands the
// runner spawns as children (claim, finish, check, release and the rest,
// `via: "cli"` in src/tokens.ts) and the helpers in cli/atelier.mjs they
// import, and judges each server call they make against the table:
//
// - every call goes through the CLI's shared transport, `call` or `request`
//   in cli/atelier.mjs (postEvidence wraps `request`); a bare fetch in a
//   helper command is a bypass and fails here;
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
// {run}, and a plain string is itself.
function declaredPath(expr) {
  const text = expr.trim();
  if (/^I\(\s*name\s*,\s*id\s*\)$/.test(text)) return ITEM;
  const template = /^`\$\{I\(\s*name\s*,\s*id\s*\)\}((?:\/[a-z-]+)*)(\/\$\{encodeURIComponent\(runId\)\})?`$/.exec(text);
  if (template) return `${ITEM}${template[1]}${template[2] ? "/{run}" : ""}`;
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

// The calls a command makes: its module's own, and those of each helper it
// imports from cli/atelier.mjs that makes a server call itself.
function commandCalls(command) {
  const file = `cli/commands/${command}.mjs`;
  assert.ok(existsSync(resolve(file)), `${command} is declared with no module at ${file}`);
  const source = read(file);
  assert.equal(source.match(/(?<![.\w])fetch\(/g), null, `${file} calls fetch itself, bypassing the CLI's transport`);
  const sites = callSites(source, file);
  const imports = /import \{([^}]*)\} from "\.\.\/atelier\.mjs"/.exec(source);
  for (const name of (imports?.[1] ?? "").split(",").map((s) => s.trim()).filter((s) => s && !TRANSPORT.has(s))) {
    const body = exported(name);
    if (body && /(?<![.\w])(call|request)\(/.test(body)) sites.push(...callSites(body, `cli/atelier.mjs ${name}()`));
  }
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
