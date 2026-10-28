import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

// t376: a run skip's note is stored with key=value secrets removed, as a
// usage report's text is.

const A = "claude-code/opus-5.5", RUNNER = { runner: "home:studio", kind: "home" as const };

it("a run skip's note loses the values of API_TOKEN=... and PASSWORD=...", async () => {
  const name = "run-skip-redact";
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const at = new Date().toISOString();
  const record = { name, repo: name, createdAt: at, policy: { checks: [], protected: [], coreFiles: [] } };
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  await L.newItem("Holder", ["cli/**"], "owner");
  await L.dispatch("t1", "owner", {});
  await L.claim("t1", A, RUNNER);
  expect(await L.recordRunSkip("t1", RUNNER.runner, A, "unfinished", 1, "API_TOKEN=abc123def456 PASSWORD=hunter2")).toBe(true);
  const stored = JSON.stringify((await L.queued()).waiting);
  expect(stored).not.toContain("abc123def456");
  expect(stored).not.toContain("hunter2");
});
