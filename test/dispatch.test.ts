import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDispatchable, assertDispatchedClaim, assign, describe, liveOffers, makeDispatch, OFFER_FRESH_MS, offering, parseRunner, type LiveOffer, type RunnerOffer } from "../src/dispatch/rules.ts";

const T = "2026-10-04T12:00:00.000Z";
const item = (over: Record<string, unknown> = {}) => ({
  id: "t1", title: "Work", scope: [], state: "open", owner: null, fork: null, base: null, head: null,
  acceptedHead: null, createdAt: T, updatedAt: T, lastPushAt: null, dispatch: null, ...over,
}) as never;

const studio: RunnerOffer = {
  runner: "home:studio", kind: "home",
  agents: [
    { agent: "opencode", models: ["glm-5.3-flash", "qwen3-coder-next"] },
    { agent: "claude-code", models: ["opus-5.5", "sonnet-5.5"] },
  ],
};

test("a dispatch names a kind of runner and, optionally, an agent and a model", () => {
  assert.deepEqual(makeDispatch({}, "pavi", T), { to: "any", agent: null, model: null, by: "pavi", at: T, note: "" });
  assert.equal(makeDispatch({ to: "home", agent: "opencode", model: "glm-5.3-flash" }, "pavi", T).model, "glm-5.3-flash");
  assert.throws(() => makeDispatch({ to: "moon" }, "pavi", T), /cloud, home or any/);
  assert.throws(() => makeDispatch({ agent: "rm -rf /" }, "pavi", T), /not a valid agent/);
});

test("runner names are kind:name", () => {
  assert.deepEqual(parseRunner("home:studio"), { runner: "home:studio", kind: "home" });
  assert.equal(parseRunner(null), null);
  assert.throws(() => parseRunner("laptop"), /not a runner/);
  assert.throws(() => parseRunner("home:"), /not a runner/);
});

test("only an open, unowned task can be dispatched", () => {
  assert.doesNotThrow(() => assertDispatchable(item()));
  assert.throws(() => assertDispatchable(item({ state: "claimed", owner: "codex/gpt-6" })), /owned by codex/);
  assert.throws(() => assertDispatchable(item({ state: "merged" })), /is merged/);
});

test("a runner gets the agent and model a dispatch asks for, or its own first choice", () => {
  const d = (o: Record<string, unknown>) => makeDispatch(o, "pavi", T);
  assert.deepEqual(assign(d({ to: "home", agent: "claude-code", model: "sonnet-5.5" }), studio), { agent: "claude-code", model: "sonnet-5.5", actor: "claude-code/sonnet-5.5" });
  assert.deepEqual(assign(d({ to: "any" }), studio), { agent: "opencode", model: "glm-5.3-flash", actor: "opencode/glm-5.3-flash" });
  assert.deepEqual(assign(d({ model: "qwen3-coder-next" }), studio)?.actor, "opencode/qwen3-coder-next");
  assert.equal(assign(d({ to: "cloud" }), studio), null, "wrong kind of runner");
  assert.equal(assign(d({ agent: "codex" }), studio), null, "agent the runner lacks");
  assert.equal(assign(d({ agent: "claude-code", model: "gpt-6" }), studio), null, "model the agent lacks");
});

test("a dispatched task is claimed only by a matching runner under the requested name", () => {
  const dispatched = item({ dispatch: makeDispatch({ to: "home", agent: "opencode", model: "glm-5.3-flash" }, "pavi", T) });
  const home = parseRunner("home:studio");
  const cloud = parseRunner("cloud:atelier");
  assert.doesNotThrow(() => assertDispatchedClaim(dispatched, "opencode/glm-5.3-flash", home));
  assert.throws(() => assertDispatchedClaim(dispatched, "opencode/glm-5.3-flash", null), /waiting for a home runner; withdraw/);
  assert.throws(() => assertDispatchedClaim(dispatched, "opencode/glm-5.3-flash", cloud), /for a home runner, not cloud:atelier/);
  assert.throws(() => assertDispatchedClaim(dispatched, "claude-code/opus-5.5", home), /asks for opencode/);
  assert.throws(() => assertDispatchedClaim(dispatched, "opencode/qwen3-coder-next", home), /asks for glm-5.3-flash/);
  // Undispatched tasks are claimed as before; dispatch only constrains open tasks.
  assert.doesNotThrow(() => assertDispatchedClaim(item(), "codex/gpt-6", null));
  assert.doesNotThrow(() => assertDispatchedClaim({ ...dispatched, state: "claimed" } as never, "codex/gpt-6", null));
});

test("a dispatch note over its limit is refused, never cut", () => {
  assert.equal(makeDispatch({ note: "n".repeat(500) }, "pavi", T).note, "n".repeat(500));
  assert.throws(() => makeDispatch({ note: "n".repeat(501) }, "pavi", T), /the dispatch note is 501 characters; the limit is 500\. Shorten it and send it again/);
});

test("a dispatch describes itself plainly", () => {
  assert.equal(describe(makeDispatch({ to: "home", agent: "opencode", model: "glm-5.3-flash" }, "pavi", T)), "a home runner, opencode with glm-5.3-flash");
  assert.equal(describe(makeDispatch({}, "pavi", T)), "any runner, its choice of agent");
});

test("AI Studio profile names, with a colon, can be dispatched and claimed; unclaimable names cannot", () => {
  const studioModel = "Qwen3-Coder-Next-4bit:studio-code";
  const d = makeDispatch({ to: "home", agent: "opencode", model: studioModel }, "pavi", T);
  const offer: RunnerOffer = { runner: "home:studio", kind: "home", agents: [{ agent: "opencode", models: ["mlx-community/Qwen3", studioModel] }] };
  assert.deepEqual(assign(d, offer), { agent: "opencode", model: studioModel, actor: `opencode/${studioModel}` });
  assert.doesNotThrow(() => assertDispatchedClaim(item({ dispatch: d }), `opencode/${studioModel}`, parseRunner("home:studio")));
  // An offered model no claim could carry is never handed out, even as a runner's first choice.
  assert.equal(assign(makeDispatch({ to: "home" }, "pavi", T), offer)?.model, studioModel);
  assert.throws(() => makeDispatch({ agent: "open:code" }, "pavi", T), /not a valid agent/);
});

test("runner names are exactly kind:name, normalized, with no further colon", () => {
  assert.throws(() => parseRunner("home:a:b"), /not a runner/);
  assert.deepEqual(parseRunner("HOME:studio"), { runner: "home:studio", kind: "home" });
  // The whole name, so one runner is never two by the case of its name.
  assert.deepEqual(parseRunner("HOME:Studio"), { runner: "home:studio", kind: "home" });
  assert.deepEqual(parseRunner("Cloud:Atelier-1"), { runner: "cloud:atelier-1", kind: "cloud" });
});

// An offer as the index records it: what a runner asked for, with when.
const asked = (runner: string, agents: RunnerOffer["agents"], at: number): LiveOffer =>
  ({ runner, kind: runner.startsWith("cloud") ? "cloud" : "home", agents, at: new Date(at).toISOString() });

test("an offer is live for five minutes after its runner asked, and which runners offer an actor is said by claimable name", () => {
  const now = Date.parse("2026-10-07T12:00:00.000Z");
  const studio = asked("home:studio", [{ agent: "claude-code", models: ["Opus-5.5"] }], now - 10_000);
  const atelier = asked("cloud:atelier", [{ agent: "codex", models: ["gpt-6-astra"] }], now - OFFER_FRESH_MS);
  const gone = asked("home:laptop", [{ agent: "zcode", models: ["glm-5.3"] }], now - OFFER_FRESH_MS - 1);
  const untimed = { ...studio, at: "not a time" };
  assert.deepEqual(liveOffers([studio, atelier, gone, untimed], now), [studio, atelier]);
  // The actors are keyed by the name a claim would use, lowercased; a model no
  // claim could carry is never offered, as assign never hands it out.
  const offered = offering([studio, atelier, asked("home:bad", [{ agent: "opencode", models: ["a b"] }], now)]);
  assert.deepEqual(offered.get("claude-code/opus-5.5"), ["home:studio"]);
  assert.deepEqual(offered.get("codex/gpt-6-astra"), ["cloud:atelier"]);
  assert.equal(offered.has("opencode/a b"), false);
  assert.equal(offered.has("zcode/glm-5.3"), false, "a stale offer offers nothing");
  // Two runners may offer the same actor; both are named.
  const also = asked("home:desk", [{ agent: "codex", models: ["GPT-6-Astra"] }], now);
  assert.deepEqual(offering([atelier, also]).get("codex/gpt-6-astra"), ["cloud:atelier", "home:desk"]);
});
