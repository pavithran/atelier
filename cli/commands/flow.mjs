// atelier flow. Forms, flags and help live in src/usage/commands/flow.ts; the
// phases are defined in docs/flow.md and computed by src/flow.ts from the
// events the item route already returns, so no server route is needed.
import { readFileSync } from "node:fs";
import { formatScorecard, computeFlow, computeBars, formatBars } from "../../src/flow.ts";
import { computeCriteriaWriting, formatCriteriaWriting } from "../../src/usage/criteria-writing.ts";
import { I, OWNER, P, actor, args, call, die, project, request } from "../atelier.mjs";
import { collectEvents } from "./events.mjs";

const DEFAULT_SINCE = "7d";
// An ISO date or time, or a span back from now: 3d, 12h.
function sinceMs(text, now) {
  const span = /^(\d+(?:\.\d+)?)([dh])$/.exec(text);
  if (span) return now - Number(span[1]) * (span[2] === "d" ? 86_400_000 : 3_600_000);
  const at = Date.parse(text);
  if (!Number.isFinite(at)) die(`--since ${text} is not an ISO date or time or a span such as 3d or 12h`, 2);
  return at;
}

// --bars: the redesign's bars over the last 7 days, for --project if named,
// else every project, with an overall line, then how the criteria were
// written (src/usage/criteria-writing.ts). Weighted tokens are not recorded
// in the ledger; --tokens FILE is a JSON object of item id (or project/id) to
// weighted tokens.
async function barsCommand() {
  let tokens;
  if (args.tokens !== undefined) {
    try { tokens = JSON.parse(readFileSync(String(args.tokens), "utf8")); }
    catch (error) { die(`--tokens ${args.tokens} is not a readable JSON file: ${error.message}`, 2); }
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens) || !Object.values(tokens).every((v) => Number.isFinite(v))) die("--tokens needs a JSON object of item id to a number", 2);
  }
  const listed = args.project ? null : await call("GET", "/projects", undefined, OWNER);
  const names = args.project ? [args.project] : Array.isArray(listed) ? listed.map((p) => p.name) : [];
  const projects = [];
  for (const name of names) {
    const events = await collectEvents((before) => call("GET", `${P(name)}/events${before === undefined ? "" : `?before=${before}`}`, undefined, OWNER));
    projects.push({ name, events });
  }
  const now = Date.now();
  const report = computeBars(projects, now, tokens);
  // How the criteria were written (t536), from the same events.
  const writing = computeCriteriaWriting(projects, now);
  if (args.json) return console.log(JSON.stringify({ ...report, criteriaWriting: writing }, null, 2));
  for (const line of formatBars(report)) console.log(line);
  console.log("");
  for (const line of formatCriteriaWriting(writing)) console.log(line);
}

export default async function flowCommand() {
  if (args.bars) return barsCommand();
  const name = project(), as = await actor(OWNER), now = Date.now();
  const since = sinceMs(typeof args.since === "string" ? args.since : DEFAULT_SINCE, now);
  const listed = await request("GET", P(name), undefined, as);
  const chosen = (listed.items ?? []).filter((item) => Date.parse(item.createdAt) >= since);
  // A few reads at a time: each task's events come from its own route.
  const tasks = new Array(chosen.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, chosen.length) }, async () => {
    while (next < chosen.length) {
      const i = next++;
      const d = await request("GET", I(name, chosen[i].id), undefined, as);
      tasks[i] = { id: chosen[i].id, events: d.events ?? [] };
    }
  }));
  const report = computeFlow(tasks, now);
  if (args.json) return console.log(JSON.stringify({ project: name, since: new Date(since).toISOString(), observedAt: new Date(now).toISOString(), ...report }, null, 2));

  for (const line of formatScorecard(report)) console.log(line);
}
