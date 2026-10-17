// atelier record-merge. Its forms, flags and help are declared in src/usage/commands/record-merge.ts.
import { I, OWNER, args, call, cfg, die, git, itemArg, listArg, project } from "../atelier.mjs";
import { loadPairs } from "../fresh.mjs";
import { realHistory } from "../pull.mjs";

const SHA = /^[a-f0-9]{40,64}$/;

// One --review as the developer gives it: H/M=VERDICT@HEAD, and @WHEN when
// the day or time is known. The server checks the same again.
export function parseReview(text) {
  const m = /^([^=\s]+\/[^=\s]+)=(approve|reject)@([a-f0-9]{40,64})(?:@(\S+))?$/.exec(text);
  if (!m) return null;
  return { by: m[1], verdict: m[2], head: m[3], ...(m[4] ? { at: m[4] } : {}) };
}

// On a baseline built with --history-since the baseline rebuilds every merge
// with one parent, so the merge is checked here, in the checkout, where its
// second parent is intact (t726): it must be the task's head. The baseline
// commit paired with it is what the server then looks for; none paired means
// the baseline lacks the merge, and the developer is sent to atelier sync.
// A checkout whose baseline holds the whole history sends nothing extra.
async function pairedMerge(name, id) {
  const entry = cfg.projects?.[name];
  if (entry?.fresh !== true) return null;
  const cwd = entry.path;
  const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd });
  const pairs = loadPairs(gitDir, name);
  const baselineMerge = Object.keys(pairs).find((b) => pairs[b] === args.merge);
  if (!baselineMerge) die(`the baseline has no commit paired with ${args.merge.slice(0, 8)}; bring main in first (atelier sync) and record again`);
  let head = args.head;
  if (head === undefined) {
    const { item } = await call("GET", I(name, id), undefined, OWNER);
    head = item.head && item.head !== item.base ? item.head : undefined;
  }
  if (!head) die(`${id} has no pushed head; name the commit merged with --head`);
  const line = realHistory(git)(["rev-list", "--parents", "-n", "1", args.merge], { cwd }).split(/\s+/);
  if (line.length < 3) die(`${args.merge.slice(0, 8)} is not a merge in ${cwd}`);
  if (line[2] !== head) die(`${args.merge.slice(0, 8)}'s second parent is ${line[2].slice(0, 8)}, not ${head.slice(0, 8)}, the commit named as the task's head`);
  return baselineMerge;
}

export default async function recordMergeCommand() {
  if (typeof args.merge !== "string" || !SHA.test(args.merge)) die("record-merge needs --merge SHA: the merge commit on main, a full SHA (git rev-parse)");
  if (args.head !== undefined && (typeof args.head !== "string" || !SHA.test(args.head))) die("--head needs the commit merged, a full SHA");
  const given = listArg("review", "record-merge");
  if (!given.length) die("record-merge needs --review H/M=VERDICT@HEAD, once per review that approved the merge");
  const reviews = given.map((text) => parseReview(text) ?? die(`--review ${JSON.stringify(text)} is not H/M=approve@HEAD or H/M=reject@HEAD, with the full head and, optionally, @2026-10-13`));
  if (args.note !== undefined && (typeof args.note !== "string" || !args.note.trim())) die('--note needs text: atelier record-merge ID ... --note "TEXT"');
  const name = project(), id = itemArg();
  const baselineMerge = await pairedMerge(name, id);
  const r = await call("POST", `${I(name, id)}/record-merge`, {
    mergeCommit: args.merge,
    ...(baselineMerge ? { baselineMerge } : {}),
    ...(args.head !== undefined ? { head: args.head } : {}),
    reviews,
    ...(args.note !== undefined ? { note: args.note } : {}),
  }, OWNER);
  const rec = r.record;
  const said = rec.reviews.map((v) => `${v.by} ${v.verdict === "approve" ? "approved" : "rejected"} ${v.head.slice(0, 8)}${v.at ? ` (${v.at})` : ""}`).join("; ");
  console.log(`${id} recorded as merged outside Atelier: ${rec.commit.slice(0, 8)} merged as ${rec.mergeCommit.slice(0, 8)} on main. Reviews as given: ${said}.`);
}
