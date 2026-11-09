// The fixed causes of a blocking finding or a failed required check (t536):
// spec, the criteria left it undecided or impossible as written; wiring, built
// but not connected to its callers, routes or pages; failure-path, a crash,
// retry or error path that is wrong; coding, a logic error; tests, tests that
// miss or misjudge the behaviour; docs, docs or help that contradict the
// code. "unknown" is what a finding gets when its cause was not stated, or
// was recorded before causes were asked for; a reviewer cannot choose it.
export const FINDING_CAUSES = ["spec", "wiring", "failure-path", "coding", "tests", "docs"] as const;
export type KnownCause = (typeof FINDING_CAUSES)[number];
export type FindingCause = KnownCause | "unknown";
export const isKnownCause = (v: unknown): v is KnownCause => typeof v === "string" && (FINDING_CAUSES as readonly string[]).includes(v);
