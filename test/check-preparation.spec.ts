import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { CheckRunner, RunRequest, RunState } from "../src/sandbox/runner.ts";

const head = "a".repeat(40), tree = "b".repeat(40);
const prepare = { command: "npm ci", inputs: ["package.json"], outputs: ["node_modules"], declaration: { command: "npm ci", by: "command" as const } };

// Exercise the actual runner and evidence boundary with an in-memory container
// and Artifacts, including tar streaming. No package download or live service.
async function run(id: string, status: number, declared = true, merged = false, evidence: unknown[] = [], skip = false) {
  const calls: string[] = [];
  const request: RunRequest = { runId: id, project: "prepare", itemId: "t1", baselineRepo: "base", fork: "fork", head, checks: ["npm test", "npm run typecheck"], requestedBy: "owner", merged, ...(declared ? { prepare } : {}) };
  if (skip) request.checkPaths = request.checks.map((command) => ({ command, paths: ["src/**"] }));
  const repo = {
    log: async () => [{ hash: head, treeHash: tree, parents: [] }],
    readCommit: async () => ({ hash: head, treeHash: tree, parents: [] }),
    readTree: async () => [],
    [Symbol.dispose]() {},
  };
  const container = {
    running: true, start() {}, destroy: async () => {}, interceptOutboundHttps: async () => {},
    exec: async (argv: string[], options: { stdin?: ReadableStream; cwd?: string }) => {
      const command = argv.at(-1)!;
      const timeout = argv[0] === "timeout";
      if (timeout) {
        expect(options.cwd).toBe("/workspace");
        expect(argv.slice(0, 3)).toEqual(["timeout", "--kill-after=5", "1800"]);
        calls.push(command);
      }
      const exitCode = timeout && command === prepare.command ? status : 0;
      const output = new TextEncoder().encode("x ".repeat(3000) + "Bearer abcdefghijklmnopqrstuvwxyz123456");
      return {
        exitCode: Promise.resolve(exitCode),
        stdout: new Blob([output]).stream(),
        output: async () => {
          if (options.stdin) { const reader = options.stdin.getReader(); while (!(await reader.read()).done) {} }
          return { exitCode, stdout: new Uint8Array(), stderr: new Uint8Array() };
        },
      };
    },
  };
  const stub = env.RUNNER.get(env.RUNNER.idFromName(id));
  const state = await runInDurableObject(stub, async (instance: CheckRunner, storage: DurableObjectState) => {
    const internal = instance as unknown as { ctx: unknown; env: unknown; supplyGit: unknown };
    const original = { ctx: internal.ctx, env: internal.env, supplyGit: internal.supplyGit };
    internal.ctx = { storage: storage.storage, container, exports: { Egress: () => ({}) } };
    internal.env = { ARTIFACTS: { get: async () => repo }, LEDGER: { idFromName: () => "ledger", get: () => ({ addEvidence: async (row: unknown) => evidence.push(row) }) } };
    internal.supplyGit = async () => ({ ok: true, line: "git test" });
    try {
      await storage.storage.put("state", { status: "queued", request, queuedAt: "now" } satisfies RunState);
      await instance.alarm();
      return (await storage.storage.get<RunState>("state"))!;
    } finally { Object.assign(internal, original); }
  });
  return { state, calls, evidence };
}

it("container preparation runs once before checks, including the merged tree", async () => {
  for (const merged of [false, true]) {
    const r = await run(`prepare-success-${merged}`, 0, true, merged);
    expect(r.state.status, r.state.error).toBe("done");
    expect(r.calls).toEqual(["npm ci", "npm test", "npm run typecheck"]);
    expect(r.evidence).toHaveLength(2);
  }
});

it("container preparation failure and timeout add no results or evidence; a new attempt prepares again", async () => {
  const evidence: unknown[] = [{ claim: "earlier evidence" }];
  for (const status of [7, 124]) {
    const r = await run(`prepare-fail-${status}`, status, true, false, evidence);
    expect(r.calls).toEqual(["npm ci"]);
    expect(r.state.status).toBe("failed");
    expect(r.state.results).toEqual([]);
    expect(r.state.error).toContain(`Preparation \`npm ci\` failed: exit ${status}`);
    expect(r.state.error).toContain("last 4000 characters, redacted");
    expect(r.state.error).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(r.state.error!.split("\n")[1]).toHaveLength(4000);
    if (status === 124) expect(r.state.error).toContain("timed out");
    expect(evidence).toEqual([{ claim: "earlier evidence" }]);
  }
  const retried = await run("prepare-retry", 0, true, false, evidence);
  expect(retried.calls[0]).toBe("npm ci");
  expect(evidence).toHaveLength(3);
});

it("container checks without preparation preserve the existing execution order", async () => {
  const r = await run("prepare-absent", 0, false);
  expect(r.state.status, r.state.error).toBe("done");
  expect(r.calls).toEqual(["npm test", "npm run typecheck"]);
});

it("preparation precedes even not-applicable results, and its failure records none", async () => {
  const failed = await run("prepare-na-failure", 7, true, false, [], true);
  expect(failed.state.results).toEqual([]);
  expect(failed.evidence).toEqual([]);
  expect(failed.calls).toEqual(["npm ci"]);
  const success = await run("prepare-na-success", 0, true, false, [], true);
  expect(success.calls).toEqual(["npm ci"]);
  expect(success.state.results).toHaveLength(2);
  expect(success.state.results!.every((r) => r.notApplicable)).toBe(true);
});
