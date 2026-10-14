// The project's prose standard (t675): the path of the document the project's
// prose follows, which the developer records with `atelier init
// --prose-standard PATH`. Agents Atelier dispatches write commit messages,
// comments, docs, review findings and reports the developer reads, and the
// prose assessment of 2026-10-14 found that no brief Atelier composed named
// the standard they were to write by. Every brief a build, a plan, a plan's
// part or a review is given carries proseStandardLine, so the pointer is
// written once, here. A project that records none gets no line: the path is
// the project's own, never one machine's default.

export const PROSE_STANDARD_MAX = 300;

// The brief's line naming the standard, or null when the project has none.
// The path is the developer's setting, checked at init to be one line with no
// backticks (src/index.ts), so it cannot close the code span or pose as a
// line of its own.
export function proseStandardLine(path: string | null | undefined): string | null {
  if (!path) return null;
  return `Prose standard: this project's prose follows \`${path}\` (a relative path is from the project's checkout, the folder that holds its AGENTS.md). Load it and follow it before you write any prose it covers: commit messages, code comments, docs, help text, review findings and your report. If you cannot read it from where you work, say so in your report instead of guessing what it says.`;
}
