// Atelier 2.0, task 5, the review's fourth round: the locks that serialize a
// push with the changes that end its grant (src/git/locks.mjs) keep their
// order when a waiter gives up, and every Ledger method that writes an item's
// owner, write token or claim generation, or closes an item, is in the one
// table the Node runtime locks by (src/runtime/ledger-locks.mjs).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Locks } from "../src/git/locks.mjs";
import { GRANT_LOCKS } from "../src/runtime/ledger-locks.mjs";

const settled = async (p) => { let done = false; p.then(() => { done = true; }, () => { done = true; }); await new Promise((ok) => setTimeout(ok, 30)); return done; };

test("a waiter that times out leaves the queue, and a later one still waits for the holder before it", async () => {
  const locks = new Locks();
  const a = await locks.acquire("k");
  await assert.rejects(locks.acquire("k", "w", { waitMs: 20 }), (error) => error.code === "push_running");
  const c = locks.acquire("k");
  assert.equal(await settled(c), false, "C does not acquire while A holds the lock");
  a();
  const releaseC = await c;
  assert.equal(locks.idle("k"), false);
  releaseC();
  assert.equal(locks.idle("k"), true);
});

test("a waiter whose signal aborts leaves the queue at once, and readers share while a queued writer holds later readers back", async () => {
  const locks = new Locks();
  const a = await locks.acquire("k");
  const gone = new AbortController();
  const b = locks.acquire("k", "w", { signal: gone.signal });
  gone.abort(new Error("the client went away"));
  await assert.rejects(b, /went away/);
  a();
  assert.equal(locks.idle("k"), true, "nothing is left waiting");

  const r1 = await locks.acquire("p", "r");
  const r2 = await locks.acquire("p", "r");
  const w = locks.acquire("p", "w");
  const r3 = locks.acquire("p", "r");
  assert.equal(await settled(w), false);
  assert.equal(await settled(r3), false, "a reader queued behind a writer waits for it");
  r1(); r2();
  const releaseW = await w;
  assert.equal(await settled(r3), false);
  releaseW();
  (await r3)();
  assert.equal(locks.idle("p"), true);
});

// The Ledger's methods, each with its body, from the class declaration on.
function ledgerMethods(source) {
  const methods = new Map();
  let current = null;
  for (const line of source.slice(source.indexOf("export class Ledger")).split("\n")) {
    const m = /^ {2}(private |async |static |get |set )*([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\(/.exec(line);
    if (m && !["if", "for", "while", "switch", "return", "catch"].includes(m[2])) {
      current = { name: m[2], private: /private/.test(m[1] ?? "") || m[2].startsWith("#"), body: "" };
      methods.set(current.name, current);
    }
    if (/^}/.test(line)) current = null;
    if (current) current.body += `${line.replace(/\/\/.*$/, "")}\n`;
  }
  return methods;
}

// The public Ledger methods that write an item's owner, write token or claim
// generation, or close it, directly or through any method they call, private
// or public (a call through `this` never passes the stub's wrapper), and that
// the lock table does not list.
// The primitives that write: SQL setting token_id, claim_gen or owner, and
// the helpers through which every other write goes.
const GRANT_WRITES = /SET[^`]*\b(token_id|claim_gen|owner)\s*=|dropToken\(|assignOwner\(|update\([^;]*\b(owner:|state: "(?:merged|abandoned|integrated)")/s;
// Task 6: a landing grant counts only while its task is accepted at its head
// and its holder holds the project's landing lease, so the writers of an
// item's head or acceptance and of the landing lease lock too, never as
// "planned" (which takes no lock on an ordinary task).
const LANDING_WRITES = /SET[^`]*\b(head|accepted_head)\s*=|update\([^;]*\b(head:|accepted_head:|state: "accepted")|VALUES \('landing-lease'|DELETE FROM meta WHERE key = 'landing-lease'/s;

function uncovered(source, table = GRANT_LOCKS, WRITES = GRANT_WRITES, allowed = ["task", "planned", "project", "lease"]) {
  const methods = ledgerMethods(source);
  const PRIMITIVES = new Set(["dropToken", "assignOwner", "update"]);
  const writers = new Set([...methods.values()].filter((m) => !PRIMITIVES.has(m.name) && m.name !== "constructor" && WRITES.test(m.body)).map((m) => m.name));
  for (let grew = true; grew;) {
    grew = false;
    for (const m of methods.values()) {
      if (writers.has(m.name) || PRIMITIVES.has(m.name) || m.name === "constructor") continue;
      if ([...writers].some((w) => new RegExp(`this\\.${w.replace("$", "\\$")}\\(`).test(m.body))) { writers.add(m.name); grew = true; }
    }
  }
  const reachable = [...writers].filter((n) => !methods.get(n).private).sort();
  return { reachable, missing: reachable.filter((n) => !allowed.includes(table[n])), methods };
}

const LEDGER = readFileSync(new URL("../src/ledger.ts", import.meta.url), "utf8");

test("every Ledger method that writes an item's owner, write token or claim generation, or closes it, is in the lock table", () => {
  const { reachable, missing, methods } = uncovered(LEDGER);
  assert.ok(reachable.includes("release") && reachable.includes("handoff") && reachable.includes("recordToken"), `the scan found ${reachable.join(", ")}`);
  assert.deepEqual(missing, [], `these Ledger methods write an owner, token or claim generation, or close an item, and take no lock: ${missing.join(", ")}; add them to GRANT_LOCKS in src/runtime/ledger-locks.mjs`);
  for (const [name, scope] of Object.entries(GRANT_LOCKS)) {
    assert.ok(methods.has(name) && !methods.get(name).private, `${name} is a public Ledger method`);
    assert.ok(["task", "planned", "project", "lease"].includes(scope), `${name}: ${scope}`);
  }
});

test("every Ledger method that writes an item's head or acceptance, or the landing lease, takes a lock (task 6)", () => {
  const { reachable, missing } = uncovered(LEDGER, GRANT_LOCKS, LANDING_WRITES, ["task", "project", "lease"]);
  assert.ok(reachable.includes("accept") && reachable.includes("recordPush") && reachable.includes("beginProjectLanding"), `the scan found ${reachable.join(", ")}`);
  assert.deepEqual(missing, [], `these Ledger methods write a head, an acceptance or the landing lease, and take no lock: ${missing.join(", ")}; give them a task, lease or project scope in GRANT_LOCKS`);
});

test("the scan catches a public method that reaches a writer through another public method", () => {
  const anchor = "\n  release(id: string, actor: string, note: string";
  assert.ok(LEDGER.includes(anchor));
  const mutated = LEDGER.replace(anchor, `\n  releaseAlias(id: string, actor: string): Item {\n    return this.release(id, actor, "alias");\n  }\n${anchor}`);
  assert.deepEqual(uncovered(mutated).missing, ["releaseAlias"]);
  // And through a chain of two.
  const chained = mutated.replace("\n  releaseAlias(", `\n  aliasOfAlias(id: string): Item {\n    return this.releaseAlias(id, "x");\n  }\n\n  releaseAlias(`);
  assert.deepEqual(uncovered(chained).missing, ["aliasOfAlias", "releaseAlias"]);
});

test("an acquisition already aborted, or given up, leaves no slot behind", async () => {
  const locks = new Locks();
  const gone = new AbortController();
  gone.abort(new Error("gone"));
  await assert.rejects(locks.acquire("fresh", "w", { signal: gone.signal }), /gone/);
  assert.equal(locks.idle("fresh"), true);
  await assert.rejects(locks.acquireAll([["a", "w"], ["b", "w"]], { signal: gone.signal }), /gone/);
  assert.equal(locks.idle("a") && locks.idle("b"), true);
  const held = await locks.acquire("t");
  await assert.rejects(locks.acquire("t", "w", { waitMs: 10 }), (e) => e.code === "push_running");
  held();
  assert.equal(locks.idle("t"), true);
});
