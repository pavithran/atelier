// The post-merge reviews still owed (t331), as atelier status prints them
// after the fast-mode line: each task named with the state of its review, so
// one that ended without a verdict twice reads as owed rather than in hand.
// `landed` is what fastLandings answers. Null when none is owed.
export const OWED_NAMED = 10;

export function owedReviewsText(landed: readonly { item: string; owed: boolean; review: { state: string } }[]): string | null {
  const owed = landed.filter((l) => l.owed);
  if (!owed.length) return null;
  const named = owed.slice(0, OWED_NAMED).map((l) => `${l.item} (${l.review.state})`).join(", ");
  const more = owed.length > OWED_NAMED ? `, and ${owed.length - OWED_NAMED} more, which atelier fast status lists` : "";
  return `Post-merge review owed: ${named}${more}; ask one with atelier review-request ID --reviewer H/M`;
}

// The mode line with the owed reviews after it, in fast mode only: status
// prints the line only then.
export function modeLineWithOwed(mode: { mode: string; line: string }, landed: Parameters<typeof owedReviewsText>[0]): string {
  const owed = mode.mode === "fast" ? owedReviewsText(landed) : null;
  return owed ? `${mode.line}. ${owed}` : mode.line;
}
