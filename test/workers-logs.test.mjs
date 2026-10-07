import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

// Every console.(log|error|warn|info|debug) call in a source file, with the
// full text of its arguments and the line it starts on. The arguments are
// taken with a paren depth and string scan, so a call holding strings with
// parentheses, or further calls, is read whole.
function consoleCalls(source) {
  const calls = [];
  const head = /console\.(?:log|error|warn|info|debug)\s*\(/g;
  let m;
  while ((m = head.exec(source))) {
    let i = m.index + m[0].length, depth = 1, quote = null, escape = false, args = "";
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (quote) {
        if (escape) escape = false;
        else if (c === "\\") escape = true;
        else if (c === quote) quote = null;
        args += c;
      } else if (c === '"' || c === "'" || c === "`") { quote = c; args += c; }
      else if (c === "(") { depth++; args += c; }
      else if (c === ")") { depth--; if (depth > 0) args += c; }
      else args += c;
      i++;
    }
    calls.push({ args, line: source.slice(0, m.index).split("\n").length });
    head.lastIndex = i;
  }
  return calls;
}

// The expressions a call logs: its string literals dropped, and a template
// literal reduced to what its ${...} interpolations print.
function expressionsOnly(args) {
  return args
    .replace(/"(?:[^"\\]|\\.)*"/g, " ")
    .replace(/'(?:[^'\\]|\\.)*'/g, " ")
    .replace(/`(?:[^`\\]|\\.)*`/g, (t) => (t.match(/\$\{[^}]*\}/g) ?? []).join(" "));
}

// What may never be named in a console call's expressions. A bearer token,
// a cookie, a secret, or any object holding one (env, a request, its
// headers) would land in the account's Workers Logs and stay there.
const FORBIDDEN = /token|secret|bearer|authoriz|authoris|cookie|password|passphrase|credential|api_?key|plaintext|session/i;
// Names the pattern trips that are not credentials: model usage counts and
// the session TTL.
const ALLOWED = new Set(["tokensIn", "tokensOut", "SESSION_SECONDS"]);

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
    for (const call of consoleCalls(source)) {
      found++;
      const where = `${file.slice(root.length + 1)}:${call.line}`;
      for (const name of expressionsOnly(call.args).matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
        if (!ALLOWED.has(name[0]) && FORBIDDEN.test(name[0])) {
          leaks.push(`${where} logs ${name[0]} (${call.args.trim()})`);
        }
      }
    }
  }
  // The scan must see the Worker's calls; a silent match of nothing would
  // pass an empty check.
  assert.ok(found >= 10, `expected the Worker's console calls, found ${found}`);
  assert.deepEqual(leaks, [], `Workers Logs must stay free of tokens and keys:\n${leaks.join("\n")}`);
});
