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

// Where the CLI puts a copy of the standard's text inside a workspace (t676).
// An agent outside the developer's checkout (a workspace under ~/Library/Caches,
// a reviewer's throwaway clone, a harness such as opencode that refuses reads
// outside its folder) cannot reach a path relative to that checkout, so the
// CLI copies the text here, under .scratch/, which Git leaves out.
export const PROSE_STANDARD_COPY = ".scratch/prose-standard.md";

// What the CLI made of that copy: its content hash, or why it could not.
export type ProseStandardCopy = { sha256: string } | { failed: string };

// The brief's line naming the standard, or null when the project has none.
// The path is the developer's setting, checked at init to be one line with no
// backticks (src/index.ts), so it cannot close the code span or pose as a
// line of its own. With no copy it points at the path itself, as before; with
// one it points at the copy in the workspace and gives its hash, so a copy
// that has gone stale is detectable; when the copy failed it says so plainly.
export function proseStandardLine(path: string | null | undefined, copy?: ProseStandardCopy | null): string | null {
  if (!path) return null;
  const covers = "commit messages, code comments, docs, help text, review findings and your report";
  if (copy && "sha256" in copy) {
    return `Prose standard: this project's prose follows \`${path}\`, a document outside your workspace. A copy of its text is in your workspace at \`${PROSE_STANDARD_COPY}\` (sha256 ${copy.sha256}; if the hash of that file differs, the copy is not the one this brief was written with, so say so in your report). Load the copy and follow it before you write any prose it covers: ${covers}.`;
  }
  if (copy) {
    const why = copy.failed.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/`/g, "'").slice(0, 300);
    return `Prose standard: this project's prose follows \`${path}\`, but its text could not be copied into your workspace (${why}), so you cannot read it. Say so in your report instead of guessing what it says, and write the prose it covers (${covers}) plainly.`;
  }
  return `Prose standard: this project's prose follows \`${path}\` (a relative path is from the project's checkout, the folder that holds its AGENTS.md). Load it and follow it before you write any prose it covers: ${covers}. If you cannot read it from where you work, say so in your report instead of guessing what it says.`;
}
