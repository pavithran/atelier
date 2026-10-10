import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FLAGS, HANDLERS, registerHandlers } from "../cli/atelier.mjs";
import { COMMANDS, COMMAND_USAGE, REGISTRY, commandFor } from "../cli/help.mjs";
import { orderedForms, registerCommands } from "../src/usage/command.ts";

// Each command owns two modules: its declaration, src/usage/commands/NAME.ts
// (forms, flags, help, aliases, subcommands), which the CLI and the Worker
// read, and its handler, cli/commands/NAME.mjs, which the CLI alone loads.
// node cli/regenerate.mjs writes the index of each folder and the fixtures.
// These tests read the folders themselves rather than the indexes, so a
// module the indexes miss, or an index entry with no module, fails here.

const root = resolve(".");
const SPECS = "src/usage/commands", HANDLER_DIR = "cli/commands";
const listed = (dir, ext) => readdirSync(join(root, dir)).filter((f) => f.endsWith(ext) && f !== `index${ext}`).map((f) => f.slice(0, -ext.length)).sort();
const declared = listed(SPECS, ".ts"), handled = listed(HANDLER_DIR, ".mjs");
const indexed = (file) => [...readFileSync(join(root, file), "utf8").matchAll(/path: "([^"]+)"/g)].map((m) => m[1]);

test("every declared command has a handler and every handler a declaration, and the indexes list exactly those modules", () => {
  assert.ok(declared.length > 60, `found only ${declared.length} command modules`);
  assert.deepEqual(handled, declared);
  assert.deepEqual(indexed(`${SPECS}/index.ts`), declared.map((n) => `${SPECS}/${n}.ts`), "src/usage/commands/index.ts is stale: run node cli/regenerate.mjs");
  assert.deepEqual(indexed(`${HANDLER_DIR}/index.mjs`), handled.map((n) => `${HANDLER_DIR}/${n}.mjs`), "cli/commands/index.mjs is stale: run node cli/regenerate.mjs");
  assert.deepEqual(Object.keys(COMMANDS), declared);
  assert.deepEqual([...HANDLERS.keys()].sort(), declared);
  assert.deepEqual(Object.keys(FLAGS).sort(), declared);
});

test("each module declares its own command: its forms, its flags, its help and its handler", async () => {
  for (const name of declared) {
    const { default: spec } = await import(pathToFileURL(join(root, SPECS, `${name}.ts`)).href);
    const { default: handler } = await import(pathToFileURL(join(root, HANDLER_DIR, `${name}.mjs`)).href);
    assert.equal(spec.name, name, `${SPECS}/${name}.ts declares atelier ${spec.name}`);
    assert.equal(COMMANDS[name], spec, `${name}: the registry holds another declaration`);
    assert.equal(FLAGS[name], spec.flags, `${name}: the parser reads other flags than its module declares`);
    assert.equal(typeof handler, "function", `${HANDLER_DIR}/${name}.mjs exports no handler`);
    assert.equal(HANDLERS.get(name), handler, `${name}: the CLI runs another handler than ${HANDLER_DIR}/${name}.mjs`);
    for (const form of spec.forms) assert.equal(form.form.split(" ")[0], name, `${name}: ${form.form}`);
    for (const word of [name, ...(spec.aliases ?? [])]) assert.equal(commandFor(word), name, `atelier ${word} does not run ${name}`);
    if (spec.help) assert.ok(COMMAND_USAGE[name].startsWith("usage: atelier "), `${name}: ${COMMAND_USAGE[name].slice(0, 40)}`);
  }
});

test("discovery reads command modules only: the usage-reporting modules are never commands", () => {
  // `atelier report` is a command; src/usage/report.ts is not, and is never its module.
  const sources = [...REGISTRY.paths.values()];
  for (const reporting of ["gateway", "page", "usage"]) assert.equal(commandFor(reporting), undefined, `${reporting} was read as a command`);
  for (const file of ["src/usage/gateway.ts", "src/usage/page.ts", "src/usage/report.ts", "cli/usage.mjs"]) {
    assert.ok(existsSync(join(root, file)), `${file} moved; update this test`);
    assert.ok(!sources.includes(file), `${file} was read as a command module`);
    for (const index of [`${SPECS}/index.ts`, `${HANDLER_DIR}/index.mjs`]) assert.ok(!indexed(index).includes(file), `${index} lists ${file}`);
  }
});

// What the Worker bundles from src/usage.ts: every module it reaches by a
// relative import. None may be a CLI handler or any other CLI module.
test("the Worker reads the same declarations without reaching any CLI module", () => {
  const seen = new Set(), queue = ["src/usage.ts"];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, spec] of readFileSync(join(root, file), "utf8").matchAll(/^(?:import|export)[^"';]*?from\s+["'](\.[^"']+)["']/gm)) queue.push(join(dirname(file), spec));
  }
  assert.ok(declared.every((n) => seen.has(`${SPECS}/${n}.ts`)), "src/usage.ts does not reach every command module");
  assert.deepEqual([...seen].filter((f) => !f.startsWith("src/")), [], "src/usage.ts reaches modules outside src/");
  assert.ok(![...seen].some((f) => f.startsWith(HANDLER_DIR)));
});

const spec = (name, extra = {}) => ({ name, forms: [{ group: "Items", line: 1, slot: 10, form: `${name} ID`, about: `Runs ${name}.` }], flags: {}, ...extra });
const mod = (name, extra, dir = SPECS) => ({ path: `${dir}/${name}.ts`, spec: spec(name, extra) });

test("a duplicate name or alias fails with the source paths of both modules", () => {
  assert.throws(() => registerCommands([mod("ls"), { path: "src/usage/commands/other/ls.ts", spec: spec("ls") }]),
    /atelier ls is declared twice: by src\/usage\/commands\/ls\.ts and by src\/usage\/commands\/other\/ls\.ts/);
  assert.throws(() => registerCommands([mod("ls", { aliases: ["list"] }), mod("show", { aliases: ["list"] })]),
    /atelier list is declared twice: by src\/usage\/commands\/ls\.ts and by src\/usage\/commands\/show\.ts/);
  assert.throws(() => registerCommands([mod("ls"), mod("show", { aliases: ["ls"] })]), /atelier ls is declared twice: by src\/usage\/commands\/ls\.ts and by src\/usage\/commands\/show\.ts/);
});

test("a module declares its own command alone, its subcommands included, in a known group", () => {
  assert.throws(() => registerCommands([{ path: `${SPECS}/ls.ts`, spec: spec("show") }]), /src\/usage\/commands\/ls\.ts: declares atelier show/);
  assert.throws(() => registerCommands([mod("plan", { forms: [{ group: "Plans", line: 1, slot: 10, form: "models show ID", about: "x" }] })]),
    /src\/usage\/commands\/plan\.ts: the form "models show ID" belongs to atelier models, not atelier plan/);
  assert.throws(() => registerCommands([mod("ls", { forms: [{ group: "Nowhere", line: 1, slot: 10, form: "ls", about: "x" }] })]), /src\/usage\/commands\/ls\.ts: .*help group "Nowhere"/);
  assert.throws(() => registerCommands([mod("Ls")]), /"Ls" is not a command name/);
  assert.throws(() => registerCommands([{ path: `${SPECS}/broken.ts`, spec: undefined }]), /src\/usage\/commands\/broken\.ts: declares no command/);
});

test("the help's order depends on the declarations alone, never the order modules are found in", () => {
  const modules = [mod("b"), mod("a"), mod("c", { forms: [{ group: "Setup", line: 2, slot: 5, form: "c", about: "x" }] }), mod("d", { forms: [{ group: "Items", line: 1, slot: 10, form: "d two", about: "x" }, { group: "Items", line: 1, slot: 5, form: "d one", about: "x" }] })];
  const order = (list) => orderedForms(registerCommands(list)).map((f) => f.form);
  const expected = ["c", "d one", "a ID", "b ID", "d two"];
  assert.deepEqual(order(modules), expected);
  for (let i = 0; i < 10; i++) assert.deepEqual(order([...modules].sort(() => Math.random() - 0.5)), expected);
  // The real table too: registering the modules in reverse prints the same help.
  const real = Object.entries(COMMANDS).map(([name, s]) => ({ path: `${SPECS}/${name}.ts`, spec: s }));
  assert.deepEqual(orderedForms(registerCommands(real.reverse())).map((f) => f.form), orderedForms(registerCommands(real)).map((f) => f.form));
});

test("a missing, extra or duplicate handler fails, naming the module", () => {
  const run = () => {};
  const commands = { ls: spec("ls"), show: spec("show") };
  const h = (name, dir = HANDLER_DIR) => ({ path: `${dir}/${name}.mjs`, run });
  assert.equal(registerHandlers([h("ls"), h("show")], commands).size, 2);
  assert.throws(() => registerHandlers([h("ls")], commands), /atelier show has no handler: cli\/commands\/show\.mjs/);
  assert.throws(() => registerHandlers([h("ls"), h("show"), h("frob")], commands), /cli\/commands\/frob\.mjs: handles atelier frob, which no module in src\/usage\/commands declares/);
  assert.throws(() => registerHandlers([h("ls"), h("show"), h("ls", "cli/commands/old")], commands), /atelier ls has two handlers: cli\/commands\/ls\.mjs and cli\/commands\/old\/ls\.mjs/);
  assert.throws(() => registerHandlers([{ path: `${HANDLER_DIR}/ls.mjs`, run: {} }, h("show")], commands), /cli\/commands\/ls\.mjs: its default export is not the command's handler/);
});

// A copy of the CLI and its declarations, to add commands to.
function copy(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-modules-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const part of ["cli", "src", "test/fixtures/cli", "package.json"]) cpSync(join(root, part), join(dir, part), { recursive: true });
  if (existsSync(join(root, "node_modules"))) symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  return dir;
}
const node = (dir, args, env = {}) => spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8", env: { ...process.env, ATELIER_CONFIG_DIR: join(dir, ".config"), ...env } });
const snapshot = (dir) => {
  const files = new Map();
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name === "node_modules" || entry.name === ".config") continue;
      if (entry.isDirectory()) walk(path);
      else files.set(path, readFileSync(join(dir, path), "utf8"));
    }
  };
  walk("");
  return files;
};
const changes = (before, after) => [...new Set([...before.keys(), ...after.keys()])].filter((f) => before.get(f) !== after.get(f)).sort();

const declaration = (name, extra = "") => `import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "${name}",${extra}
  forms: [{ group: "Local", line: 9, slot: 10, form: "${name} [--loud]", about: "Says ${name} to whoever runs it." }],
  flags: { loud: true },
  help: { flags: { "--loud": "says it in capitals" }, example: "atelier ${name} --loud" },
};

export default spec;
`;
const handler = (name) => `import { args } from "../atelier.mjs";

export default function ${name}Command() {
  console.log(args.loud ? "${name.toUpperCase()}" : "${name}");
}
`;

test("two commands added as separate files need no edit to any shared file, and regenerating twice settles", async (t) => {
  const dir = copy(t);
  const before = snapshot(dir);
  // Two tasks, each writing its own two files.
  writeFileSync(join(dir, SPECS, "hello.ts"), declaration("hello", '\n  aliases: ["hi"],'));
  writeFileSync(join(dir, HANDLER_DIR, "hello.mjs"), handler("hello"));
  writeFileSync(join(dir, SPECS, "wave.ts"), declaration("wave"));
  writeFileSync(join(dir, HANDLER_DIR, "wave.mjs"), handler("wave"));
  const first = node(dir, ["cli/regenerate.mjs"]);
  assert.equal(first.status, 0, first.stderr);
  const after = snapshot(dir);
  assert.deepEqual(changes(before, after), [
    "cli/commands/hello.mjs", "cli/commands/index.mjs", "cli/commands/wave.mjs",
    "src/usage/commands/hello.ts", "src/usage/commands/index.ts", "src/usage/commands/wave.ts",
    "test/fixtures/cli/help.txt", "test/fixtures/cli/usage.json",
  ]);
  // The second run changes nothing.
  const second = node(dir, ["cli/regenerate.mjs"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /up to date/);
  assert.deepEqual(changes(after, snapshot(dir)), []);
  assert.equal(node(dir, ["cli/regenerate.mjs", "--check"]).status, 0);
  // Both run, by name and by alias, take their flags and print their help.
  assert.equal(node(dir, ["cli/atelier.mjs", "hello"]).stdout, "hello\n");
  assert.equal(node(dir, ["cli/atelier.mjs", "hi", "--loud"]).stdout, "HELLO\n");
  assert.equal(node(dir, ["cli/atelier.mjs", "wave", "--loud"]).stdout, "WAVE\n");
  assert.match(node(dir, ["cli/atelier.mjs", "hi", "--help"]).stdout, /^usage: atelier hello \[--loud\]\nSays hello to whoever runs it\.\nFlags:\n  --loud  says it in capitals\n/);
  assert.match(node(dir, ["cli/atelier.mjs", "wave", "--bogus"]).stderr, /^atelier: wave does not take --bogus; see atelier wave --help\n$/);
  const help = readFileSync(join(dir, "test/fixtures/cli/help.txt"), "utf8");
  assert.match(help, /^ {11}hello \[--loud\] · wave \[--loud\]$/m);
  const usage = JSON.parse(readFileSync(join(dir, "test/fixtures/cli/usage.json"), "utf8"));
  assert.ok(usage.hello.startsWith("usage: atelier hello") && usage.wave.startsWith("usage: atelier wave"));
});

test("regenerate fails on a command error, naming the modules, and leaves the indexes as they were", (t) => {
  const dir = copy(t);
  const before = snapshot(dir);
  // A second module claims ls as an alias.
  writeFileSync(join(dir, SPECS, "list.ts"), declaration("list", '\n  aliases: ["ls"],'));
  writeFileSync(join(dir, HANDLER_DIR, "list.mjs"), handler("list"));
  const r = node(dir, ["cli/regenerate.mjs"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /atelier ls is declared twice: by src\/usage\/commands\/list\.ts and by src\/usage\/commands\/ls\.ts/);
  assert.deepEqual(changes(before, snapshot(dir)), ["cli/commands/list.mjs", "src/usage/commands/list.ts"]);
  // A declaration without a handler fails too.
  rmSync(join(dir, HANDLER_DIR, "list.mjs"));
  writeFileSync(join(dir, SPECS, "list.ts"), declaration("list"));
  const missing = node(dir, ["cli/regenerate.mjs"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /atelier list has no handler: cli\/commands\/list\.mjs/);
  assert.deepEqual(changes(before, snapshot(dir)), ["src/usage/commands/list.ts"]);
});
