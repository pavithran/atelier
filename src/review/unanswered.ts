// The skip note of a review released without a verdict UNANSWERED_LIMIT times
// at one head (t238). The runner writes it and the stuck report reads it, so
// the report names that history only for a skip that has it.
export const UNANSWERED_MARK = "times without a verdict";

export function unansweredNote(note: unknown): boolean {
  return typeof note === "string" && note.includes(UNANSWERED_MARK);
}
