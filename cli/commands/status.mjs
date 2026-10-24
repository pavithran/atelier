// atelier status. Its forms, flags and help are declared in src/usage/commands/status.ts.
import { cleanLines, formatUsageWarnings, formatAllDeveloperBranches, formatDeveloperBranches, formatLocal, formatPolicyDisagreements, formatStatus, criteriaJson, criteriaLines, formatStatusBrief, projectInbox, readStuck, readyOf, stageEntries, overdueTick, stageLines, statusJson, stuckLines, tickLines } from "../status.mjs";
import { formatStrays } from "../strays.mjs";
import { formatSlots, slotStatus } from "../load.mjs";
import { CACHE, OWNER, OWNER_NAME, P, actor, args, call, cfg, checkoutStatus, die, formatStanding, landingLease, localStanding, localStrays, liveHere, liveText, pointToGuide, project, registeredHere, request, server, tokenExpiryWarningsText, wsConfig } from "../atelier.mjs";
import { cleanableCount } from "../gc.mjs";
import { mainOf } from "./gc.mjs";
import { expiredBlocks } from "../../src/rules.ts";
import { serverFetch } from "../server-fetch.mjs";

import { bookmarkKey, formatNew, newSince, parseSince, readBookmark, writeBookmark, FIRST_RUN_MS } from "../new-since.mjs";
import { readInstructions } from "../review-notice.mjs";
import { reviewDisagreements } from "../../src/review-notice.ts";

// Usage warnings come first, as the token-expiry warnings do; a server that
// cannot answer leaves the text as it was.
const usageWarnings = (as) => request("GET", "/usage", undefined, as).then((u) => formatUsageWarnings(u), () => []);
const withUsage = (text, lines) => (lines.length ? `${lines.join("\n")}\n\n${text}` : text);

// The owner's queue: decisions waiting, tasks in progress, tasks waiting for a runner.
export default async function statusCommand() {
  if (args.since !== undefined && !args.new) die("--since belongs to status --new");
  if (args.new) return newCommand();
  if (args.brief) {
    const name = args.project ?? wsConfig("project") ?? registeredHere().name;
    if (!name) die("--brief reports on one project: add --project NAME");
    const as = await actor(OWNER);
    // What cannot be read is said in the brief, not fatal to it.
    const soft = (promise) => promise.catch(() => null);
    const [standing, version, queue, usage, lease] = await Promise.all([
      call("GET", `${P(name)}/standing`, undefined, as),
      soft(serverFetch(server() + "/api/version").then((r) => (r.ok ? r.json() : null))),
      soft(request("GET", "/queue", undefined, as)),
      soft(request("GET", "/usage", undefined, as)),
      landingLease(name, as),
    ]);
    const text = formatStatusBrief({ standing, version, queue, lease, usage });
    if (args.json) return console.log(JSON.stringify({ brief: text.split("\n") }, null, 2));
    console.log(text);
    pointToGuide([name]);
    return;
  }
  if (args.project !== undefined) {
    const name = args.project;
    const as = await actor(OWNER);
    const standing = await call("GET", `${P(name)}/standing`, undefined, as);
    const checkout = await checkoutStatus(name, as);
    const local = await localStanding(name, as);
    const live = liveHere(name);
    const path = cfg.projects?.[name]?.path;
    const instructions = path ? readInstructions(path) : [];
    let record = instructions.length ? await request("GET", P(name), undefined, as).catch(() => null) : null;
    const mismatches = record?.project?.policy ? reviewDisagreements(record.project.policy, instructions) : [];
    const testSlots = await slotStatus();
    const strays = localStrays();
    // The developer's branches (t641); null when this server keeps none or
    // could not answer, which the section says. They are the developer's
    // alone, so an agent is not shown the section and the server is not asked.
    const mine = as === OWNER;
    const branches = mine ? await developerBranches(name, as) : null;
    // Open stuck episodes come first (t198); needs the tasks, so they are read here.
    record ??= await request("GET", P(name), undefined, as).catch(() => null);
    // The stuck routes are the developer's alone, like the branches: an agent is not shown them and the server is not asked.
    const stuck = mine ? await readStuck((path) => request("GET", path, undefined, as).catch(() => null), P(name), name, Array.isArray(record?.items) ? record.items : null) : null;
    // The criteria review's state (t179), read with the mode: skipped under fast mode, or held by a deadlock.
    const modeRead = await request("GET", `${P(name)}/mode`, undefined, as).catch(() => null);
    const criteria = { mode: modeRead?.mode === "fast" ? modeRead.line : null, policy: record?.project?.policy ?? null, criteriaDeadlocks: Array.isArray(modeRead?.criteriaDeadlocks) ? modeRead.criteriaDeadlocks : [] };
    const criteriaText = criteriaLines(criteria).join("\n");
    if (args.json) return console.log(JSON.stringify({ project: standing, stuck, ...(criteriaJson(criteria) ? { criteriaReview: criteriaJson(criteria) } : {}), checkout, testSlots, processes: live, ...(mine && branches ? { branches } : {}), ...(mismatches.length ? { mismatches } : {}), ...(local ? { local } : {}), ...(strays.length ? { strayTests: strays } : {}) }, null, 2));
    // The project's tasks, for expired blocks and the clean-up count: the read above when it was made, else one now.
    const items = record?.items;
    const stages = stageEntries(items, readyOf(modeRead));
    const expired = Array.isArray(items) ? expiredBlocks(items, new Date()) : [];
    // The standing's first line names the project; the stuck section follows it, before any ordinary item.
    const withStuck = (text, section) => { if (!section) return text; const i = text.indexOf("\n"); return i < 0 ? text + "\n\n" + section : text.slice(0, i) + "\n\n" + section + text.slice(i); };
    const stuckText = [...stuckLines(stuck, "", false), ...tickLines(stuck)].join("\n");
    const overdue = overdueTick(stuck).map((l) => l + "\n\n").join("");
    console.log(withUsage(tokenExpiryWarningsText(overdue + withStuck(formatStanding(standing, OWNER_NAME, server(), expired), stuckText) + (criteriaText ? "\n\n" + criteriaText : "") + "\n\n" + checkout + (mine ? "\n\n" + formatDeveloperBranches(branches) : "") + (local ? "\n\n" + formatLocal(local) : "") + (stages.length ? "\n\n" + stageLines(stages, "").join("\n") : "") + (strays.length ? "\n\n" + formatStrays(strays) : "") + (mismatches.length ? "\n\n" + formatPolicyDisagreements(mismatches) : "") + "\n\n" + formatSlots(testSlots) + "\n\n" + liveText(live)), await usageWarnings(as)));
    pointToGuide([name]);
    printCleanLines([{ project: name, count: await cleanableCount({ cache: CACHE, name, items, main: mainOf(name) }) }]);
    return;
  }
  const known = await call("GET", "/projects", undefined, OWNER);
  const chosen = known;
  // A project whose notices the server could not read is passed as not read
  // (projectInbox), so the listing says so instead of the read failing.
  const notices = await request("GET", "/inbox?unread=1", undefined, OWNER).catch(() => null);
  // The runner queue and the offers each runner last asked with, so the
  // waiting section can say when a queued job — a review routed to a model
  // no live runner offers, say — can never be claimed, not merely waits
  // (t240), and the Runners section can list what each offers (t246).
  // Either read failing leaves the listing as it was.
  const [queue, offers] = await Promise.all([
    request("GET", "/queue", undefined, OWNER).catch(() => null),
    request("GET", "/runners", undefined, OWNER).catch(() => null),
  ]);
  // A project whose tasks cannot be read is listed as not read (null items),
  // as `atelier inbox` lists it, and the others are still shown.
  const views = await Promise.all(chosen.map(async (p) => {
    const read = await request("GET", P(p.name), undefined, OWNER).catch(() => null);
    // Fast mode's line while it stands (t629), as status --project prints it;
    // a server without the mode route, or one that cannot answer, leaves none.
    const mode = await request("GET", `${P(p.name)}/mode`, undefined, OWNER).catch(() => null);
    const branches = await developerBranches(p.name, OWNER);
    // Where the project's recorded policy and its instructions disagree (t422).
    const path = cfg.projects?.[p.name]?.path;
    const mismatches = read?.project?.policy && path ? reviewDisagreements(read.project.policy, readInstructions(path)) : [];
    // The policy comes along so the listing can say a project runs in
    // single-family mode (formatStatus).
    const items = Array.isArray(read?.items) ? read.items : null;
    const stuck = await readStuck((path) => request("GET", path, undefined, OWNER).catch(() => null), P(p.name), p.name, items);
    return { stuck, name: p.name, title: p.title, items, inbox: projectInbox(notices, p.name), mismatches, policy: p.policy ?? null, mode: mode?.mode === "fast" ? mode.line : null, ready: readyOf(mode), criteriaDeadlocks: Array.isArray(mode?.criteriaDeadlocks) ? mode.criteriaDeadlocks : [], branches };
  }));
  if (args.json) return console.log(JSON.stringify(statusJson(views, server(), Array.isArray(offers) ? offers : null), null, 2));
  const strays = formatStrays(localStrays());
  const branches = formatAllDeveloperBranches(views);
  console.log(withUsage(tokenExpiryWarningsText(formatStatus(views, { queue, offers, server: server() }) + (branches ? "\n\n" + branches : "") + (strays ? "\n\n" + strays : "")), await usageWarnings(OWNER)));
  console.log(liveText(liveHere()));
  console.log(formatSlots(await slotStatus()));
  pointToGuide(chosen.map((p) => p.name));
  printCleanLines(await Promise.all(views.map(async (v) => ({ project: v.name, count: await cleanableCount({ cache: CACHE, name: v.name, items: v.items, main: mainOf(v.name) }) }))));
}

// Last in ordinary text status: what clean would remove, a read-only count.
function printCleanLines(counts) {
  const lines = cleanLines(counts);
  if (lines.length) console.log(`\n${lines.join("\n")}`);
}

// The developer's branches (t641), or null when the server keeps none (one
// deployed before them) or could not answer.
async function developerBranches(name, as) {
  const read = await request("GET", `${P(name)}/branches`, undefined, as).catch(() => null);
  return Array.isArray(read?.branches) ? read.branches : null;
}

// status --new (t43): what someone else filed or edited since this caller last
// looked, for the project --project names, else this checkout's. The time is
// taken before the read, so a --since in the future is refused against it.
// An unread source is printed as unread and ends the command with status 1.
export async function newCommand(deps = {}) {
  const name = args.project ?? wsConfig("project") ?? registeredHere().name;
  if (!name) die("--new reports on one project: add --project NAME");
  const now = (deps.now ?? Date.now)();
  const as = await actor(OWNER);
  const key = bookmarkKey(server(), name, as);
  const file = deps.file;
  let from, how, bookmark = null;
  if (args.since !== undefined) {
    const since = parseSince(args.since, now);
    if (since.error) die(since.error);
    from = { ms: since.ms };
    how = args.since;
  } else {
    const read = readBookmark(key, file);
    if (read.unreadable) return say({ status: "unread", reason: `the bookmark is unreadable (${read.unreadable}); it is kept as it is. Delete the file to start again, or pass --since to read from a time` }, { name, as, how: "the bookmark" });
    bookmark = read.mark;
    from = bookmark ? { seq: bookmark.seq, ms: now - FIRST_RUN_MS } :{ ms: now - FIRST_RUN_MS };
    how = bookmark ? `your last look (${bookmark.at})` : `the last 24 hours (this is the first run for ${as} here; later runs start from the last look)`;
  }
  let record;
  try { record = await request("GET", P(name), undefined, as); } catch (e) {
    return say({ status: "unread", reason: `the project could not be read: ${e?.message ?? e}` }, { name, as, how });
  }
  const result = newSince({ events: record?.events, items: record?.items, as, from });
  if (result.unread) return say({ status: "unread", reason: result.unread }, { name, as, how });
  if (result.behind) how = `the last 24 hours (the bookmark, ${bookmark.at}, is ahead of the server's record, so it was set aside)`;
  const advance = args.since === undefined && result.complete;
  const printed = await say({ status: result.complete ? "ok" : "incomplete", result }, { name, as, how });
  if (!advance || printed === false) return;
  const failed = writeBookmark(key, { seq: result.upper ?? 0, at: new Date(now).toISOString() }, file);
  if (failed) await say({ status: "unread", reason: `the bookmark could not be saved (${failed}); the old one is kept, so the next run shows these again` }, { name, as, how: "the bookmark", after: true });
}

// Prints one outcome as text, --brief text or --json; an unread one, or one that
// could not be saved, sets the exit status. Resolves to true only when the text
// was written to stdout and confirmed (a closed pipe fails without throwing, so
// the write's callback and the stream's error are what say it): false for an
// unread outcome or a failed write, and nothing is printed after a failed one.
async function say(outcome, { name, as, how, after = false }) {
  const unread = outcome.status === "unread";
  if (unread) process.exitCode = 1;
  const text = args.json
    ? JSON.stringify({ project: name, actor: as, since: how, status: outcome.status, ...(unread ? { reason: outcome.reason } : { complete: outcome.result.complete, tasks: outcome.result.tasks }) }, null, 2)
    : unread ? (after ? `Bookmark: unread. ${outcome.reason}.` : formatNew({ result: { unread: outcome.reason }, project: name, as, how, brief: args.brief }))
      : formatNew({ result: outcome.result, project: name, as, how, brief: args.brief });
  const written = await new Promise((done) => {
    const fail = () => done(false);
    process.stdout.once("error", fail);
    try { process.stdout.write(`${text}\n`, (e) => { process.stdout.off("error", fail); done(!e); }); } catch { fail(); }
  });
  if (!written) process.exitCode = 1;
  return written && !unread;
}
