import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITIES, COMMAND_CAPABILITIES, JOB_CAPABILITIES, ROUTE_LEVEL, SERVER_CAPABILITIES,
  buildCapabilities, capabilitiesForLevel, checkCapabilities, requiredForJobs,
} from "../src/route-level.ts";

const need = ["a.one.v1", "a.two.v1"];

test("declarations are well formed, unique, and every requirement is declared", () => {
  assert.equal(new Set(SERVER_CAPABILITIES).size, CAPABILITIES.length);
  const declared = new Set(SERVER_CAPABILITIES);
  for (const names of [...Object.values(COMMAND_CAPABILITIES), ...Object.values(JOB_CAPABILITIES)]) for (const n of names) assert.ok(declared.has(n), n);
  assert.throws(() => buildCapabilities([{ name: "a.b.v1", summary: "x" }, { name: "a.b.v1", summary: "y" }]), /declared twice/);
  for (const name of ["a", "a.b", "A.b.v1", "a.b.v0", "a.b.v1x", ""]) assert.throws(() => buildCapabilities([{ name, summary: "x" }]), /not family\.behaviour\.vN/);
});

test("a server publishing the required names passes, and extra names are accepted", () => {
  assert.deepEqual(checkCapabilities({ capabilities: need }, need), { ok: true, via: "capabilities" });
  assert.equal(checkCapabilities({ capabilities: [...need, "z.extra.v9"], routeLevel: 1 }, need).ok, true);
  assert.equal(checkCapabilities({ capabilities: [] }, []).ok, true);
});

test("a missing capability is named with the server revision and the deployment remedy", () => {
  const r = checkCapabilities({ capabilities: ["a.one.v1"], commit: "0123456789abcdef" }, need);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "missing");
  assert.deepEqual(r.missing, ["a.two.v1"]);
  assert.match(r.message, /lacks capabilities a\.two\.v1/);
  assert.match(r.message, /main at 01234567/);
  assert.match(r.message, /Deploy the server .*npm run deploy/);
  assert.match(checkCapabilities({ capabilities: [] }, need).message, /unrecorded revision/);
});

test("an incompatible revision in a route family does not satisfy the older name", () => {
  const r = checkCapabilities({ capabilities: ["items.brief-criteria.v2"] }, ["items.brief-criteria.v1"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["items.brief-criteria.v1"]);
  assert.equal(checkCapabilities({ capabilities: ["items.brief-criteria.v1", "items.brief-criteria.v2"] }, ["items.brief-criteria.v1"]).ok, true);
});

test("malformed and unavailable answers get their own errors", () => {
  for (const version of [{ capabilities: "a.one.v1" }, { capabilities: [1] }, { capabilities: ["Bad Name"] }, { capabilities: null }, { routeLevel: "20" }, { routeLevel: 1.5 }, { routeLevel: -1 }, {}, { commit: "abc" }]) {
    assert.equal(checkCapabilities(version, need).kind, "malformed", JSON.stringify(version));
  }
  for (const version of [null, undefined, "ok", 5, []]) assert.equal(checkCapabilities(version, need).kind, "unavailable", String(version));
  assert.match(checkCapabilities(null, need).message, /did not answer GET \/api\/version/);
});

test("legacy route levels map to the documented guarantees only", () => {
  assert.deepEqual(capabilitiesForLevel(13), []);
  assert.deepEqual(capabilitiesForLevel(14), ["land.workflow.v1"]);
  assert.deepEqual(capabilitiesForLevel(ROUTE_LEVEL), [...SERVER_CAPABILITIES]);
  assert.deepEqual(capabilitiesForLevel(ROUTE_LEVEL + 5), [...SERVER_CAPABILITIES]);
  assert.equal(checkCapabilities({ routeLevel: 17 }, ["reviews.unparsable.v1"]).ok, true);
  const behind = checkCapabilities({ routeLevel: 17 }, ["reviews.unparsable.v1", "models.note.v1"]);
  assert.equal(behind.kind, "missing");
  assert.deepEqual(behind.missing, ["models.note.v1"]);
  assert.match(behind.message, /route level 17/);
});

test("a legacy server is refused for a requirement no level guarantees", () => {
  const r = checkCapabilities({ routeLevel: ROUTE_LEVEL + 100 }, ["future.thing.v1"]);
  assert.equal(r.kind, "unmapped");
  assert.deepEqual(r.missing, ["future.thing.v1"]);
});

test("old clients against the new server: the server's answer carries routeLevel and capabilities", async () => {
  const answer = { commit: "c0ffee", routeLevel: ROUTE_LEVEL, capabilities: SERVER_CAPABILITIES };
  // an old client reads routeLevel as an integer and never looks at the rest
  assert.ok(Number.isInteger(answer.routeLevel) && answer.routeLevel >= ROUTE_LEVEL);
  // and a new client reading a server that carries both uses the capabilities
  assert.equal(checkCapabilities(answer, COMMAND_CAPABILITIES.land).via, "capabilities");
  assert.equal(checkCapabilities(answer, requiredForJobs(Object.keys(JOB_CAPABILITIES))).ok, true);
});

test("a command or job with no declaration needs nothing", () => {
  assert.deepEqual(requiredForJobs(["unknown-job"]), []);
  assert.equal(COMMAND_CAPABILITIES.help, undefined);
});
