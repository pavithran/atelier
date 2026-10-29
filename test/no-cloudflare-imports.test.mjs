// Atelier 2.0 (task 7) removed Miniflare, wrangler and the @cloudflare/*
// packages. A file that still loads one passes only where Node finds the
// package in some node_modules above the checkout (the main checkout's, for
// a worktree inside it), and fails in a clean clone: test/runner-routes
// imported miniflare after the removal. The rule is simple and total, so no
// form of import slips by: no string literal, in any quote, in a .ts, .mts,
// .mjs or .js file under test/, src/, cli/ or scripts/ equals or starts with
// miniflare, wrangler or @cloudflare/, and package.json and package-lock.json
// name none of them. The files that mention one as data are named below,
// each with the exact literals it may hold and why. This file builds the
// names from parts, so it holds none of them.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SOURCE = /\.(?:ts|mts|mjs|js)$/;
const NAMES = ["mini" + "flare", "wran" + "gler", "@cloud" + "flare/"];
// A literal in any quote whose text starts with one of the names; the match
// runs to the closing quote, escapes included.
const LITERAL = new RegExp(String.raw`(["'\x60])((?:${NAMES.map((n) => n.replace("/", "\\/")).join("|")})(?:\\.|(?!\1)[^\\\n])*)\1`, "g");

export const literalsIn = (text) => [...text.matchAll(LITERAL)].map((m) => m[2]);

const W = NAMES[1];
const DATA = "a project's own files and commands, which Atelier protects and classifies in any project";
const DEPLOY = "atelier server-errors, which reads the Cloudflare Worker's log with wrangler tail and goes with the Worker";
export const EXCEPTIONS = {
  "src/checks.ts": { why: DATA, literals: [W] },
  "src/how-data.ts": { why: DATA, literals: [`${W}.*`] },
  "src/ledger.ts": { why: DATA, literals: [`${W}.*`] },
  "src/rules.ts": { why: DATA, literals: [`${W}.*`] },
  "cli/commands/init.mjs": { why: DATA, literals: [`${W}.*`] },
  "test/check-classes.spec.ts": { why: DATA, literals: [`${W}.jsonc`] },
  "test/checks.test.ts": { why: DATA, literals: [`${W} publish`, `${W} pages deploy dist`, `${W} secret put KEY`, `${W} d1 migrations apply DB --remote`] },
  "test/fixtures/attention.ts": { why: DATA, literals: [`${W}.toml`] },
  "test/ledger.spec.ts": { why: DATA, literals: [`${W}.*`] },
  "test/review-notice.test.ts": { why: DATA, literals: [`${W}.*`] },
  "test/routes.spec.ts": { why: DATA, literals: [`${W}.*`] },
  "test/rules.test.ts": { why: DATA, literals: [`${W}.*`, `${W}.jsonc`, `${W}.j\\u017fonc`] },
  "test/runner-evidence.test.mjs": { why: DATA, literals: [`${W} types`] },
  "test/runner-prepare-policy.spec.ts": { why: DATA, literals: [`${W}.jsonc`] },
  "cli/commands/server-errors.mjs": { why: DEPLOY, literals: [`${W} tail --format json`, `${W} tail failed (exit \${code}); no error count is available`, W] },
  "cli/server-errors.test.mjs": { why: DEPLOY, literals: [`${W} tail --format json`] },
};

test("every form of naming a removed package in a literal is found, whatever the quote, comment or spacing around it", () => {
  const [M, , C] = NAMES;
  assert.deepEqual(literalsIn(`import"${M}";`), [M]);
  assert.deepEqual(literalsIn(`const x = await import/* c */("${W}");`), [W]);
  assert.deepEqual(literalsIn(`const y = require(/* c */"${M}");`), [M]);
  assert.deepEqual(literalsIn(`import { a } from '${C}vitest-plugin/types';`), [`${C}vitest-plugin/types`]);
  assert.deepEqual(literalsIn(`export * from \x60${M}/x\x60;`), [`${M}/x`]);
  assert.deepEqual(literalsIn(`spawn("npx", ["${W}", "deploy"]);`), [W]);
  assert.deepEqual(literalsIn(`// ${M} and ${W} in prose\nimport { DurableObject } from "cloudflare:workers";\nconst z = "${M.toUpperCase()}";`), []);
});

test("no source file under test/, src/, cli/ or scripts/ holds a literal naming miniflare, wrangler or @cloudflare/, but the named exceptions", () => {
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "test", "src", "cli", "scripts"], { encoding: "utf8", maxBuffer: 1 << 28 });
  assert.equal(listed.status, 0, listed.stderr);
  const files = listed.stdout.split("\0").filter((f) => SOURCE.test(f));
  assert.ok(files.length > 100, `only ${files.length} source files listed`);
  const found = [], used = new Set();
  for (const file of files) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    const allowed = EXCEPTIONS[file]?.literals ?? [];
    for (const literal of literalsIn(text)) {
      if (allowed.includes(literal)) used.add(`${file}\0${literal}`);
      else found.push(`${file}: ${JSON.stringify(literal)}`);
    }
  }
  assert.deepEqual(found, []);
  // The list stays honest: every literal it allows is still there.
  const stale = Object.entries(EXCEPTIONS).flatMap(([file, { literals }]) => literals.filter((l) => !used.has(`${file}\0${l}`)).map((l) => `${file}: ${JSON.stringify(l)}`));
  assert.deepEqual(stale, [], "these exceptions are no longer needed: remove them");
});

test("package.json and package-lock.json name no miniflare, wrangler or @cloudflare package", () => {
  const named = new RegExp(String.raw`(?:^|["/])(?:${NAMES.map((n) => n.replace("/", "\\/")).join("|")})`, "m");
  for (const file of ["package.json", "package-lock.json"]) {
    const hits = readFileSync(file, "utf8").split("\n").filter((line) => named.test(line));
    assert.deepEqual(hits, [], file);
  }
});
