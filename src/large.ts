// Large payloads by reference (t284): a whole check log or a review diff too
// big to carry inline is kept in R2, and briefs and the ledger name it by a
// LargeRef instead — the key says what it is and where it belongs, and the
// sha256, which the key ends with, says what it holds. An 888 KB review diff
// broke a review on 2026-10-07; since then the large thing itself is stored
// once and read by reference, never carried through an argument, a brief or
// an event again.
//
// The bucket (LARGE in wrangler.jsonc) is one the owner creates; with no
// bucket behind the binding nothing is stored and every caller keeps the
// inline payload it always had, so a deployment before the bucket exists
// loses no behaviour.

import { RuleError } from "./rules.ts";

// What a reference names: a whole check log ("logs") or a review diff ("diffs").
export type LargeKind = "logs" | "diffs";

export interface LargeRef {
  key: string;      // the R2 object's key: KIND/project/item/SHA256
  bytes: number;    // the stored payload's size in bytes
  sha256: string;   // the payload's hex SHA-256, which the key ends with
}

// The most one stored payload may hold, in characters. A log or diff over
// this is refused rather than cut: a cut copy under a reference that says
// "the whole output" would lie about what it holds.
export const LARGE_MAX = 32 * 1024 * 1024;

// A stored payload is named by the sha256 of what it holds, hex, 64 digits.
export const LARGE_SHA = /^[a-f0-9]{64}$/;

// The whole of a text too long to keep, as the last LARGE_MAX characters of
// it: a check's output is read from its end, where the failure says what it
// is, and what came before is the most expendable. A capped log is the end of
// the whole log, and the ref's bytes say how much of it was kept.
export function capLarge(text: string): string {
  return text.length > LARGE_MAX ? text.slice(-LARGE_MAX) : text;
}

export function largeKey(kind: LargeKind, project: string, item: string, sha: string): string {
  return `${kind}/${project}/${item}/${sha}`;
}

// The sha256 of a text, hex: the name a stored payload is kept under.
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Stores a payload under the key its own sha256 names, and returns the
// reference to it. Nothing is stored when the binding has no bucket behind
// it or the payload is empty; a payload over LARGE_MAX is refused, not cut.
// Storing what a key already holds writes the same object again, so a repeat
// — a re-claimed review, a re-run check — stores one thing, not two.
export async function putLarge(
  bucket: R2Bucket | null | undefined, kind: LargeKind, project: string, item: string, text: string,
): Promise<LargeRef | null> {
  if (!bucket || !text) return null;
  if (text.length > LARGE_MAX) {
    throw new RuleError("too_large", `a stored ${kind === "logs" ? "check log" : "review diff"} is at most ${LARGE_MAX} characters; this one is ${text.length}. Keep less`, 400);
  }
  const sha256 = await sha256Hex(text);
  const key = largeKey(kind, project, item, sha256);
  const stored = await bucket.put(key, text, { customMetadata: { sha256, at: new Date().toISOString() } });
  return { key, bytes: stored?.size ?? new TextEncoder().encode(text).length, sha256 };
}

// Reads a stored payload back by its key, or null when the object is gone.
export async function getLarge(bucket: R2Bucket | null | undefined, key: string): Promise<string | null> {
  if (!bucket) return null;
  const held = await bucket.get(key);
  return held ? await held.text() : null;
}
