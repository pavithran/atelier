import { test } from "node:test";
import assert from "node:assert/strict";
import { capLarge, getLarge, LARGE_MAX, largeKey, putLarge } from "../src/large.ts";
import { parseRuleError } from "../src/rules.ts";

// A stand-in for the R2 binding: the same put/get/size surface large.ts reads.
function stubBucket() {
  const objects = new Map<string, { text: string; size: number; metadata: Record<string, string> }>();
  return {
    objects,
    async put(key: string, text: string, options?: { customMetadata?: Record<string, string> }) {
      const size = new TextEncoder().encode(text).length;
      objects.set(key, { text, size, metadata: options?.customMetadata ?? {} });
      return { key, size };
    },
    async get(key: string) {
      const held = objects.get(key);
      return held ? { ...held, text: async () => held.text } : null;
    },
  };
}

test("putLarge stores under the payload's own sha256 and answers a reference", async () => {
  const bucket = stubBucket();
  const ref = await putLarge(bucket, "logs", "atelier", "t41", "npm test\nok\n");
  assert.ok(ref);
  assert.equal(ref.key, largeKey("logs", "atelier", "t41", ref.sha256));
  assert.equal(ref.bytes, "npm test\nok\n".length);
  assert.equal(ref.sha256.length, 64);
  assert.match(ref.key, /^logs\/atelier\/t41\/[a-f0-9]{64}$/);
  // The reference names what the bucket holds.
  assert.equal(await getLarge(bucket, ref.key), "npm test\nok\n");
});

test("the same payload stores one object, not two", async () => {
  const bucket = stubBucket();
  const first = await putLarge(bucket, "diffs", "atelier", "t41", "diff --git a/x b/x");
  const again = await putLarge(bucket, "diffs", "atelier", "t41", "diff --git a/x b/x");
  assert.equal(again?.key, first?.key);
  assert.equal(bucket.objects.size, 1);
});

test("nothing is stored with no bucket behind the binding, or for an empty payload", async () => {
  assert.equal(await putLarge(undefined, "logs", "atelier", "t41", "output"), null);
  assert.equal(await putLarge(null, "diffs", "atelier", "t41", "diff"), null);
  const bucket = stubBucket();
  assert.equal(await putLarge(bucket, "logs", "atelier", "t41", ""), null);
  assert.equal(bucket.objects.size, 0);
});

test("a payload over the cap is refused, not cut", async () => {
  const bucket = stubBucket();
  const huge = "x".repeat(LARGE_MAX + 1);
  let thrown: unknown;
  try { await putLarge(bucket, "logs", "atelier", "t41", huge); } catch (err) { thrown = err; }
  const parsed = parseRuleError(thrown);
  assert.equal(parsed?.code, "too_large");
  assert.equal(bucket.objects.size, 0);
});

test("capLarge keeps the end of a too-long text, where a failure says what it is", () => {
  const log = `${"head\n".repeat(1000)}the failing line\n`;
  const capped = capLarge(`${"x".repeat(LARGE_MAX)}${log}`);
  assert.equal(capped.length, LARGE_MAX);
  assert.ok(capped.endsWith("the failing line\n"));
  assert.equal(capLarge("short"), "short");
});

test("getLarge answers null for a key nothing is stored under, and with no bucket", async () => {
  const bucket = stubBucket();
  assert.equal(await getLarge(bucket, "logs/atelier/t41/" + "0".repeat(64)), null);
  assert.equal(await getLarge(undefined, "logs/atelier/t41/" + "0".repeat(64)), null);
});
