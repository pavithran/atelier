// atelier unwrap. Its forms, flags and help are declared in src/usage/commands/unwrap.ts.
import { line } from "../../src/decisions.ts";
import { contributorsOf, validActor } from "../../src/rules.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatRunners, readStuck, readyOf, stageEntries, stageLines, stuckLines } from "../status.mjs";
import { UNWRAP_RELAY, fileExcerpt, handoffNotes, sessionNoteText } from "../../src/sessions.ts";
import { OWNER, OWNER_NAME, P, actor, args, at, call, request, checkoutStatusLine, formatStanding, git, project, remoteStatusLines, server, sessionCheckout, sessionFiles, sessionTree } from "../atelier.mjs";

// Bounded task reads; requested dispatches are not evidence of models used.
async function modelLines(name, as, items) {
  const decisions = await request("GET", `${P(name)}/decisions`, undefined, as).catch(() => null);
  const plan = decisions?.decisions?.find((d) => !d.withdrawn && d.status !== "withdrawn" && d.standing?.key === "models");
  if (plan) return [`Models plan: ${line(plan.standing.value)}`];
  const recent = Array.isArray(items) ? [...items].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 5) : [];
  const details = await Promise.all(recent.map((i) => request("GET", `${P(name)}/items/${encodeURIComponent(i.id)}`, undefined, as).catch(() => null)));
  const builds = [], reviews = [];
  for (const [n, item] of recent.entries()) {
    for (const by of contributorsOf(item).filter(validActor)) builds.push(`${line(by)} (${line(item.id)})`);
    for (const r of details[n]?.reviews ?? []) if (validActor(r.by)) reviews.push(`${line(r.by)} (${line(item.id)})`);
  }
  const unknown = !decisions || !Array.isArray(items) || details.some((d) => !d);
  if (!builds.length && !reviews.length && !unknown) return ["Models: no plan set; build: none yet; review: none yet."];
  return [
    `Models: ${decisions ? "no plan set" : "plan could not be read"}; recent tasks used (last ${recent.length} updated tasks):`,
    `  Build: ${[...new Set(builds)].join(", ") || (unknown ? "unknown (record could not be read)" : "none yet")}`,
    `  Review: ${[...new Set(reviews)].join(", ") || (unknown ? "unknown (record could not be read)" : "none yet")}`,
  ];
}

export default async function unwrapCommand() {
  const name = project(), as = await actor(OWNER), cwd = sessionCheckout(name);
  // The stage of each live task is stageOf's, as status and inbox print it.
  const read = await request("GET", P(name), undefined, as).catch(() => null);
  // Open stuck episodes come before the ordinary items (t198).
  const stuck = stuckLines(await readStuck((path) => request("GET", path, undefined, as).catch(() => null), P(name), name, Array.isArray(read?.items) ? read.items : null), "");
  if (stuck.length) console.log(stuck.join("\n"));
  const standing = await call("GET", `${P(name)}/standing`, undefined, as);
  console.log(formatStanding(standing, OWNER_NAME, server()));
  console.log((await modelLines(name, as, read?.items)).join("\n"));
  const mode = await request("GET", `${P(name)}/mode`, undefined, as).catch(() => null);
  const stages = stageLines(stageEntries(read?.items, readyOf(mode)), "");
  if (stages.length) console.log(stages.join("\n"));
  // The runners and what each reported about itself (t234), as status shows them.
  const offers = await request("GET", "/runners", undefined, as).catch(() => null);
  if (Array.isArray(offers)) console.log(formatRunners(offers, Date.now(), args["all-runners"]).join("\n"));
  console.log(await checkoutStatusLine(name, as));
  if (cwd) for (const line of remoteStatusLines(name, cwd)) console.log(line);
  if (cwd) {
    console.log(`Current branch: ${git(["branch", "--show-current"], { cwd }) || "detached HEAD"}`);
    console.log(`Uncommitted files:\n${sessionTree(cwd) || "none"}`);
  }
  const [note] = await call("GET", `${P(name)}/sessions`, undefined, as);
  console.log(sessionNoteText(note));
  if (cwd) {
    const files = sessionFiles(cwd);
    if (files.state) console.log(fileExcerpt(files.state, files.contents));
    else console.log("State file: none (looked for docs/STATE.md, STATE.md and PROJECT.md).");
    for (const path of handoffNotes(files.contents, files.paths, note?.at, files.modified)) console.log(fileExcerpt(path, readFileSync(join(cwd, path), "utf8")));
  }
  console.log(UNWRAP_RELAY);
}
