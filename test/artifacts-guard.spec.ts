import { afterEach, expect, it } from "vitest";
import { bindingsWith, expectNoStrayArtifactsAccess, strayArtifactsAccesses } from "./support/artifacts-fake.ts";

// The guard behind bindingsWith: a member a fake lacks is recorded even when
// the caller swallows the error, and the assertion then fails the test.

afterEach(() => { expectNoStrayArtifactsAccess(); });

it("records a member the fake lacks even when the caller swallows the throw", async () => {
  const b = bindingsWith({}, { get: async () => ({ log: async () => [] }) }) as unknown as { ARTIFACTS: { get(r: string): Promise<Record<string, () => unknown>> } };
  const repo = await b.ARTIFACTS.get("r");
  await repo.log();
  expect(strayArtifactsAccesses()).toEqual([]);
  try { repo.createToken(); } catch { /* swallowed, as mainHeadOf does */ }
  expect(strayArtifactsAccesses()).toEqual(["repo.r.createToken"]);
  expect(() => expectNoStrayArtifactsAccess()).toThrow(/repo\.r\.createToken/);
  expect(strayArtifactsAccesses()).toEqual([]);
});
