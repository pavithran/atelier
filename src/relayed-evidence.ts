import { RuleError, directionText, ownerDirection, type Evidence } from "./rules.ts";
import { CLAIM_MAX, OUTPUT_MAX, assertLength } from "./text.ts";

// Evidence the orchestrator records at a head for the developer (t497), when
// the run was made on a machine the builder cannot reach: atelier evidence
// ID --head SHA --note TEXT. It is text the developer's token vouched for, so
// it is neither a report (a sender's word about its own work) nor a check
// (a result Atelier's CLI observed). The review brief lists it under a heading
// of its own; the gate never reads it.
export const RELAYED = "relayed" as const;

export type RelayedEntry = Evidence & { grade: typeof RELAYED };
export const isRelayed = (e: { grade: string }): e is RelayedEntry => e.grade === RELAYED;

// The entry a request makes, checked before anything is written. `by` is the
// developer's actor from the caller's trusted identity, and `acting` the model
// the door required; neither is read from the body.
export function relayedEntry(itemId: string, body: Record<string, unknown>, by: string, acting: string | null, at: string): RelayedEntry {
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note) throw new RuleError("bad_note", "evidence needs a note: atelier evidence ID --head SHA --note TEXT", 400);
  assertLength(note, CLAIM_MAX, "the note");
  const head = typeof body.head === "string" ? body.head : "";
  const outputTail = body.outputTail === undefined ? "" : body.outputTail;
  if (typeof outputTail !== "string") throw new RuleError("bad_output", "the file's text must be a string", 400, "send the last OUTPUT_MAX characters of the file as text, as atelier evidence --file does");
  assertLength(outputTail, OUTPUT_MAX, "the file's kept text");
  const length = body.outputLength === undefined ? outputTail.length : body.outputLength;
  if (!Number.isInteger(length) || (length as number) < outputTail.length) throw new RuleError("bad_output", "outputLength is the whole file's length, at least the kept text's", 400, "run atelier evidence ID --head SHA --note TEXT --file PATH");
  const direction = ownerDirection(body.quote, acting, "evidence");
  return {
    itemId, claim: note, grade: RELAYED, head, passed: null, by, at,
    ...(outputTail ? { outputTail, outputLength: length as number } : {}),
    ...(direction ? { quote: direction.quote } : {}),
    ...(acting ? { acting } : {}),
  };
}

// An entry already recorded is the same when its head, note, words and file
// content are, not its time, actor or acting model: each call stamps its own.
export const sameRelayed = (a: Evidence, b: Evidence): boolean =>
  a.grade === RELAYED && b.grade === RELAYED && a.head === b.head && a.claim === b.claim
  && (a.quote ?? "") === (b.quote ?? "") && (a.outputTail ?? "") === (b.outputTail ?? "") && (a.outputLength ?? 0) === (b.outputLength ?? 0);

// How `atelier show` and the review brief say who relayed an entry and on whose
// words, as a decision's words are said (directionText).
export const relayedWords = (e: Evidence): string => (e.quote ? `, on ${directionText({ quote: e.quote, acting: e.acting })}` : "");
export const cutText = (e: Evidence): string =>
  e.outputTail && (e.outputLength ?? 0) > e.outputTail.length ? `cut: the last ${e.outputTail.length} of ${e.outputLength} characters` : "";
