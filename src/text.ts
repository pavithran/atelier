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
// Text only the owner writes and every runner and page reads back: the note
// on a dispatch and the approval recorded with a policy.
export const OWNER_TEXT_MAX = 500;
// The project's review bar, which every review brief states: a paragraph,
// longer than a note on a dispatch, short beside the brief it sits in.
export const REVIEW_BAR_MAX = 1000;
// The most models a project's review tier lists (`atelier init --review-tier`).
export const REVIEW_TIER_MAX = 10;
// The most diff a review brief carries inline (BRIEF_LIMITS.diff in
// src/review/brief.ts). A larger diff is never carried: it is kept in R2 by
// reference and the brief names where the whole diff is (t284), so a brief's
// size never depends on the size of the change it reviews.
export const DIFF_INLINE_MAX = 40_000;

export function assertLength(text: string, max: number, what: string): void {
  if (text.length > max) {
    throw new RuleError("too_long", `${what} is ${text.length} characters; the limit is ${max}. Shorten it and send it again`, 400);
  }
}
