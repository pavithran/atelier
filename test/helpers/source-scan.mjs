// The one source scanner the runner-routes checks share (t478), built on the
// TypeScript compiler's parser (the `typescript5` alias of package.json: the
// classic API with createSourceFile, which typescript 7 does not export).
// It parses .mjs, .js and .ts alike, so a string, a template, a regular
// expression or a comment is never read as code, and a check no longer
// patches a regular expression per spelling.
//
// What it reads, for test/runner-routes.test.mjs (the runner's own modules,
// transitively), test/runner-routes-helpers.test.mjs (the commands the runner
// spawns, transitively, and the helpers of cli/atelier.mjs they reach) and
// the unit tests in test/runner-routes-scan.test.mjs:
//
// - every module import in any form: default, namespace, named, aliased,
//   type-only, side-effect, a re-export (`export { a } from`, `export * from`,
//   `export * as ns from`), a dynamic import() of a literal specifier (with
//   the names it destructures), a CommonJS require() of a literal, and
//   `import x = require("y")`;
// - the identifier aliases of the names those bind: `const send = call`,
//   `const { call: send } = await import("./atelier.mjs")`, `const s = ns.call`,
//   `let f; f = call`, followed to a fixed point, so a use of an alias is a
//   use of the module's export;
// - the ways a source reaches a server other than through its transport
//   (references): fetch and serverFetch bare, aliased, destructured, as a
//   property of any object or as a computed member of literals, node's
//   http(s) clients, the network modules and the transport module in every
//   import or re-export form, sockets, WebSocket, EventSource,
//   XMLHttpRequest, and the forms that name a module where the scan cannot
//   read it (import() of a non-literal, require, createRequire,
//   getBuiltinModule);
// - the walk over relative imports, transitively, through cli/ and src/ and
//   every source extension.
//
// Scope. The scan guards against an accidental undeclared call by an honest
// builder: a new helper, an import, an alias, a re-export. The runtime guards
// (the fetch guard under the gateway, declaredHelperCall in cli/atelier.mjs)
// and the gateway's own authorization remain the enforcement. Code written to
// hide a reach (eval, new Function, a name or a specifier assembled at run
// time) is out of scope.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript5";

const K = ts.SyntaxKind;

export const TRANSPORT_MODULE = /(?:^|\/)server-fetch(?:\.mjs)?$/;
export const NETWORK_MODULE = /^(?:node:)?(?:https?|http2|net|tls|dgram)$|^undici$/;
const REACH_NAMES = new Set(["fetch", "serverFetch"]);
const NEW_REACH = new Set(["WebSocket", "EventSource", "XMLHttpRequest"]);

// ── parsing ────────────────────────────────────────────────────────────────

const parsed = new Map();
// A module: its parsed source, its imports, its top-level declarations and
// its alias bindings. With `self`, the module's own top-level names are
// bindings of itself too, so an alias of a helper inside the module that
// declares it (`const send = call` in cli/atelier.mjs) resolves like an alias
// of an import.
export function parseModule(source, file = "module.mjs", { self = false } = {}) {
  const key = `${file}\0${self}\0${source}`;
  let mod = parsed.get(key);
  if (mod) return mod;
  const kind = /\.m?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  mod = { file, source, sf, self: self ? file : null };
  mod.imports = collectImports(sf);
  mod.declarations = collectDeclarations(sf);
  mod.bindings = collectBindings(mod);
  parsed.set(key, mod);
  return mod;
}
const asModule = (input) => (typeof input === "string" ? parseModule(input) : input);

const lineOf = (mod, node) => mod.sf.getLineAndCharacterOfPosition(node.getStart(mod.sf)).line + 1;
const textOf = (mod, node) => node.getText(mod.sf);

// A string literal's value, or the value of string literals joined by `+`
// (a no-substitution template counts as a literal); undefined for anything
// built at run time.
export function staticString(node) {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === K.PlusToken) {
    const left = staticString(node.left), right = staticString(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

// An expression with parentheses, awaits, type assertions and non-null marks
// peeled off.
function peel(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression?.(node) || ts.isSatisfiesExpression?.(node))) node = node.expression;
  return node;
}

// ── imports ────────────────────────────────────────────────────────────────

// Every import a source makes, in source order. Each entry:
//   kind    "import" | "side-effect" | "re-export" | "dynamic" | "require"
//   spec    the specifier, or null when it is not one literal string
//   bound   the names it binds: { imported, local } (a re-export's local is
//           the name it is exported under); "default" is the default export
//   typeOnly true for `import type` / `export type … from`, erased at run
//           time (the module graph does not follow it)
//   opaque  true when it binds a namespace, a default or a dynamic module as
//           a whole, which a check cannot follow member by member
//   node, line
function collectImports(sf) {
  const found = [];
  const lineAt = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const add = (entry, node) => found.push({ bound: [], opaque: false, ...entry, node, line: lineAt(node), pos: node.getStart(sf), end: node.getEnd() });
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const spec = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
      const clause = node.importClause;
      if (!clause) add({ kind: "side-effect", spec }, node);
      else {
        const bound = [];
        let opaque = false;
        if (clause.name) { bound.push({ imported: "default", local: clause.name.text }); opaque = true; }
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) { opaque = true; bound.push({ imported: "*", local: nb.name.text }); }
        else if (nb) for (const el of nb.elements) bound.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text });
        const typeOnly = clause.isTypeOnly || (!clause.name && nb && ts.isNamedImports(nb) && nb.elements.length > 0 && nb.elements.every((el) => el.isTypeOnly));
        add({ kind: "import", spec, bound, opaque, typeOnly }, node);
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const spec = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
      const bound = [];
      let opaque = false;
      const ex = node.exportClause;
      if (!ex) opaque = true;
      else if (ts.isNamespaceExport(ex)) { opaque = true; bound.push({ imported: "*", local: ex.name.text }); }
      else for (const el of ex.elements) bound.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text });
      add({ kind: "re-export", spec, bound, opaque, typeOnly: node.isTypeOnly }, node);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add({ kind: "require", spec: staticString(node.moduleReference.expression) ?? null, bound: [{ imported: "*", local: node.name.text }], opaque: true }, node);
    } else if (ts.isCallExpression(node) && (node.expression.kind === K.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const dynamic = node.expression.kind === K.ImportKeyword;
      const arg = node.arguments[0];
      const spec = arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : null;
      // The names an `await import("x")` or `require("x")` destructures.
      // (`api ?? await import("x")` and `a || b` count: either side may be it).
      let parent = node.parent;
      const passes = (n) => ts.isAwaitExpression(n) || ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isConditionalExpression(n) || (ts.isBinaryExpression(n) && [K.QuestionQuestionToken, K.BarBarToken].includes(n.operatorToken.kind));
      while (parent && passes(parent)) parent = parent.parent;
      const bound = [];
      let opaque = true;
      if (parent && ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
        opaque = false;
        for (const el of parent.name.elements) {
          if (el.dotDotDotToken || !ts.isIdentifier(el.name)) { opaque = true; continue; }
          bound.push({ imported: (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName : el.name).text, local: el.name.text });
        }
      }
      add({ kind: dynamic ? "dynamic" : "require", spec, bound, opaque }, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found.sort((a, b) => a.pos - b.pos);
}

// The imports of a source or module. Kept as a function for callers that
// hold only text.
export const importsOf = (input) => asModule(input).imports;

// ── declarations ───────────────────────────────────────────────────────────

// The top-level declarations of a module by name: functions, classes,
// variables (one entry per declared name, the statement's whole text for a
// const or let) and enums; each { name, node, exported }.
function collectDeclarations(sf) {
  const found = new Map();
  const put = (name, node, statement) => { if (!found.has(name)) found.set(name, { name, node, statement, exported: !!(ts.getCombinedModifierFlags?.(statement) & ts.ModifierFlags.Export) }); };
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) put(st.name.text, st, st);
    else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) bindingNames(d.name).forEach((n) => put(n, d, st));
  }
  return found;
}
export const declarationsOf = (input) => asModule(input).declarations;

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : bindingNames(el.name)));
}

// ── identifier roles ───────────────────────────────────────────────────────

// Whether an identifier is a name being declared or a property name, not a
// use of a binding.
function isNameOnly(id) {
  const p = id.parent;
  if (!p) return false;
  if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && p.name === id) return true;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isEnumMember(p)) && p.name === id) return true;
  if (ts.isBindingElement(p)) return p.propertyName === id || p.name === id;
  if (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isEnumDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isTypeParameterDeclaration(p)) return p.name === id;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p) || ts.isNamespaceExport(p)) return true;
  if (ts.isExportSpecifier(p)) return !!p.parent.parent.moduleSpecifier || p.name === id && !!p.propertyName;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return true;
  if (ts.isTypeReferenceNode(p) || ts.isExpressionWithTypeArguments(p) || ts.isTypeQueryNode(p)) return true;
  return false;
}

// How an expression is used: "callee" of a call, "alias" when it initialises
// a variable or is assigned to a name (the alias is followed), "value"
// otherwise.
function roleOf(node) {
  let n = node, p = node.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isAwaitExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p))) { n = p; p = p.parent; }
  if (!p) return "value";
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === n) return "callee";
  if (ts.isVariableDeclaration(p) && p.initializer === n) return "alias";
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === K.EqualsToken && ((p.right === n && ts.isIdentifier(p.left)) || p.left === n)) return "alias";
  return "value";
}

// ── bindings and aliases ───────────────────────────────────────────────────

// Which module export a local name stands for: { module, name } where name
// is "*" for a whole module (a namespace or a dynamic import), "default",
// or the export's name. Built from the module's imports and then from the
// aliases it declares, to a fixed point.
function collectBindings(mod) {
  const own = new Set(mod.self ? mod.declarations.keys() : []);
  const bindings = new Map([...own].map((name) => [name, { module: mod.file, name }]));
  for (const entry of mod.imports) {
    if (entry.spec === null) continue;
    for (const b of entry.bound) if (entry.kind !== "re-export") bindings.set(b.local, { module: entry.spec, name: b.imported });
  }
  mod.bindings = bindings;
  for (let changed = true; changed;) {
    changed = false;
    // A top-level declaration keeps its own identity: only an alias of some
    // other name is learned, never a redefinition of a declared one.
    const learn = (name, origin) => {
      if (!origin || own.has(name)) return;
      const old = bindings.get(name);
      if (!old || old.module !== origin.module || old.name !== origin.name) { bindings.set(name, origin); changed = true; }
    };
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) learn(node.name.text, originOf(mod, node.initializer));
        else if (ts.isObjectBindingPattern(node.name)) {
          const base = originOf(mod, node.initializer);
          if (base && base.name === "*") for (const el of node.name.elements) {
            if (el.dotDotDotToken || !ts.isIdentifier(el.name)) continue;
            learn(el.name.text, { module: base.module, name: (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName : el.name).text });
          }
        }
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === K.EqualsToken && ts.isIdentifier(node.left)) {
        learn(node.left.text, originOf(mod, node.right));
      }
      ts.forEachChild(node, visit);
    };
    visit(mod.sf);
  }
  return bindings;
}

// The module export an expression evaluates to, or null.
function originOf(mod, expr) {
  const node = peel(expr);
  if (!node) return null;
  if (ts.isIdentifier(node)) return mod.bindings.get(node.text) ?? null;
  if (ts.isCallExpression(node)) {
    const isImport = node.expression.kind === K.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require");
    const arg = node.arguments[0];
    if (isImport && arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) return { module: arg.text, name: "*" };
    return null;
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const base = originOf(mod, node.expression);
    if (!base || base.name !== "*") return null;
    const name = ts.isPropertyAccessExpression(node) ? node.name.text : staticString(node.argumentExpression);
    return name === undefined ? null : { module: base.module, name };
  }
  if (ts.isConditionalExpression(node)) return originOf(mod, node.whenTrue) ?? originOf(mod, node.whenFalse);
  if (ts.isBinaryExpression(node) && [K.BarBarToken, K.QuestionQuestionToken, K.AmpersandAmpersandToken].includes(node.operatorToken.kind)) return originOf(mod, node.left) ?? originOf(mod, node.right);
  return null;
}

// ── uses of module exports ─────────────────────────────────────────────────

// Every use, within `root` (default the whole module), of a name that stands
// for an export of another module, aliases resolved. Each use:
//   module, name   the export (name "*" for a namespace used as a whole)
//   local          the spelling in the source
//   role           "callee" | "alias" | "value" (see roleOf)
//   node, args, line
// A property of a namespace (`ns.call(...)`) is the use of that export; the
// namespace identifier itself is not reported again.
export function usesOf(input, root) {
  const mod = asModule(input);
  const uses = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && !isNameOnly(node)) {
      const origin = mod.bindings.get(node.text);
      if (origin) uses.push(use(mod, node, origin));
      return;
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const origin = originOf(mod, node);
      if (origin && origin.name !== "*") { uses.push(use(mod, node, origin)); return; }
    }
    ts.forEachChild(node, visit);
  };
  for (const r of [].concat(root ?? mod.sf)) visit(r);
  return uses;
}
function use(mod, node, origin) {
  const role = roleOf(node);
  let call = node.parent;
  while (call && (ts.isParenthesizedExpression(call) || ts.isAwaitExpression(call) || ts.isAsExpression(call) || ts.isNonNullExpression(call))) call = call.parent;
  const args = role === "callee" && ts.isCallExpression(call) ? [...call.arguments] : null;
  return { module: origin.module, name: origin.name, local: textOf(mod, node), role, node, args, call: args ? call : null, line: lineOf(mod, node) };
}

// The calls within `root` to the named exports of a module: each { name,
// args (nodes), text, line } with aliases resolved. A use of one of those
// names that is neither a call nor an alias initialiser is returned in
// `leaks`: the check cannot follow it.
export function callsTo(input, matchModule, names, root) {
  const mod = asModule(input);
  const calls = [], leaks = [];
  for (const u of usesOf(mod, root)) {
    if (!matchModule(u.module) || !names.has(u.name)) continue;
    if (u.role === "callee" && u.args) calls.push({ name: u.name, args: u.args, text: textOf(mod, u.call), line: u.line, node: u.call });
    else if (u.role !== "alias") leaks.push({ name: u.name, line: u.line, text: textOf(mod, u.node), role: u.role });
  }
  return { calls, leaks };
}

// Free identifier names within `root`: every identifier that is not a
// declared or property name. Used to follow a declaration to the declarations
// it names.
export function namesIn(input, root) {
  const mod = asModule(input);
  const names = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node) && !isNameOnly(node)) names.add(node.text);
    else if (ts.isShorthandPropertyAssignment(node)) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  for (const r of [].concat(root ?? mod.sf)) visit(r);
  return names;
}

// What a name is bound to: every declaration with an initialiser, parameter
// default and assignment of `name` in a source, as { kind: "identifier" |
// "object" | "other", text, line } of the value. For a check that a name
// stays what it was declared to be (the runner's `io`).
export function assignmentsTo(input, name) {
  const mod = asModule(input);
  const found = [];
  const note = (value) => {
    const v = peel(value);
    found.push({ kind: ts.isIdentifier(v) ? "identifier" : ts.isObjectLiteralExpression(v) ? "object" : "other", text: ts.isIdentifier(v) ? v.text : textOf(mod, v), line: lineOf(mod, value) });
  };
  const visit = (node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) note(node.initializer);
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === K.EqualsToken && ts.isIdentifier(node.left) && node.left.text === name) note(node.right);
    ts.forEachChild(node, visit);
  };
  visit(mod.sf);
  return found;
}

// The calls within `root` to a bare name (`fetch(`, `serverFetch(`), however
// the name came to be bound: { name, args (nodes), text, line }.
export function bareCalls(input, names, root) {
  const mod = asModule(input);
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text)) found.push({ name: node.expression.text, args: [...node.arguments], text: textOf(mod, node), line: lineOf(mod, node), pos: node.getStart(mod.sf) });
    ts.forEachChild(node, visit);
  };
  for (const r of [].concat(root ?? mod.sf)) visit(r);
  return found;
}

// Every use of a member called `name` on any object (`transport.send(`,
// `t?.send(`, `t["send"](`), in the module: { kind, receiver, args, text,
// line }. kind "call" for a call; "value" for the member taken without
// calling it (`const s = transport.send`, `go(transport.send)`), and
// "destructure" for `const { send } = transport`, which both hand the
// member on to a name the scan does not follow.
export function memberUses(input, name) {
  const mod = asModule(input);
  const found = [];
  const note = (kind, node, receiver, args) => found.push({ kind, receiver, args, text: textOf(mod, node), line: lineOf(mod, node) });
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === name || ts.isElementAccessExpression(node) && staticString(node.argumentExpression) === name) {
      let top = node;
      while (top.parent && (ts.isParenthesizedExpression(top.parent) || ts.isNonNullExpression(top.parent) || ts.isAsExpression(top.parent))) top = top.parent;
      const call = top.parent && ts.isCallExpression(top.parent) && top.parent.expression === top ? top.parent : null;
      note(call ? "call" : "value", call ?? node, textOf(mod, node.expression), call ? [...call.arguments] : null);
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && (node.propertyName ? staticString(node.propertyName) ?? node.propertyName.text : node.name.text) === name && !ts.isComputedPropertyName(node.propertyName ?? node.name)) {
      note("destructure", node, textOf(mod, node.parent.parent.initializer ?? node.parent), null);
    }
    ts.forEachChild(node, visit);
  };
  visit(mod.sf);
  return found;
}

// The names a call's object-literal argument sends: the property names at the
// top level and in the arms of a conditional spread (`...(x ? { a } : {})`);
// [] for an argument that is not an object literal.
export function objectKeys(node) {
  if (!node) return [];
  const n = peel(node);
  if (ts.isConditionalExpression(n)) return [...objectKeys(n.whenTrue), ...objectKeys(n.whenFalse)];
  if (!ts.isObjectLiteralExpression(n)) return [];
  const keys = [];
  for (const p of n.properties) {
    if (ts.isSpreadAssignment(p)) keys.push(...objectKeys(p.expression));
    else if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) keys.push(p.name.text);
  }
  return [...new Set(keys)];
}

// ── references: the ways to a server outside the transport ─────────────────

// Each reference in a source or a node of it, in source order:
//   kind   "name" | "member" | "computed" | "destructure" | "import" |
//          "http" | "new" | "unreadable" | "property-key"
//   text   the reference as written, with "(" after it when it is called
//          (`fetch(`, `io.fetch(`, `globalThis["fetch"]`, `import from
//          "node:http"`)
//   pos, line
// A property key named fetch (`fetch: (...) => ...`, as the usage text for
// `branch fetch` has) is a name, not a reach; it is returned with kind
// "property-key" for a caller that counts it, and `bypasses` leaves it out.
export function references(input, root) {
  const mod = asModule(input);
  const found = [];
  const at = (node, kind, text) => found.push({ kind, text, pos: node.getStart(mod.sf), line: lineOf(mod, node) });
  const callMark = (node) => { const p = peelUp(node); return p.parent && ts.isCallExpression(p.parent) && p.parent.expression === p ? "(" : ""; };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier) || ts.isImportEqualsDeclaration(node)) {
      // Judged below from the import entries, which carry every form.
      return;
    }
    if (ts.isIdentifier(node)) {
      if (REACH_NAMES.has(node.text) && !isNameOnly(node)) at(node, "name", `${node.text}${callMark(node)}`);
      else if (REACH_NAMES.has(node.text) && node.parent && (ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent) || ts.isPropertyDeclaration(node.parent)) && node.parent.name === node) at(node, "property-key", `${node.text}:`);
      return;
    }
    if (ts.isShorthandPropertyAssignment(node) && REACH_NAMES.has(node.name.text)) { at(node, "name", node.name.text); return; }
    if (ts.isPropertyAccessExpression(node)) {
      if (REACH_NAMES.has(node.name.text)) { at(node, "member", `${textOf(mod, node)}${callMark(node)}`); }
      else if (ts.isIdentifier(node.expression) && /^https?$/.test(node.expression.text) && /^(?:request|get)$/.test(node.name.text)) at(node, "http", `${textOf(mod, node)}${callMark(node)}`);
      // The receiver is still read: globalThis.fetch has none of interest, but a.b.fetch's `a.b` may hold a reach.
      visit(node.expression);
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      const key = staticString(node.argumentExpression);
      if (key !== undefined && REACH_NAMES.has(key)) at(node, "computed", `${textOf(mod, node)}${callMark(node)}`);
      ts.forEachChild(node, visit);
      return;
    }
    if (ts.isBindingElement(node)) {
      const key = node.propertyName ? (ts.isIdentifier(node.propertyName) ? node.propertyName.text : staticString(node.propertyName.expression ?? node.propertyName)) : ts.isIdentifier(node.name) ? node.name.text : undefined;
      if (key !== undefined && REACH_NAMES.has(key)) at(node, "destructure", textOf(mod, node).replace(/\s+/g, " ").replace(/^(\w+)$/, "$1:"));
      else if (node.propertyName && ts.isComputedPropertyName(node.propertyName)) { /* judged by the children */ }
      if (node.initializer) visit(node.initializer);
      if (node.propertyName && ts.isComputedPropertyName(node.propertyName)) visit(node.propertyName.expression);
      return;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && NEW_REACH.has(node.expression.text)) at(node, "new", `new ${node.expression.text}(`);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createRequire") at(node, "unreadable", "createRequire(");
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "getBuiltinModule") at(node, "unreadable", "getBuiltinModule");
    if (ts.isPropertyAccessExpression(node)) return;
    ts.forEachChild(node, visit);
  };
  for (const r of [].concat(root ?? mod.sf)) visit(r);
  // getBuiltinModule as a property (process.getBuiltinModule(...)) is a member access whose name is not in REACH_NAMES.
  const visitMember = (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "getBuiltinModule") at(node, "unreadable", "getBuiltinModule");
    ts.forEachChild(node, visitMember);
  };
  for (const r of [].concat(root ?? mod.sf)) visitMember(r);
  // The imports: a network or transport module in any form, and the forms
  // whose module cannot be read.
  for (const entry of mod.imports) {
    if (root && ![].concat(root).some((r) => entry.pos >= r.getStart(mod.sf) && entry.end <= r.getEnd())) continue;
    const label = { import: "import from", "side-effect": "import from", "re-export": "export from", require: "require" }[entry.kind];
    if (entry.spec === null) {
      if (entry.kind === "import" || entry.kind === "re-export" || entry.kind === "side-effect") continue;
      at(entry.node, "unreadable", entry.kind === "dynamic" ? "import(<not a literal>)" : "require(");
    } else if (entry.kind === "require") at(entry.node, "unreadable", "require(");
    else if (NETWORK_MODULE.test(entry.spec) || TRANSPORT_MODULE.test(entry.spec)) at(entry.node, "import", entry.kind === "dynamic" ? `import("${entry.spec}")` : `${label} "${entry.spec}"`);
  }
  return found.sort((a, b) => a.pos - b.pos);
}
function peelUp(node) {
  let n = node;
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isNonNullExpression(n.parent) || ts.isAsExpression(n.parent))) n = n.parent;
  return n;
}

// The references as text alone, for a check that expects none; a property
// key named fetch is left out.
export const bypasses = (input, root) => references(input, root).filter((r) => r.kind !== "property-key").map((r) => r.text);

// ── the module graph ───────────────────────────────────────────────────────

export const SOURCE_EXTENSIONS = [".mjs", ".js", ".ts", ".mts", ".cjs"];
export const fileSystem = {
  read: (path) => readFileSync(resolve(path), "utf8"),
  exists: (path) => existsSync(resolve(path)) && statSync(resolve(path)).isFile(),
};

// The file a relative specifier names from `file`, as a path from the
// repository root: the path itself, with a source extension added or a .js
// swapped for the .ts beside it (how src/ is imported), or a directory's
// index. Null when it names nothing in the repository.
export function resolveImport(file, spec, files = fileSystem) {
  if (typeof spec !== "string" || !/^\.\.?(?:\/|$)/.test(spec)) return null;
  const path = relative(resolve("."), resolve(dirname(file), spec));
  if (path.startsWith("..") || /(?:^|\/)node_modules\//.test(path)) return null;
  const stem = path.replace(/\.[mc]?js$/, "");
  const candidates = [path, ...SOURCE_EXTENSIONS.map((e) => path + e), ...SOURCE_EXTENSIONS.map((e) => stem + e), ...SOURCE_EXTENSIONS.map((e) => `${path}/index${e}`)];
  return candidates.find((candidate) => files.exists(candidate)) ?? null;
}

// The relative modules an entry file imports, transitively, as paths from
// the repository root in discovery order: every local source file an import
// of any form reaches (static, side-effect, re-export, dynamic of a literal,
// require of a literal), .mjs and .ts alike. `stop` names modules that are
// recorded but not entered (cli/atelier.mjs, whose helpers are judged by
// declaration; the transport itself). The entry is not in the result.
export function importClosure(entry, { files = fileSystem, stop = () => false, parse = (path) => parseModule(files.read(path), path) } = {}) {
  const order = [], seen = new Set([entry]);
  const walk = (file) => {
    for (const { spec, typeOnly } of parse(file).imports) {
      const path = typeOnly ? null : resolveImport(file, spec, files);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      if (stop(path)) continue;
      order.push(path);
      walk(path);
    }
  };
  walk(entry);
  return order;
}

// The files of the repository with some replaced or added, for mutation
// tests.
export const withFiles = (tree, base = fileSystem) => ({
  read: (path) => tree[path] ?? base.read(path),
  exists: (path) => path in tree || base.exists(path),
});
