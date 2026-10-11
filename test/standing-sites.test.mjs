import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The owner's standing for a model (paused, reserved, roles) holds at every
// place that creates a dispatch or a review request, not only at the ones a
// test happens to drive: each goes through Ledger.standingDispatch, which
// refuses a model held from the job. This scans the source, so a new call
// site that builds its dispatch some other way fails here before review.

const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
const ledger = readFileSync("src/ledger.ts", "utf8").split("\n");

// The Ledger's methods, each from its declaration at class indent to the next.
const METHOD = /^ {2}(?:(?:private|public|async|static|get)\s+)*([A-Za-z_]\w*)\s*\(/;
const methods = [];
ledger.forEach((line, i) => {
  const m = METHOD.exec(line);
  if (m && !["if", "for", "while", "switch"].includes(m[1])) methods.push({ name: m[1], start: i });
});
methods.forEach((m, i) => { m.body = ledger.slice(m.start, methods[i + 1]?.start ?? ledger.length).join("\n"); });
const methodAt = (line) => methods.findLast((m) => m.start <= line);

// The lines of the ledger matching a pattern, with the method each is in.
const sites = (pattern) => ledger.flatMap((line, i) => (pattern.test(line) ? [{ line: i + 1, method: methodAt(i) }] : []));

test("makeDispatch is called only by overrideDispatch, and that only by standingDispatch", () => {
  // overrideDispatch (src/dispatch/rules.ts) is the one factory over makeDispatch.
  const rules = readFileSync("src/dispatch/rules.ts", "utf8").split("\n");
  const inOverride = rules.flatMap((line, i) => (/\bmakeDispatch\(/.test(line) && !/export function makeDispatch\(/.test(line) ? [i + 1] : []));
  const start = rules.findIndex((l) => /export function overrideDispatch\(/.test(l)) + 1;
  const end = start + rules.slice(start).findIndex((l) => /^}/.test(l)) + 1;
  assert.ok(inOverride.length > 0 && inOverride.every((n) => n > start && n <= end), "rules.ts calls makeDispatch only inside overrideDispatch");
  const calls = files("src").flatMap((f) => readFileSync(f, "utf8").split("\n").flatMap((line, i) =>
    /\b(makeDispatch|overrideDispatch)\(/.test(line) && !/export function (makeDispatch|overrideDispatch)\(/.test(line) && !/typeof (makeDispatch|overrideDispatch)/.test(line) && f !== join("src", "dispatch", "rules.ts") ? [`${f}:${i + 1}`] : []));
  const allowed = sites(/\boverrideDispatch\(/).filter((s) => s.method.name === "standingDispatch").map((s) => `src/ledger.ts:${s.line}`);
  assert.equal(allowed.length, 1, "standingDispatch calls overrideDispatch once");
  assert.deepEqual(calls, allowed);
});

test("standingDispatch and planDispatch check the owner's standing", () => {
  const standing = methods.find((m) => m.name === "standingDispatch");
  assert.match(standing.body, /this\.assertStanding\(/);
  const plan = methods.find((m) => m.name === "planDispatch");
  assert.match(plan.body, /this\.standingDispatch\([^]*"plan"/);
});

// Helpers that write a dispatch their caller made; each of their calls is a
// site in its own right, checked in the caller. setDispatch (t394) is the one
// statement that stores a dispatch, so its callers are the sites.
const PASS_THROUGH = ["writeDispatch", "askPlanner", "setDispatch"];

test("every review request and every dispatch written is built by the standing check", () => {
  const writers = [
    ...sites(/INSERT INTO review_requests/),
    ...sites(/UPDATE items SET dispatch = \?/),
    ...sites(/this\.planDispatch\(/),
    ...PASS_THROUGH.flatMap((name) => sites(new RegExp(`this\\.${name}\\(`))),
  ];
  // The review requests, the owner's dispatch, the plan job and its retries,
  // the parts and the integrator's jobs: none may be missed by the scan.
  assert.ok(writers.filter((s) => /INSERT INTO review_requests/.test(ledger[s.line - 1])).length >= 5);
  assert.ok(writers.length >= 17, `found ${writers.length} sites`);
  const unchecked = writers
    .filter((s) => !PASS_THROUGH.includes(s.method.name))
    .filter((s) => !/this\.(standingDispatch|planDispatch)\(/.test(s.method.body))
    .map((s) => `src/ledger.ts:${s.line} in ${s.method.name}`);
  assert.deepEqual(unchecked, []);
  // A pass-through helper writes only what it is given, never a dispatch of
  // its own making.
  for (const name of PASS_THROUGH) assert.doesNotMatch(methods.find((m) => m.name === name).body, /makeDispatch\(|to: "(home|cloud|any)"/, name);
});

// Criterion 4 again, for ownership: every write that gives a task an owner,
// or lets its holder keep one with a fresh claim generation (and so a fresh
// write token), is found by scanning the source, not taken from a list, and
// must sit in a method that checks the owner's standing. A write is found
// however it is made: an item update naming `owner` with anything but null,
// an `owner` property or key assigned anywhere in src, a computed key or an
// unknown record in an item update, raw SQL that sets or inserts an owner,
// or a claim generation reserved for the holder.
const CHECKS = /\bactorStanding\(|this\.assertStanding\(|this\.handoffAllowed\(/;

// The text of a call from its opening parenthesis to the one that closes it.
function callArgs(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// The owner writes in one source text, each with its offset and kind.
function writesIn(text) {
  const found = [];
  const add = (index, how) => found.push({ index, how });
  // An item update naming the owner, other than to clear it, or one with a
  // computed key; a record spread or passed whole is made in the same source,
  // so an owner put into it is caught as assigned below.
  for (const m of text.matchAll(/\bthis\.update\(/g)) {
    const args = callArgs(text, m.index + m[0].length - 1);
    if (/\bowner\b(?!\s*:\s*null\b)/.test(args)) add(m.index, "update naming owner");
    else if (/\[[^\]]+\]\s*:/.test(args)) add(m.index, "update with a computed key");
  }
  // An owner property or key assigned (the project owner's own field aside).
  for (const m of text.matchAll(/(?<!this)(?:\.owner|\[\s*["'`]owner["'`]\s*\])\s*=(?!=)/g)) add(m.index, "owner assigned");
  // Raw SQL setting or inserting an owner.
  for (const m of text.matchAll(/UPDATE\s+items\s+SET\b[^`;]*?\bowner\s*=/g)) add(m.index, "SQL sets owner");
  for (const m of text.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+items\s*\(([^)]*)\)/g)) if (/\bowner\b/.test(m[1])) add(m.index, "SQL inserts owner");
  // A holder keeping its claim: a claim generation reserved for its next token.
  for (const m of text.matchAll(/\bthis\.reserve\(/g)) add(m.index, "claim generation reserved");
  return found;
}

const LEDGER = join("src", "ledger.ts");
const ownerWrites = () => files("src").filter((f) => !/\.test\.m?[jt]s$/.test(f)).flatMap((file) => {
  const text = readFileSync(file, "utf8");
  return writesIn(text).map((w) => ({ file, line: lineOf(text, w.index), how: w.how }));
});

// Owner writes that need no standing check, each with the reason. Each must
// still be found by the scan, so an entry outlives no change that removes it.
const ALLOWED = {
  // A failed fork's rollback (t506) puts back the item as it was before the
  // claim that failed: the rollback record is written only by a fresh claim,
  // which assertClaimable allows only of an item nobody owns, so the owner it
  // restores is always empty. It is applied only while the failed claimant
  // still holds that claim generation, and reserves none, so it never gives
  // anyone a claim or a write token.
  "unclaim: update naming owner": "restores the empty owner recorded before a fresh claim whose fork failed",
};

test("every write that assigns or keeps a task's owner checks the owner's standing", () => {
  const writes = ownerWrites();
  const methodOf = (w) => (w.file === LEDGER ? methodAt(w.line - 1) : null);
  const allowed = (w) => !!methodOf(w) && Object.hasOwn(ALLOWED, `${methodOf(w).name}: ${w.how}`);
  // The scan sees the paths it must: a claim (and a runner adopting a
  // handed-off one), a renewal's reserved generation, and a handoff.
  const where = writes.filter((w) => w.file === LEDGER).map((w) => `${methodOf(w).name}: ${w.how}`);
  for (const known of ["claim: update naming owner", "claim: claim generation reserved", "handoff: update naming owner"]) {
    assert.ok(where.includes(known), `the scan misses ${known}; it found ${where.join(", ")}`);
  }
  for (const site of Object.keys(ALLOWED)) assert.ok(where.includes(site), `the allowed owner write ${site} is no longer found; drop it from ALLOWED`);
  const unchecked = writes.filter((w) => !allowed(w)).filter((w) => !methodOf(w) || !CHECKS.test(methodOf(w).body))
    .map((w) => `${w.file}:${w.line} (${w.how}${methodOf(w) ? ` in ${methodOf(w).name}` : ""})`);
  assert.deepEqual(unchecked, [], "these assign or keep an owner without checking the owner's standing (actorStanding, assertStanding or handoffAllowed)");
});

test("the owner-write scan finds an owner assigned however it is written", () => {
  const scan = (text) => writesIn(text).map((w) => w.how);
  assert.deepEqual(scan(`this.update(id, {\n  state: "claimed",\n  owner: to,\n}, at);`), ["update naming owner"]);
  assert.deepEqual(scan(`this.update(id, { owner, state: "claimed" }, at);`), ["update naming owner"]);
  assert.deepEqual(scan(`this.update(id, { [key]: actor }, at);`), ["update with a computed key"]);
  assert.deepEqual(scan(`fields.owner = actor; this.update(id, fields, at);`), ["owner assigned"]);
  assert.deepEqual(scan(`fields["owner"] = actor;`), ["owner assigned"]);
  assert.deepEqual(scan("this.sql.exec(`UPDATE items SET state = 'claimed', owner = ? WHERE id = ?`, a, id);"), ["SQL sets owner"]);
  assert.deepEqual(scan("this.sql.exec(`INSERT INTO items (id, owner) VALUES (?, ?)`, id, a);"), ["SQL inserts owner"]);
  assert.deepEqual(scan(`return { ...this.reserve(id) };`), ["claim generation reserved"]);
  // Clearing an owner, reading one, and the project owner's own field are not writes.
  assert.deepEqual(scan(`this.update(id, { state: "merged", owner: null }, at); if (item.owner === actor) {} this.owner = owner;`), []);
});

test("a failed fork's rollback restores only what a fresh claim of an unowned item recorded", () => {
  const claim = methods.find((m) => m.name === "claim").body;
  const unclaim = methods.find((m) => m.name === "unclaim").body;
  // The rollback record is written once, by claim, after the holder's own
  // re-claim has returned, so only a fresh claim records one.
  assert.equal(ledger.filter((l) => /`claim-rollback:\$\{id\}`, JSON\.stringify\(/.test(l)).length, 1);
  const reclaimReturns = claim.indexOf("return { item: this.item(id), needsFork: !item.fork, ...this.reserve(id) };");
  assert.ok(reclaimReturns > 0 && claim.indexOf("`claim-rollback:${id}`, JSON.stringify(") > reclaimReturns, "the rollback record follows the re-claim's return");
  // A fresh claim is refused of an item another actor owns.
  assert.match(readFileSync("src/rules.ts", "utf8"), /if \(item\.owner && item\.owner !== actor\) \{\n\s*throw new RuleError\("owned"/);
  // The restore takes its owner from that record alone, only at the claim's
  // generation, and reserves no generation of its own.
  assert.match(unclaim, /owner: prior\.owner/);
  assert.match(unclaim, /row\.claim_gen !== prior\.generation/);
  assert.doesNotMatch(unclaim, /this\.reserve\(/);
});
