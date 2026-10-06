import { test } from "node:test";
import assert from "node:assert/strict";
import { agentRoute, inScope, sha256, tokenActive, tokenFromBytes, tokenOptions } from "../src/tokens.ts";

test("tokens encode at least 256 bits with a recognisable prefix", () => {
  assert.equal(tokenFromBytes(new Uint8Array(32)), "atl_" + "00".repeat(32));
  assert.match(tokenFromBytes(new Uint8Array(32).fill(255)), /^atl_[a-f0-9]{64}$/);
  assert.throws(() => tokenFromBytes(new Uint8Array(31)));
});

test("SHA-256 has the standard digest and does not retain the input", async () => {
  assert.equal(await sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("issuance validates identity, expiry and metadata", () => {
  const now = Date.parse("2026-10-05T00:00:00Z");
  const input = { actor: "codex/gpt-6-astra" };
  assert.equal(tokenOptions(input, "owner", now).expiresAt, "2026-11-04T00:00:00.000Z");
  assert.equal(tokenOptions({ ...input, days: 365 }, "owner", now).expiresAt, "2027-10-05T00:00:00.000Z");
  for (const actor of ["owner", "codex", "a/b/c", "a b/c", 5, null]) assert.throws(() => tokenOptions({ actor }, "owner", now));
  assert.throws(() => tokenOptions(input, input.actor, now));
  for (const days of [0, 366, -1, 1.5, "30", NaN, null]) assert.throws(() => tokenOptions({ ...input, days }, "owner", now));
  for (const projects of [null, "p", [1], [""], [" p"], ["p/q"]]) assert.throws(() => tokenOptions({ ...input, projects }, "owner", now));
  assert.throws(() => tokenOptions({ ...input, label: false }, "owner", now));
  assert.deepEqual(tokenOptions({ ...input, projects: ["p", "p"] }, "owner", now).projects, ["p"]);
});

test("scope is exact, absent means all and empty means none", () => {
  assert.equal(inScope({}, ["p"]), true);
  assert.equal(inScope({ projects: [] }, ["p"]), false);
  assert.equal(inScope({ projects: ["p"] }, ["p"]), true);
  for (const name of ["P", "prefix", "p/other"]) assert.equal(inScope({ projects: ["p"] }, [name]), false);
  // A renamed project answers to each name it has had, so a token issued for any of them reaches it.
  assert.equal(inScope({ projects: ["p"] }, ["q", "p"]), true);
  assert.equal(inScope({ projects: ["q"] }, ["q", "p"]), true);
  assert.equal(inScope({ projects: ["r"] }, ["q", "p"]), false);
});

test("expiry is exclusive and revocation takes effect immediately", () => {
  const token = { ...tokenOptions({ actor: "codex/gpt-6" }, "owner", 0), id: "id", hash: "hash" };
  const end = Date.parse(token.expiresAt);
  assert.equal(tokenActive(token, end - 1), true);
  assert.equal(tokenActive(token, end), false);
  assert.equal(tokenActive({ ...token, revokedAt: token.createdAt }, 1), false);
});

test("route policy grants workflow operations and defaults to refusing", () => {
  const task = ["projects", "p", "items", "t1"];
  for (const verb of ["claim", "read-token", "push", "evidence", "sandbox", "review", "submit", "handoff", "release"]) {
    assert.equal(agentRoute("POST", [...task, verb]), true, verb);
  }
  for (const verb of ["accept", "merged", "landing", "abandon", "dispatch", "undispatch", "future"]) {
    assert.equal(agentRoute("POST", [...task, verb]), false, verb);
  }
  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    for (const root of ["tokens", "models", "future"]) assert.equal(agentRoute(method, [root]), false);
  }
  assert.equal(agentRoute("POST", ["projects", "p", "items"]), false);
  assert.equal(agentRoute("PUT", ["projects", "p"]), false);
  assert.equal(agentRoute("DELETE", ["projects", "p"]), false);
  assert.equal(agentRoute("POST", ["projects", "p", "baseline-token"], { scope: "write" }), false);
  assert.equal(agentRoute("POST", ["projects", "p", "baseline-token"], { scope: "read" }), true);
  for (const path of [["config"], ["projects"], ["inbox"], ["queue"], ["projects", "p"], [...task], [...task, "brief"], [...task, "diff"], [...task, "sandbox", "run"]]) assert.equal(agentRoute("GET", path), true, path.join("/"));
  assert.equal(agentRoute("POST", [...task, "claim", "extra"]), false);
});
