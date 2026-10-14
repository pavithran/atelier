// atelier record-merge. Its forms, flags and help are declared in src/usage/commands/record-merge.ts.
import { I, OWNER, args, call, die, itemArg, listArg, project } from "../atelier.mjs";

const SHA = /^[a-f0-9]{40,64}$/;

// One --review as the developer gives it: H/M=VERDICT@HEAD, and @WHEN when
// the day or time is known. The server checks the same again.
export function parseReview(text) {
  const m = /^([^=\s]+\/[^=\s]+)=(approve|reject)@([a-f0-9]{40,64})(?:@(\S+))?$/.exec(text);
  if (!m) return null;
  return { by: m[1], verdict: m[2], head: m[3], ...(m[4] ? { at: m[4] } : {}) };
}

export default async function recordMergeCommand() {
  if (typeof args.merge !== "string" || !SHA.test(args.merge)) die("record-merge needs --merge SHA: the merge commit on main, a full SHA (git rev-parse)");
  if (args.head !== undefined && (typeof args.head !== "string" || !SHA.test(args.head))) die("--head needs the commit merged, a full SHA");
  const given = listArg("review", "record-merge");
  if (!given.length) die("record-merge needs --review H/M=VERDICT@HEAD, once per review that approved the merge");
  const reviews = given.map((text) => parseReview(text) ?? die(`--review ${JSON.stringify(text)} is not H/M=approve@HEAD or H/M=reject@HEAD, with the full head and, optionally, @2026-10-13`));
  if (args.note !== undefined && (typeof args.note !== "string" || !args.note.trim())) die('--note needs text: atelier record-merge ID ... --note "TEXT"');
  const name = project(), id = itemArg();
  const r = await call("POST", `${I(name, id)}/record-merge`, {
    mergeCommit: args.merge,
    ...(args.head !== undefined ? { head: args.head } : {}),
    reviews,
    ...(args.note !== undefined ? { note: args.note } : {}),
  }, OWNER);
  const rec = r.record;
  const said = rec.reviews.map((v) => `${v.by} ${v.verdict === "approve" ? "approved" : "rejected"} ${v.head.slice(0, 8)}${v.at ? ` (${v.at})` : ""}`).join("; ");
  console.log(`${id} recorded as merged outside Atelier: ${rec.commit.slice(0, 8)} merged as ${rec.mergeCommit.slice(0, 8)} on main. Reviews as given: ${said}.`);
}
