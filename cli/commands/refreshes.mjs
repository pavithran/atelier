// atelier refreshes. Its forms, flags and help are declared in src/usage/commands/refreshes.ts.
import { OWNER, P, args, call, flat, project, short } from "../atelier.mjs";

// The task refresh queue (t462): each task that should take main, what its
// refresh is doing, and why a busy or blocked one waits.
export default async function refreshesCommand() {
  const name = project();
  if (args.enqueue) {
    const r = await call("POST", `${P(name)}/refreshes`, {}, OWNER);
    console.log(`Main at ${short(r.mainHead)}: ${r.queued ? `${r.queued} task${r.queued === 1 ? "" : "s"} queued to take it` : "every task that should take it was already queued for it"}.`);
  }
  const queue = await call("GET", `${P(name)}/refreshes`, undefined, OWNER);
  if (args.json) return console.log(JSON.stringify(queue, null, 2));
  if (!queue.length) return console.log("No task is waiting to take main.");
  for (const row of queue) console.log(refreshLine(row));
}

// One task's refresh as the queue lists it, with its reason on the next line.
export function refreshLine(row) {
  const t = row.target;
  const doing = row.standing.kind === "deferred" ? `deferred (${row.standing.busy})`
    : t.state === "leased" ? `${t.lease?.job === "resolve" ? "resolving" : "refreshing"} under ${t.lease?.by}${t.lease?.checking ? ", running the checks" : ""}`
      : t.state === "resolve" ? `waiting for its resolver ${t.resolver}`
        : t.state === "waiting" ? "waiting for a resolver"
          : t.state === "returned" ? `returned to its builder${row.owner ? ` ${row.owner}` : ""}`
            : "queued";
  const lines = [`${row.item}  ${row.state}  main ${short(t.mainHead)}  ${doing}  ${row.title}`];
  if (row.standing.kind === "deferred") lines.push(`  why: ${flat(row.standing.reason)}`);
  if (t.state === "waiting" && t.wait) lines.push(`  why: ${flat(t.wait)}`);
  if (t.state === "returned" && t.report) lines.push(`  conflict (${t.report.kind}): ${t.report.files.map((f) => f.path).join(", ")} between ${short(t.report.head)} and main ${short(t.report.main)} (base ${short(t.report.base)})`);
  if (row.last) lines.push(`  last: ${row.last.outcome} from ${short(row.last.expectedHead)} with main ${short(row.last.mainHead)}${row.last.head ? ` as ${short(row.last.head)}` : ""}${row.last.reason ? `: ${flat(row.last.reason)}` : ""}`);
  return lines.join("\n");
}
