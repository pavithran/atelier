import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { type LedgerEvent } from "../src/ledger.ts";
import { parseRuleError, type Evidence, type ProjectPolicy } from "../src/rules.ts";

// The secret flag stored end to end through the Ledger Durable Object: the
// push scan sets it, the gate and the merge refuse it, and the project owner
// clears it with a recorded reason. What crosses the RPC boundary is a
// refusal turned back into a status by parseRuleError.

const H0 = "0".repeat(40);
const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const A = "claude-code/opus-5.5";

const policy: ProjectPolicy = { checks: [], protected: [] };

function ledger(project: string) {
  return env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
}

async function setup(project: string) {
  const L = ledger(project);
  await L.setProject({ name: project, repo: `${project}--baseline`, policy, createdAt: new Date().toISOString() }, "owner");
  return L;
}

function observed(itemId: string, head: string, changedPaths: string[] = ["src/keys.ts"]): Evidence {
  return { itemId, claim: "npm test", grade: "observed", head, passed: true, by: "owner", at: new Date().toISOString(), changedPaths };
}

async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(
    () => new Error(`expected a ${code} refusal`),
    (e: unknown) => e as Error,
  );
  const parsed = parseRuleError(err);
  expect(parsed?.code).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

function kinds(events: unknown): string[] {
  return (events as LedgerEvent[]).map((e) => e.kind);
}

async function claimed(L: ReturnType<typeof ledger>, fork: string) {
  await L.newItem("Bring a secret in by accident", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", fork, H0, A);
  await L.recordPush("t1", A, H1, H1);
}

it("a push scan records the flag naming file and line, never a value", async () => {
  const L = await setup("secret-flag");
  await claimed(L, "secret-flag--t1");
  const flagged = await L.setSecret("t1", "atelier/events", H1, [{ file: "src/keys.ts", line: 3 }]);
  expect(flagged.secret).toEqual([
    { file: "src/keys.ts", line: 3, head: H1, by: "atelier/events", at: expect.any(String) },
  ]);
  // No field holds a value, and the event keeps only file and line.
  expect(JSON.stringify(flagged.secret)).not.toContain("sk-");
  const event = ((await L.events("t1")) as unknown as LedgerEvent[]).find((e) => e.kind === "secret.flagged")!;
  expect(event.data).toEqual({ head: H1, hits: [{ file: "src/keys.ts", line: 3 }] });
});

it("a scan for a superseded head does nothing, and a later empty scan clears the flag", async () => {
  const L = await setup("secret-resolve");
  await claimed(L, "secret-resolve--t1");
  await L.setSecret("t1", "atelier/events", H1, [{ file: "src/keys.ts", line: 3 }]);
  await L.recordPush("t1", A, H2, H2);
  // A scan computed for the head that just moved is superseded: it does not
  // overwrite the flag the newer head's scan will record.
  await L.setSecret("t1", "atelier/events", H1, [{ file: "src/keys.ts", line: 9 }]);
  expect((await L.item("t1")).secret).toMatchObject([{ file: "src/keys.ts", line: 3 }]);
  // The newer head's scan, with no hits, clears the flag.
  await L.setSecret("t1", "atelier/events", H2, []);
  expect((await L.item("t1")).secret).toBeUndefined();
  expect(kinds(await L.events("t1"))).toContain("secret.resolved");
});

it("accept and merge are refused while the flag stands, with a message naming it", async () => {
  const L = await setup("secret-gate");
  await claimed(L, "secret-gate--t1");
  await L.setSecret("t1", "atelier/events", H1, [{ file: "src/keys.ts", line: 3 }]);
  await L.addEvidence(observed("t1", H1));
  await L.submit("t1", A);
  await refusal(L.accept("t1", "owner"), "not_ready", /secret flagged in src\/keys.ts:3/);

  await L.clearSecret("t1", "owner", "a fake key in a test");
  await L.accept("t1", "owner");
  // A flag that returns before the merge blocks the merge too.
  await L.setSecret("t1", "atelier/events", H1, [{ file: "src/keys.ts", line: 3 }]);
  await refusal(L.beginLanding("t1", "owner", H1), "secret", /secret flagged in src\/keys.ts:3/);
});

it("only the owner clears the flag, with a required reason, and the clearing is recorded", async () => {
  const L = await setup("secret-clear");
  await claimed(L, "secret-clear--t1");
  await L.setSecret("t1", "atelier/events", H1, [{ file: "src/keys.ts", line: 3 }]);

  await refusal(L.clearSecret("t1", A, "because"), "not_project_owner", /only the project owner clears/);
  await refusal(L.clearSecret("t1", "owner", ""), "secret_reason", /needs a reason/);
  await refusal(L.clearSecret("t1", "owner", "x".repeat(501)), "secret_reason", /at most/);

  const cleared = await L.clearSecret("t1", "owner", "  a fake key in a fixture  ");
  expect(cleared.secret).toBeUndefined();
  const event = ((await L.events("t1")) as unknown as LedgerEvent[]).find((e) => e.kind === "secret.cleared")!;
  expect(event.data).toEqual({ reason: "a fake key in a fixture", head: H1 });

  // With nothing standing there is nothing to clear.
  await refusal(L.clearSecret("t1", "owner", "again"), "no_secret", /has no secret flag/);
});
