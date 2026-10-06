import { RuleError } from "./rules.ts";

// Controls and invisible formatting must not hide or reorder readable text.
export const TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\p{Default_Ignorable_Code_Point}]/gu;

// An email address, in angle brackets or bare: text joined by an @ up to the
// spaces, brackets, quotes or punctuation around it. The public showcase
// draws names from commit trailers and titles from the Ledger, and an
// address there is a person's, so it removes each one before drawing. Text
// with no @ is returned as it is.
const ADDRESS = /<[^<>]*@[^<>]*>|[^\s<>()[\]"',;]*@[^\s<>()[\]"',;]+/g;
export function withoutAddresses(text: string): string {
  return text.includes("@") ? text.replace(ADDRESS, " ").replace(/\s+/g, " ").trim() : text;
}

// Text an agent writes into the Ledger (a review, handoff or release note, a
// summary, a report, a check's command and output) is stored, and read back
// by every task view and inbox, so each kind has a stated limit. Text over
// its limit is refused with the limit named, never cut short, so its author
// knows it was not kept.
export const NOTE_MAX = 2000;
export const CLAIM_MAX = 500;
export const OUTPUT_MAX = 4000;

export function assertLength(text: string, max: number, what: string): void {
  if (text.length > max) {
    throw new RuleError("too_long", `${what} is ${text.length} characters; the limit is ${max}. Shorten it and send it again`, 400);
  }
}
