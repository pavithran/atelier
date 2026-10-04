// The Queue consumer's only gate: which Artifacts events are worth rereading a
// repository for. The event shape below is the one Cloudflare documents for the
// artifacts.repo source (cf.artifacts.repo.pushed); the hashes are valid
// lowercase hex because the documentation's example strings are placeholders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pushNotice } from "../src/rules.ts";

const BEFORE = "0123456789abcdef0123456789abcdef01234567";
const AFTER = "fedcba9876543210fedcba9876543210fedcba98";
const ZERO = "0".repeat(40);

const SOURCE = { type: "artifacts.repo", namespace: "atelier", repoName: "proj--t1" };
const PAYLOAD = {
  ref: "refs/heads/main",
  before: BEFORE,
  after: AFTER,
  commits: [{
    id: AFTER,
    message: "Fix bug in authentication",
    messageTruncated: false,
    timestamp: "2026-05-01T02:48:57.000Z",
    author: { name: "Developer Name", email: "developer@example.com" },
    committer: { name: "Developer Name", email: "developer@example.com" },
    parents: [BEFORE],
  }],
  totalCommitsCount: 1,
  commitsTruncated: false,
};
const EVENT = {
  type: "cf.artifacts.repo.pushed",
  source: { ...SOURCE },
  payload: { ...PAYLOAD },
  metadata: {
    accountId: "f9f79265f388666de8122cfb508d7776",
    eventSubscriptionId: "1830c4bb612e43c3af7f4cada31fbf3f",
    eventSchemaVersion: 1,
    eventTimestamp: "2026-05-01T02:48:57.132Z",
  },
};

const withSource = (over: Record<string, unknown>) => ({ ...EVENT, source: { ...SOURCE, ...over } });
const withPayload = (over: Record<string, unknown>) => ({ ...EVENT, payload: { ...PAYLOAD, ...over } });
const NOTICE = { repo: "proj--t1", ref: "refs/heads/main", after: AFTER };

test("a push to a branch in this deployment's namespace becomes a notice", () => {
  assert.deepEqual(pushNotice(EVENT), NOTICE);
  // The notice carries only what the consumer acts on; commits, metadata and
  // the rest of the event are left behind.
  assert.deepEqual(Object.keys(pushNotice(EVENT)!).sort(), ["after", "ref", "repo"]);
  // Nothing beyond type, namespace, repository, branch ref and head is read.
  const minimal = {
    type: "cf.artifacts.repo.pushed",
    source: { namespace: "atelier", repoName: "proj--t1" },
    payload: { ref: "refs/heads/main", after: AFTER },
  };
  assert.deepEqual(pushNotice(minimal), NOTICE);
});

test("only cf.artifacts.repo.pushed is a push notice", () => {
  for (const type of [
    "cf.artifacts.repo.created", "cf.artifacts.repo.deleted", "cf.artifacts.repo.forked",
    "cf.artifacts.repo.imported", "cf.artifacts.repo.cloned", "cf.artifacts.repo.fetched",
    "cf.artifacts.repo.token.created", "cf.artifacts.repo.token.revoked",
    "CF.ARTIFACTS.REPO.PUSHED", "cf.artifacts.repo.push", "cf.artifacts.repo.pushed ",
  ]) {
    assert.equal(pushNotice({ ...EVENT, type }), null, type);
  }
  assert.equal(pushNotice({ ...EVENT, type: null }), null);
});

test("the namespace scopes which account events are read", () => {
  assert.equal(pushNotice(withSource({ namespace: "other" })), null);
  assert.equal(pushNotice(withSource({ namespace: "atelier-2" })), null);
  assert.equal(pushNotice(EVENT, "other"), null);
  // A deployment that names a different namespace accepts that one, and only it.
  assert.deepEqual(pushNotice(withSource({ namespace: "other" }), "other"), NOTICE);
});

test("only branch refs are observable", () => {
  for (const ref of [
    "refs/tags/v1.0.0", "refs/notes/atelier", "refs/pull/7/head",
    "main", "refs/heads", "refs/heads-other/main", "",
  ]) {
    assert.equal(pushNotice(withPayload({ ref })), null, ref);
  }
  // Any branch passes the parser: the consumer compares the ref with the
  // repository's default branch and ignores the rest.
  assert.deepEqual(pushNotice(withPayload({ ref: "refs/heads/topic" })), { ...NOTICE, ref: "refs/heads/topic" });
});

test("a branch deletion leaves no head to observe", () => {
  assert.equal(pushNotice(withPayload({ after: ZERO })), null);
  assert.equal(pushNotice(withPayload({ after: "0".repeat(64) })), null);
  // A creation (before all zeros) is an ordinary push; the consumer rereads
  // the repository, so only `after` decides.
  assert.deepEqual(pushNotice(withPayload({ before: ZERO })), NOTICE);
});

test("the head must be lowercase hex, 40 to 64 characters", () => {
  for (const after of [
    AFTER.slice(0, 39), AFTER + AFTER, AFTER + "z", AFTER.toUpperCase(),
    `${AFTER} `, "0x" + AFTER, "g".repeat(40), "",
  ]) {
    assert.equal(pushNotice(withPayload({ after })), null, after);
  }
  assert.equal(pushNotice(withPayload({ after: 123 })), null);
  // Both lengths git uses, SHA-1 and SHA-256, are admitted.
  assert.deepEqual(pushNotice(withPayload({ after: "a".repeat(64) })), { ...NOTICE, after: "a".repeat(64) });
});

test("a notice needs a type, a source, a repository, a branch ref and a head", () => {
  for (const value of [null, undefined, 42, "cf.artifacts.repo.pushed", [], {}]) assert.equal(pushNotice(value), null);
  for (const value of [
    { ...EVENT, source: undefined },
    { ...EVENT, source: null },
    { ...EVENT, source: "atelier" },
    { ...EVENT, source: {} },
    { ...EVENT, source: { ...SOURCE, repoName: "" } },
    { ...EVENT, source: { ...SOURCE, repoName: undefined } },
    { ...EVENT, payload: undefined },
    { ...EVENT, payload: null },
    { ...EVENT, payload: "refs/heads/main" },
    { ...EVENT, payload: {} },
    { ...EVENT, payload: { ...PAYLOAD, ref: undefined } },
    { ...EVENT, payload: { ...PAYLOAD, after: undefined } },
  ]) {
    assert.equal(pushNotice(value), null, JSON.stringify(value));
  }
});
