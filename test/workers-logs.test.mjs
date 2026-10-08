import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The compiler's own reader. The project's `typescript` is the native (Go)
// build without a JavaScript parse API, so the classic compiler is pinned
// under the typescript5 alias for this scan.
import ts from "typescript5";

const root = fileURLToPath(new URL("..", import.meta.url));

// wrangler.jsonc as JSON, its comments removed. Comments are cut only
// outside strings, so a // inside a value survives.
function withoutComments(text) {
  let out = "", quote = null, escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      out += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c; out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out;
}

test("the Worker writes Workers Logs: observability is enabled in wrangler.jsonc", () => {
  const config = JSON.parse(withoutComments(readFileSync(join(root, "wrangler.jsonc"), "utf8")));
  assert.equal(config.observability?.enabled, true, "wrangler.jsonc must keep observability.enabled true for Workers Logs");
  const rate = config.observability?.head_sampling_rate;
  assert.ok(rate === undefined || (rate >= 0 && rate <= 1), "head_sampling_rate, when set, is between 0 and 1");
});

test("the handbook says how a session queries the logs", () => {
  const md = readFileSync(join(root, "docs/orchestrating.md"), "utf8");
  assert.match(md, /## Reading the server's logs/, "docs/orchestrating.md keeps the section");
  assert.match(md, /Observability/, "it names the dashboard's Observability view");
  assert.match(md, /wrangler tail/, "it names wrangler tail for what is live");
});

// Every console.<method> call in a source file, as the TypeScript compiler
// reads it: the AST is walked for calls on console, whatever the method
// (log, error, warn, info, debug, trace, dir, ...), so quotes, template
// literals, nested calls and comments are split the way the compiler
// splits them, not by a hand-written scan.
function consoleCalls(source, fileName = "scan.ts") {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const calls = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "console"
    ) {
      calls.push({
        arguments: [...node.arguments],
        text: node.getText(file),
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      });
    }
    node.forEachChild(visit);
  };
  visit(file);
  return calls;
}

// The names a call prints: every identifier its arguments mention, as the
// compiler sees them. A string literal prints only itself, and so does the
// fixed text of a template literal, leaving only its ${...} interpolations;
// a comment is not part of any expression at all.
function printedNames(expression) {
  const names = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) names.push(node.text);
    node.forEachChild(visit);
  };
  visit(expression);
  return names;
}

// What may never be named in a console call's expressions. A bearer token,
// a cookie, a secret, or any object holding one (env, a request, its
// headers) would land in the account's Workers Logs and stay there.
const FORBIDDEN = /token|secret|bearer|authoriz|authoris|cookie|password|passphrase|credential|api_?key|plaintext|session/i;
// Names the pattern trips that are not credentials: model usage counts,
// the session TTL, a session's id, a service's URL.
const ALLOWED = new Set(["tokensIn", "tokensOut", "SESSION_SECONDS", "session_id", "api_url"]);

// One line per console call in the source that names a forbidden term
// among what it prints.
function leaksIn(fileName, source) {
  const leaks = [];
  for (const call of consoleCalls(source, fileName)) {
    for (const name of call.arguments.flatMap(printedNames)) {
      if (!ALLOWED.has(name) && FORBIDDEN.test(name)) {
        leaks.push(`${fileName}:${call.line} logs ${name} (${call.text})`);
      }
    }
  }
  return leaks;
}

function tsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? tsFiles(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}

test("no console call in src logs a token or a key", () => {
  const files = tsFiles(join(root, "src"));
  let found = 0;
  const leaks = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    found += consoleCalls(source, file).length;
    leaks.push(...leaksIn(file.slice(root.length + 1), source));
  }
  // The scan must see the Worker's calls; a silent match of nothing would
  // pass an empty check.
  assert.ok(found >= 10, `expected the Worker's console calls, found ${found}`);
  assert.deepEqual(leaks, [], `Workers Logs must stay free of tokens and keys:\n${leaks.join("\n")}`);
});

test("an argument sandwiched between unmatched quotes is still read", () => {
  // gemini-3.1-pro's case: sequential quote replacement let the quotes of
  // `'"'` and `'"'` swallow the token between them.
  const source = "console.log('\"', token, '\"');";
  assert.ok(leaksIn("case.ts", source).some((leak) => /logs token/.test(leak)));
});

test("a parenthesis inside a template interpolation does not end the call", () => {
  // gemini-3.1-pro's case: the `)` of the inner template literal inverted
  // the hand-written quote state and closed the console.log early.
  const source = "console.log(` ${ `)` } `, token);";
  assert.ok(leaksIn("case.ts", source).some((leak) => /logs token/.test(leak)));
});

test("strings, comments and allowed names do not trip", () => {
  const source = [
    `console.error("could not revoke a write token" /* a token, in a comment */, codeOf(err));`,
    "console.log(`pull ${tokensIn} ${tokensOut} done`);",
    'console.log("session", session_id, api_url);',
  ].join("\n");
  assert.deepEqual(leaksIn("case.ts", source), []);
});

test("every console method is scanned, trace and dir included", () => {
  const source = "console.trace('x', token);\nconsole.dir(token);";
  const leaks = leaksIn("case.ts", source);
  assert.equal(leaks.length, 2, leaks.join("\n"));
});
