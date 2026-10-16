// The one bypass scanner the runner-routes checks share (t478): how a
// JavaScript source could reach a server other than through the transport
// it is meant to use. test/runner-routes.test.mjs applies it to the runner's
// own modules, cli/runner.mjs (outside runnerTransport, the one fetch the
// runner makes) and cli/commands/runner.mjs; test/runner-routes-helpers.test.mjs
// applies it to every atelier command the runner spawns and every helper of
// cli/atelier.mjs those commands reach. It is a library for those two files
// and holds no test of its own: its name is the task's scope
// (test/runner-routes*.test.mjs), under which npm test runs it as an empty
// file. Its unit tests live beside the sources it judges: the forms it
// catches in the runner's modules are the mutation cases in
// test/runner-routes.test.mjs, and that it reads code rather than strings or
// comments is checked in test/runner-routes-helpers.test.mjs.
//
// A reference is read on code only, with strings, template text, regular
// expressions and comments blanked, so `git fetch` in a message or a git
// argument is not a bypass. Every form of fetch counts: a bare call or read
// (fetch(, serverFetch(, const f = fetch, { fetch } = globalThis), a property on any
// object (globalThis.fetch, self.fetch, window.fetch, io.fetch, x?.fetch), a
// computed member (globalThis["fetch"]), with node's http and https clients,
// the network modules that hold them (static or dynamic import), undici, a
// socket, a WebSocket, an EventSource and an XMLHttpRequest. Which
// references a source may keep is the caller's judgement: the runner lets
// its git fetch helper (io.fetch) through by name and nothing else; a
// spawned command keeps serverVersion's declared preflight read.

// A source with its strings, template text and comments blanked to spaces,
// so a word in a message or a git argument ("fetch") is not read as code,
// while a template's ${...} stays code. A "/" where an operand is due starts
// a regular expression, blanked like a string.
export function codeOnly(source) {
  let out = "", i = 0;
  const stack = []; // one entry per open ${ in a template: its brace depth
  let depth = 0, last = "";
  const blank = (to) => { out += source.slice(i, to).replace(/[^\n]/g, " "); i = to; };
  const template = () => {
    // From just inside a template's text to its end or to a "${".
    let j = i;
    while (j < source.length && source[j] !== "`" && !(source[j] === "$" && source[j + 1] === "{")) j += source[j] === "\\" ? 2 : 1;
    blank(j);
    if (source[i] === "`") { out += "`"; i++; last = "`"; return; }
    out += "${"; i += 2; stack.push(depth); depth = 0; last = "{";
  };
  while (i < source.length) {
    const ch = source[i], next = source[i + 1];
    if (ch === "/" && next === "/") { const j = source.indexOf("\n", i); blank(j < 0 ? source.length : j); continue; }
    if (ch === "/" && next === "*") { const j = source.indexOf("*/", i + 2); blank(j < 0 ? source.length : j + 2); continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      out += ch; i++; blank(j); out += source[i] ?? ""; i++; last = ch; continue;
    }
    if (ch === "`") { out += "`"; i++; template(); continue; }
    if (ch === "/" && (last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last) || /\b(?:return|typeof|case|of|in)$/.test(out.trimEnd()))) {
      let j = i + 1, cls = false;
      while (j < source.length && source[j] !== "\n" && (cls || source[j] !== "/")) { if (source[j] === "\\") j++; else if (source[j] === "[") cls = true; else if (source[j] === "]") cls = false; j++; }
      out += "/"; i++; blank(j); out += "/"; i++;
      while (/[a-z]/.test(source[i] ?? "")) out += source[i++];
      last = "/regex"; continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      if (depth === 0 && stack.length) { depth = stack.pop(); out += "}"; i++; template(); continue; }
      depth--;
    }
    out += ch; i++;
    if (!/\s/.test(ch)) last = ch;
  }
  return out;
}

// Every way a source could reach a server other than its transport, matched
// on code only. A property named fetch is read with its receiver
// (globalThis.fetch, io.fetch), so the caller can tell one from another; a
// computed member's name is a string, blanked in the code, so it is matched
// by shape here and judged against the source below.
export const BYPASSES = [
  /(?<![.\w$])fetch\b/g,
  /(?<![\w$])[\w$]*\s*\??\.\s*fetch\b/g,
  /\[\s*["'`][^"'`\n]*["'`](?:\s*\+\s*["'`][^"'`\n]*["'`])*\s*\]/g, // a computed member, judged below: ["fetch"], ["serverFetch"], ["server" + "Fetch"]
  // serverFetch (cli/server-fetch.mjs, t568) is fetch after the event loop
  // has caught up: a way to the server like fetch itself.
  /(?<![.\w$])serverFetch\b/g,
  // The same through a receiver: a namespace import (transport.serverFetch)
  // or a default one (mod.default is judged by its import, below).
  /(?<![\w$])[\w$]*\s*\??\.\s*serverFetch\b/g,
  /(?<![.\w$])https?\s*\.\s*(?:request|get)\b/g,
  /\bimport\s*\(\s*["'`]\s*["'`]\s*\)/g, // a dynamic import, whose specifier is blanked: judged below
  /\bnew\s+(?:WebSocket|EventSource|XMLHttpRequest)\b/g,
  // A module reached by a name the scan cannot read: a dynamic import whose
  // specifier is not one literal string, Node's built-in module getter, or a
  // CommonJS require. None names its module where the scan can judge it.
  /\bimport\s*\((?!\s*["'`]\s*["'`]\s*\))/g,
  /\bgetBuiltinModule\b/g,
  /(?<![.\w$])(?:createRequire|require)\s*\(/g,
];
export const TRANSPORT_MODULE = /(?:^|\/)server-fetch(?:\.mjs)?$/;
export const NETWORK_MODULE = /^(?:node:)?(?:https?|http2|net|tls|dgram)$|^undici$/;

// Each reference in a source, in source order: its text (the match and the
// character after it, so `fetch(`, `fetch;`, `io.fetch(` and
// `globalThis.fetch` read apart), its index and its line.
export function references(source) {
  const code = codeOnly(source);
  const found = [];
  const at = (index, text) => found.push({ text, index, line: source.slice(0, index).split("\n").length });
  for (const pattern of BYPASSES) {
    for (const m of code.matchAll(pattern)) {
      if (/^import\s*\($/.test(m[0])) { at(m.index, "import(<not a literal>)"); continue; }
      if (m[0].startsWith("import")) {
        // A dynamic import names its module in a string; judge the original.
        const spec = /^import\s*\(\s*["'`]([^"'`]*)["'`]/.exec(source.slice(m.index))?.[1] ?? "";
        if (NETWORK_MODULE.test(spec) || TRANSPORT_MODULE.test(spec)) at(m.index, `import("${spec}")`);
        continue;
      }
      if (m[0].startsWith("[")) {
        // A computed member names its property in a string; judge the original.
        // Literals joined by + are resolved to the one name they spell.
        const member = source.slice(m.index, m.index + m[0].length);
        const key = [...member.matchAll(/(["'`])([^"'`\n]*)\1/g)].map((k) => k[2]).join("");
        if (/^(?:fetch|serverFetch)$/.test(key) && !member.includes("${")) at(m.index, member);
        continue;
      }
      at(m.index, source.slice(m.index, m.index + m[0].length + 1).trim());
    }
  }
  // Importing the server transport module in any form (named, aliased,
  // default or namespace) is a way to the server that a scan of call
  // spellings cannot follow, so the import itself is the reference.
  for (const m of source.matchAll(/^\s*import\b[^;]*?from\s*["']([^"']+)["']/gm)) if (NETWORK_MODULE.test(m[1]) || TRANSPORT_MODULE.test(m[1])) at(m.index, `import from "${m[1]}"`);
  return found.sort((a, b) => a.index - b.index);
}

// The references as text alone, for a check that expects none.
export const bypasses = (source) => references(source).map((r) => r.text);
