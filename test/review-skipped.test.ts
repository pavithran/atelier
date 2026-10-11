import { test } from "node:test";
import assert from "node:assert/strict";
import { allSkipped } from "../src/landing-verdict.ts";
import type { SeenOffer } from "../src/dispatch/rules.ts";

// The decision a landing's review wait makes each poll (t353): whether every
// runner that offers the named reviewer for the review job has skipped it.

const offer = (runner: string, agent: string, model: string, jobs?: string[]): SeenOffer => ({
  runner, kind: "home", agents: [{ agent, models: [model] }], ...(jobs ? { jobs } : {}), at: new Date().toISOString(),
});

test("allSkipped names the runners when every one that offers the reviewer has skipped", () => {
  const offers = [offer("home:studio", "codex", "gpt-6-astra", ["review"]), offer("home:desk", "codex", "gpt-6-astra", ["review"])];
  // None skipped: still waiting.
  assert.equal(allSkipped("codex/gpt-6-astra", offers, []), null);
  // One of two skipped: still waiting.
  assert.equal(allSkipped("codex/gpt-6-astra", offers, [{ runner: "home:studio" }]), null);
  // Both skipped: named.
  assert.deepEqual(allSkipped("codex/gpt-6-astra", offers, [{ runner: "home:studio" }, { runner: "home:desk" }]), ["home:studio", "home:desk"]);
});

test("allSkipped is null when no live runner offers the reviewer for the review job", () => {
  const offers = [offer("home:studio", "codex", "gpt-6-astra", ["review"])];
  // A reviewer no runner offers.
  assert.equal(allSkipped("claude-code/opus-5.5", offers, [{ runner: "home:studio" }]), null);
  // A runner that offers the reviewer for builds, not reviews.
  const builds = [offer("home:studio", "codex", "gpt-6-astra", ["build"])];
  assert.equal(allSkipped("codex/gpt-6-astra", builds, [{ runner: "home:studio" }]), null);
  // A stale offer counts for nothing.
  const stale = [{ ...offer("home:studio", "codex", "gpt-6-astra", ["review"]), at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }];
  assert.equal(allSkipped("codex/gpt-6-astra", stale, [{ runner: "home:studio" }]), null);
});
