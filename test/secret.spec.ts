import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { type LedgerEvent } from "../src/ledger.ts";
import { parseRuleError, type Evidence, type ProjectPolicy } from "../src/rules.ts";
import { fingerprint } from "../src/secret-scan.ts";

// The secret flag stored end to end through the Ledger Durable Object: the
// push scan sets it, the gate and the merge refuse it, and the project owner
// clears it with a recorded reason. What crosses the RPC boundary is a
// refusal turned back into a status by parseRuleError.

const H0 = "0".repeat(40);
const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const A = "claude-code/opus-5.5";
// An obviously fake key, built at runtime so no key-shaped value sits in the
// file; the hits below carry the fingerprint the scanner would compute for a
// line holding it, never the line.
const FAKE_KEY = ["sk", "proj", "y".repeat(24)].join("-");
const KEY_LINE = `const key = "${FAKE_KEY}";`;
const hit = async (line: number, text = KEY_LINE, file = "src/keys.ts") => ({ file, line, fingerprint: await fingerprint(text) });

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
  const flagged = await L.setSecret("t1", "atelier/events", H1, [await hit(3)]);
  expect(flagged.secret).toEqual([
    { file: "src/keys.ts", line: 3, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), head: H1, by: "atelier/events", at: expect.any(String) },
  ]);
  // No field holds a value, and the event keeps only file and line.
  expect(JSON.stringify(flagged.secret)).not.toContain("sk-");
  expect(JSON.stringify(flagged.secret)).not.toContain(FAKE_KEY);
  const event = ((await L.events("t1")) as unknown as LedgerEvent[]).find((e) => e.kind === "secret.flagged")!;
  expect(event.data).toEqual({ head: H1, hits: [{ file: "src/keys.ts", line: 3 }] });
});

it("a scan for a superseded head does nothing, and a later empty scan clears the flag", async () => {
  const L = await setup("secret-resolve");
  await claimed(L, "secret-resolve--t1");
  await L.setSecret("t1", "atelier/events", H1, [await hit(3)]);
  await L.recordPush("t1", A, H2, H2);
  // A scan computed for the head that just moved is superseded: it does not
  // overwrite the flag the newer head's scan will record.
  await L.setSecret("t1", "atelier/events", H1, [await hit(9)]);
  expect((await L.item("t1")).secret).toMatchObject([{ file: "src/keys.ts", line: 3 }]);
  // The newer head's scan, with no hits, clears the flag.
  await L.setSecret("t1", "atelier/events", H2, []);
  expect((await L.item("t1")).secret).toBeUndefined();
  expect(kinds(await L.events("t1"))).toContain("secret.resolved");
});

it("a later push keeping the secret at the same line re-records the flag for the new head, so it still blocks", async () => {
  const L = await setup("secret-retain");
  await claimed(L, "secret-retain--t1");
  await L.setSecret("t1", "atelier/events", H1, [await hit(3)]);
  await L.recordPush("t1", A, H2, H2);
  // The next push keeps the secret at the same file and line: the flag must
  // move to the new head, not stay naming the old one and so stop blocking.
  await L.setSecret("t1", "atelier/events", H2, [await hit(3)]);
  expect((await L.item("t1")).secret).toMatchObject([{ file: "src/keys.ts", line: 3, head: H2 }]);
  await L.addEvidence(observed("t1", H2));
  await L.submit("t1", A);
  await refusal(L.accept("t1", "owner"), "not_ready", /secret flagged in src\/keys.ts:3/);
});

it("a file left unscanned is recorded as a blocking flag naming the file", async () => {
  const L = await setup("secret-unscanned");
  await claimed(L, "secret-unscanned--t1");
  const flagged = await L.setSecret("t1", "atelier/events", H1, [], [{ file: "big.ts", fingerprint: "b".repeat(40) }]);
  expect(flagged.secret).toMatchObject([{ file: "big.ts", line: 0, fingerprint: "b".repeat(40), head: H1, unscanned: true }]);
  await L.addEvidence(observed("t1", H1));
  await L.submit("t1", A);
  await refusal(L.accept("t1", "owner"), "not_ready", /secret scan could not read big\.ts/);
});

it("accept and merge are refused while the flag stands, with a message naming it", async () => {
  const L = await setup("secret-gate");
  await claimed(L, "secret-gate--t1");
  await L.setSecret("t1", "atelier/events", H1, [await hit(3)]);
  await L.addEvidence(observed("t1", H1));
  await L.submit("t1", A);
  await refusal(L.accept("t1", "owner"), "not_ready", /secret flagged in src\/keys.ts:3/);

  await L.clearSecret("t1", "owner", "a fake key in a test");
  await L.accept("t1", "owner");
  // A different flag that returns before the merge blocks the merge too; the
  // cleared line, found again, does not.
  await L.setSecret("t1", "atelier/events", H1, [await hit(3), await hit(7, `const other = "${FAKE_KEY}";`)]);
  await refusal(L.beginLanding("t1", "owner", H1), "secret", /secret flagged in src\/keys.ts:7/);
});

it("only the owner clears the flag, with a required reason, and the clearing is recorded", async () => {
  const L = await setup("secret-clear");
  await claimed(L, "secret-clear--t1");
  await L.setSecret("t1", "atelier/events", H1, [await hit(3)]);

  await refusal(L.clearSecret("t1", A, "because"), "not_project_owner", /only the project owner clears/);
  await refusal(L.clearSecret("t1", "owner", ""), "secret_reason", /needs a reason/);
  await refusal(L.clearSecret("t1", "owner", "x".repeat(501)), "secret_reason", /at most/);

  const cleared = await L.clearSecret("t1", "owner", "  a fake key in a fixture  ");
  // The flag stays as the record of what the scan found, marked cleared, and
  // the clearance is recorded against the file and fingerprint with its
  // reason and the head it was made at.
  expect(cleared.secret).toMatchObject([{ file: "src/keys.ts", line: 3, head: H1, cleared: true }]);
  expect(cleared.secretClearances).toEqual([
    { file: "src/keys.ts", fingerprint: await fingerprint(KEY_LINE), reason: "a fake key in a fixture", head: H1, by: "owner", at: expect.any(String) },
  ]);
  const event = ((await L.events("t1")) as unknown as LedgerEvent[]).find((e) => e.kind === "secret.cleared")!;
  expect(event.data).toEqual({ reason: "a fake key in a fixture", head: H1, flags: [{ file: "src/keys.ts", line: 3 }] });

  // With nothing standing there is nothing to clear.
  await refusal(L.clearSecret("t1", "owner", "again"), "no_secret", /has no secret flag/);
});

it("a push recorded with its scan pending blocks until that head's own scan completes; a stale result is dropped", async () => {
  const L = await setup("secret-pending");
  await L.newItem("Bring a secret in by accident", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "secret-pending--t1", H0, A);
  // The Worker records the head with its scan pending, in the same write.
  const pushed = await L.recordPush("t1", A, H1, H1, false, undefined, [], true);
  expect(pushed).toMatchObject({ head: H1, secretScan: H1 });
  await L.addEvidence(observed("t1", H1));
  await L.submit("t1", A);
  await refusal(L.accept("t1", "owner"), "not_ready", /secret scan pending for aaaaaaaa/);
  // Nothing has been judged yet, so there is no flag for the owner to clear.
  await refusal(L.clearSecret("t1", "owner", "a fake key"), "secret_pending", /has not completed/);
  // A newer push moves the pending mark to its own head; a result for the
  // older head arriving afterwards is dropped, and the newer scan stands.
  await L.recordPush("t1", A, H2, H2, false, undefined, [], true);
  expect((await L.item("t1")).secretScan).toBe(H2);
  const stale = await L.setSecret("t1", "atelier/events", H1, []);
  expect(stale).toMatchObject({ head: H2, secretScan: H2 });
  expect(stale.secret).toBeUndefined();
  await L.addEvidence(observed("t1", H2));
  await refusal(L.accept("t1", "owner"), "not_ready", /secret scan pending for bbbbbbbb/);
  // The scan of the recorded head completes: its findings are recorded and
  // the pending mark is cleared in the same write, so the flag alone blocks.
  const scanned = await L.setSecret("t1", "atelier/events", H2, [await hit(3)]);
  expect(scanned.secretScan).toBeUndefined();
  expect(scanned.secret).toMatchObject([{ file: "src/keys.ts", line: 3, head: H2 }]);
  await refusal(L.accept("t1", "owner"), "not_ready", /secret flagged in src\/keys.ts:3/);
  await L.clearSecret("t1", "owner", "a fake key in a test");
  await L.accept("t1", "owner");
  // A clean scan completing clears the mark without recording any flag.
  await L.recordPush("t1", A, H1, H1, false, undefined, [], true);
  expect((await L.setSecret("t1", "atelier/events", H1, [])).secretScan).toBeUndefined();
  expect((await L.item("t1")).secret).toBeUndefined();
  // A push recorded without a scan, as the Ledger's own callers record one,
  // marks nothing pending.
  await L.recordPush("t1", A, H2, H2);
  expect((await L.item("t1")).secretScan).toBeUndefined();
});

it("a cleared line stays cleared through a later push that keeps it, moved or not; a changed or new line blocks", async () => {
  const L = await setup("secret-clearance");
  await claimed(L, "secret-clearance--t1");
  await L.setSecret("t1", "atelier/events", H1, [await hit(3)]);
  await L.clearSecret("t1", "owner", "a fake key in a fixture");
  // The next head keeps the identical line, two lines further down: the scan
  // finds it, records it as cleared, and nothing blocks the gate.
  await L.recordPush("t1", A, H2, H2);
  const kept = await L.setSecret("t1", "atelier/events", H2, [await hit(5)]);
  expect(kept.secret).toEqual([
    { file: "src/keys.ts", line: 5, fingerprint: await fingerprint(KEY_LINE), head: H2, by: "atelier/events", at: expect.any(String), cleared: true },
  ]);
  // Events are listed newest first.
  const flagged = ((await L.events("t1")) as unknown as LedgerEvent[]).filter((e) => e.kind === "secret.flagged");
  expect(flagged[0].data).toEqual({ head: H2, hits: [], cleared: [{ file: "src/keys.ts", line: 5 }] });
  await L.addEvidence(observed("t1", H2));
  await L.submit("t1", A);
  await L.accept("t1", "owner");
  // With nothing standing there is nothing further to clear.
  await refusal(L.clearSecret("t1", "owner", "again"), "no_secret", /has no secret flag/);
  // The same line changed by one character, the same line in another file,
  // or another key: each is a new finding, and blocks beside the cleared one.
  await L.recordPush("t1", A, H1, H1);
  const changed = await L.setSecret("t1", "atelier/events", H1, [
    await hit(5),
    await hit(6, `${KEY_LINE} // moved`),
    await hit(1, KEY_LINE, "src/other.ts"),
    await hit(9, `const second = "${FAKE_KEY}";`),
  ]);
  expect(changed.secret!.map((f) => [f.file, f.line, f.cleared ?? false])).toEqual([
    ["src/keys.ts", 5, true], ["src/keys.ts", 6, false], ["src/other.ts", 1, false], ["src/keys.ts", 9, false],
  ]);
  await L.addEvidence(observed("t1", H1));
  await L.submit("t1", A); // the push reopened the accepted item
  await refusal(L.accept("t1", "owner"), "not_ready", /secret flagged in src\/keys.ts:6.*secret flagged in src\/other.ts:1.*secret flagged in src\/keys.ts:9/s);
  expect((await L.item("t1")).secretClearances).toHaveLength(1);
  // Clearing again records a clearance for each new line, and the first stays.
  await L.clearSecret("t1", "owner", "all fakes from the fixture");
  expect((await L.item("t1")).secretClearances).toHaveLength(4);
  await L.accept("t1", "owner");
});

it("a cleared unscanned file stays cleared while its content is unchanged", async () => {
  const L = await setup("secret-clearance-unscanned");
  await claimed(L, "secret-clearance-unscanned--t1");
  await L.setSecret("t1", "atelier/events", H1, [], [{ file: "big.ts", fingerprint: "b".repeat(40) }]);
  await L.clearSecret("t1", "owner", "a generated table, read by hand");
  await L.recordPush("t1", A, H2, H2);
  expect((await L.setSecret("t1", "atelier/events", H2, [], [{ file: "big.ts", fingerprint: "b".repeat(40) }])).secret).toMatchObject([{ file: "big.ts", cleared: true }]);
  await L.addEvidence(observed("t1", H2));
  await L.submit("t1", A);
  await L.accept("t1", "owner");
  // The file changed: its new content was not read, so it blocks again.
  await L.recordPush("t1", A, H1, H1);
  expect((await L.setSecret("t1", "atelier/events", H1, [], [{ file: "big.ts", fingerprint: "c".repeat(40) }])).secret).toMatchObject([{ file: "big.ts", unscanned: true }]);
  await L.addEvidence(observed("t1", H1));
  await refusal(L.accept("t1", "owner"), "not_ready", /secret scan could not read big\.ts/);
});

it("the flag, the clearance and the events never hold the value, only file, line and a digest", async () => {
  const L = await setup("secret-clearance-value");
  await claimed(L, "secret-clearance-value--t1");
  await L.setSecret("t1", "atelier/events", H1, [await hit(3)]);
  await L.clearSecret("t1", "owner", "a fake key in a fixture");
  await L.recordPush("t1", A, H2, H2);
  await L.setSecret("t1", "atelier/events", H2, [await hit(3)]);
  const stored = JSON.stringify([await L.item("t1"), await L.events("t1")]);
  expect(stored).not.toContain(FAKE_KEY);
  expect(stored).not.toContain("sk-proj");
  expect(stored).not.toContain(KEY_LINE);
  expect(stored).toContain(await fingerprint(KEY_LINE));
});
