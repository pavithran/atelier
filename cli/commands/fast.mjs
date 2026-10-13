// atelier fast. Its forms, flags and help are declared in src/usage/commands/fast.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { I, OWNER, P, actingHeaders, args, call, die, project } from "../atelier.mjs";
import { DEFAULT_REGEN, fastLand, parsePairs } from "../fast.mjs";
import { landedLines, switchMode } from "./mode.mjs";

export default async function fastCommand() {
  const [, sub, ...rest] = args._;
  const name = project();
  if (sub === "status" && !rest.length) {
    const r = await call("GET", `${P(name)}/mode`, undefined, OWNER);
    if (args.json) return console.log(JSON.stringify(r, null, 2));
    console.log(r.line);
    for (const line of landedLines(r.landed)) console.log(line);
    return;
  }
  if (sub === "close" && !rest.length) return void await switchMode(name, "full");
  if (sub !== "land") die(COMMAND_USAGE.fast);
  let pairs;
  try { pairs = parsePairs(rest); } catch (err) { die(`${err.message}: atelier fast land tN=SHA [tM=SHA ...]`); }
  if (args.reviewer !== undefined && (typeof args.reviewer !== "string" || !args.reviewer.includes("/"))) die("--reviewer names harness/model");
  const mode = await call("GET", `${P(name)}/mode`, undefined, OWNER);
  if (mode.mode !== "fast") die(`${mode.line}: switch with atelier mode fast --reason TEXT before landing fast`);
  const titles = {};
  for (const { id } of pairs) {
    const item = await call("GET", I(name, id), undefined, OWNER);
    const it = item.item ?? item;
    if (["merged", "abandoned"].includes(it.state)) die(`${id} is ${it.state}`);
    titles[id] = it.title;
  }
  const cwd = process.cwd();
  const result = await fastLand({
    cwd, pairs, titles, reason: mode.reason,
    typecheck: args.typecheck ?? "npm run typecheck",
    test: args.test ?? "npm test",
    regen: args.regen ?? DEFAULT_REGEN(cwd),
    log: (line) => console.log(line),
    record: (id, receipt) => call("POST", `${I(name, id)}/landed-fast`, { ...receipt, ...(args.reviewer ? { reviewer: args.reviewer } : {}) }, OWNER, actingHeaders()),
  });
  for (const l of result.landed) {
    const review = l.answer?.review;
    const asked = review?.request !== undefined ? `post-merge review request ${review.request} asked of ${review.reviewer}` : review?.error ? `post-merge review not asked: ${review.detail}` : `no post-merge review asked; ask one with atelier review-request ${l.id} --reviewer H/M`;
    console.log(`${l.id} landed in fast mode: ${l.commit.slice(0, 12)} merged as ${l.mergeCommit.slice(0, 12)}, built by ${l.builder}; ${asked}`);
  }
  if (!result.ok) {
    if (result.failure.merged) die(`${result.failure.step} failed: ${result.failure.detail}\nMain holds the checked batch at ${result.head.slice(0, 12)}; record the rest again with atelier fast land.`);
    die(`fast land stopped at ${result.failure.step}; main is back at ${result.start.slice(0, 12)}, nothing was recorded.\n${result.failure.detail}`);
  }
  console.log(`Main is at ${result.head.slice(0, 12)}. Nothing was pushed or deployed. Next: publish main (git push) and deploy (npm run deploy) as you do after a landing.`);
}
