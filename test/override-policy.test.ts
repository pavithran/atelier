import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertOverridesAllowed, confirmationAt, decisionFor, gate, inboxFor, mergedByOverride, NO_OWNER_FACTOR, OVERRIDE_CONFIRMATION_MS, overrideConfirmationHint, overrideOffer, PROTECTED_NEED, reviewOverrideFor,
  type Evidence, type Item, type ProjectPolicy, type Review,
} from "../src/rules.ts";
import { briefFor } from "../src/brief.ts";
import type { Detail } from "../src/ui.ts";

// t371, PAVI's decision of 2026-10-06 carried through: an override of the
// independent review is deliberate. The owner's permission for one from the
// command line names one head and runs out; a project can forbid overrides
// outright, and then nothing offers one; and the merges that went in by
// override are counted. The pure rules, tested without a Worker.

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const T = "2026-10-06T12:00:00.000Z";
const NOW = Date.parse(T);
const policy: ProjectPolicy = { checks: ["npm test"], protected: ["AGENTS.md"] };
const forbidding: ProjectPolicy = { ...policy, noOverride: true };

function item(over: Partial<Item> = {}): Item {
  return {
    id: "t1", title: "Rewrite the agent instructions", scope: [], state: "submitted", owner: "claude-code/opus-5.5", fork: "p--t1", base: "0".repeat(40), head: H1, acceptedHead: null,
    createdAt: T, updatedAt: T, lastPushAt: T, ...over,
  };
}
const pass = (over: Partial<Evidence> = {}): Evidence => ({ itemId: "t1", claim: "npm test", grade: "observed", head: H1, passed: true, by: "owner", at: T, changedPaths: ["AGENTS.md"], ...over });
const review = (by: string, approve = true): Review => ({ itemId: "t1", by, head: H1, criteria: "", approve, note: "", at: T });
const touching = [pass()];

test("t371: the owner's permission for a command-line override stands at its head, from the owner, until it runs out", () => {
  const confirmation = { head: H1, by: "owner", at: T, until: new Date(NOW + OVERRIDE_CONFIRMATION_MS).toISOString() };
  assert.equal(OVERRIDE_CONFIRMATION_MS, 15 * 60 * 1000);
  assert.deepEqual(confirmationAt(item({ overrideConfirmation: confirmation }), NOW), confirmation);
  assert.deepEqual(confirmationAt(item({ overrideConfirmation: confirmation }), NOW + OVERRIDE_CONFIRMATION_MS - 1), confirmation);
  // Run out, at another head, by someone else, or never given: none stands.
  assert.equal(confirmationAt(item({ overrideConfirmation: confirmation }), NOW + OVERRIDE_CONFIRMATION_MS), null);
  assert.equal(confirmationAt(item({ overrideConfirmation: confirmation, head: H2 }), NOW), null);
  assert.equal(confirmationAt(item({ overrideConfirmation: { ...confirmation, by: "codex/gpt-6" } }), NOW), null);
  assert.equal(confirmationAt(item(), NOW), null);
  // A deployment's own owner name is the one that counts.
  assert.equal(confirmationAt(item({ overrideConfirmation: { ...confirmation, by: "pavi" } }), NOW, "pavi")?.by, "pavi");
  assert.equal(confirmationAt(item({ overrideConfirmation: confirmation }), NOW, "pavi"), null);
  // The refusal names the page, the button and the time, on the server
  // asked, and the factor that server takes: the Access sign-in, the
  // confirmation secret, or neither, which says what to set.
  assert.equal(overrideConfirmationHint("demo", "t1", "https://atelier.zone"), 'open https://atelier.zone/p/demo/t1 as the owner, press "Allow an override from the command line" confirming as the owner, then run the command again within 15 minutes; the owner token alone does not confirm it');
  assert.equal(overrideConfirmationHint("demo", "t1", "https://atelier.zone", "access"), 'open https://atelier.zone/p/demo/t1 as the owner, press "Allow an override from the command line" under your Cloudflare Access sign-in, which is the confirmation, then run the command again within 15 minutes; the owner token alone does not confirm it');
  assert.equal(overrideConfirmationHint("demo", "t1", "https://atelier.zone", "secret"), 'open https://atelier.zone/p/demo/t1 as the owner, press "Allow an override from the command line" giving the server\'s confirmation secret (OVERRIDE_SECRET, which no session is given), then run the command again within 15 minutes; the owner token alone does not confirm it');
  assert.equal(overrideConfirmationHint("demo", "t1", "https://atelier.zone", null), `open https://atelier.zone/p/demo/t1 as the owner, press "Allow an override from the command line" confirming as the owner, then run the command again within 15 minutes; ${NO_OWNER_FACTOR}; the owner token alone does not confirm it`);
  assert.match(NO_OWNER_FACTOR, /CF_ACCESS_ISS, CF_ACCESS_AUD and CF_ACCESS_OWNER_EMAIL.*OVERRIDE_SECRET/);
  assert.match(overrideConfirmationHint("my project", "t1"), /^open \/p\/my%20project\/t1 as the owner/);
});

// Round 2: a project that forbids overrides counts none, an override recorded
// before the prohibition included; the gate waits for the review as though
// the override were not there, and offers it again once overrides are allowed.
test("t371: the gate ignores a stored override where the project forbids overrides", () => {
  const overridden = item({ reviewOverride: { head: H1, by: "owner", reason: "No other family", at: T } });
  const allowed = gate(overridden, policy, touching, []);
  assert.deepEqual([allowed.ready, allowed.needsAssessor, allowed.overridden?.head], [true, false, H1]);
  const refused = gate(overridden, forbidding, touching, []);
  assert.deepEqual([refused.ready, refused.needsAssessor, refused.overridden, refused.blockers], [false, true, undefined, [PROTECTED_NEED]]);
  // Another family's approval still clears it there: test/ledger.spec.ts,
  // "an override recorded earlier is ignored once the project forbids overrides".
  // The inbox asks for the review, not the merge.
  assert.deepEqual(inboxFor("proj", [overridden], forbidding, touching, [], new Date(T)).map((x) => x.kind), ["assess"]);
});

test("t371: a project that forbids overrides refuses every override before the reason is read, and offers none", () => {
  assert.doesNotThrow(() => assertOverridesAllowed(policy));
  assert.throws(() => assertOverridesAllowed(forbidding), /403\|override_forbidden\|this project forbids overrides of the independent review \(atelier init --no-override\)/);
  assert.throws(() => reviewOverrideFor(item(), forbidding, touching, [review("owner")], "owner", "No other family", T), /override_forbidden/);
  assert.throws(() => reviewOverrideFor(item(), forbidding, touching, [], "owner", "", T), /override_forbidden/);
  assert.doesNotThrow(() => reviewOverrideFor(item(), policy, touching, [], "owner", "No other family", T));
  // The inbox, the page and the brief say so instead of offering the override.
  const now = new Date(T);
  const entry = (p: ProjectPolicy) => inboxFor("proj", [item()], p, touching, [], now).map((x) => [x.kind, x.reason]);
  assert.deepEqual(entry(policy), [["assess", `${PROTECTED_NEED}; ask a reviewer with atelier land t1 --reviewer H/M, and override only as the owner's last resort`]]);
  assert.deepEqual(entry(forbidding), [["assess", `${PROTECTED_NEED}; ask a reviewer with atelier land t1 --reviewer H/M; this project forbids overrides`]]);
  assert.equal(overrideOffer(policy, true), " If no reviewer qualifies, you can accept with an override and say why.");
  assert.equal(overrideOffer(policy, false), "");
  assert.equal(overrideOffer(forbidding, true), " This project forbids overrides of that review.");
  assert.match(decisionFor(item(), forbidding, touching, [review("owner")]).detail, /Your own approval does not count as that review\. This project forbids overrides of that review\.$/);
  const brief = (p: ProjectPolicy) => {
    const reviews = [review("owner")];
    const d: Detail = { item: item(), policy: p, evidence: touching, reviews, gate: gate(item(), p, touching, reviews), events: [] };
    return briefFor(d, []).recommendation.reason;
  };
  assert.equal(brief(policy), "This revision touches a protected path and needs an approval from a model of another family than every contributor. Your own approval is not that review; if no reviewer qualifies, accept with an override and its reason.");
  assert.equal(brief(forbidding), "This revision touches a protected path and needs an approval from a model of another family than every contributor. Your own approval is not that review. This project forbids overrides of that review.");
});

test("t371: the merges that went in by override are those whose override stands at the merged head", () => {
  const override = { head: H1, by: "owner", reason: "No other family", at: T };
  const merged = (over: Partial<Item> = {}) => item({ state: "merged", acceptedHead: H1, owner: null, ...over });
  const counted = [merged({ id: "t2", reviewOverride: override }), merged({ id: "t5", reviewOverride: override, acceptedHead: null, head: H1 })];
  const not = [
    merged({ id: "t3" }),
    merged({ id: "t4", reviewOverride: { ...override, head: H2 } }),
    merged({ id: "t6", reviewOverride: { ...override, reason: "  " } }),
    item({ id: "t7", state: "accepted", acceptedHead: H1, reviewOverride: override }),
    item({ id: "t8", state: "submitted", reviewOverride: override }),
  ];
  assert.deepEqual(mergedByOverride([...not, ...counted]).map((i) => i.id), ["t2", "t5"]);
  assert.deepEqual(mergedByOverride([]), []);
});
