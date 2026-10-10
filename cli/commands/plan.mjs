// atelier plan. Its forms, flags and help are declared in src/usage/commands/plan.ts.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMMANDS, COMMAND_USAGE } from "../help.mjs";
import { planText } from "../../src/plans/show.ts";
import { I, OWNER, P, actor, args, call, die, flat, listArg, project, short } from "../atelier.mjs";

// The project owner's plans (docs/orchestrator.md, section 6). The word
// after plan names a subcommand when it is one; otherwise the words are
// the goal of a new plan. `plan post` is for the holder of the plan item's
// claim, the planner, and runs as that actor; the rest are the owner's.
// The flags each subcommand takes, from plan.ts; "" is a new plan's.
const SUBCOMMANDS = COMMANDS.plan.subcommands;

export default async function planCommand() {
  const words = args._.slice(1);
  const sub = Object.hasOwn(SUBCOMMANDS, words[0]) ? words[0] : null;
  const form = sub ? `plan ${sub}` : "plan";
  for (const flag of Object.keys(args.multi)) {
    if (!["project", "as", ...(SUBCOMMANDS[sub ?? ""]?.takes ?? [])].includes(flag)) die(`${form} does not take --${flag}; see atelier plan --help`);
  }
  const name = project(), flag = `--project ${name}`;
  if (!sub) {
    const goal = words.join(" ").trim();
    if (!goal) die(COMMAND_USAGE.plan);
    if (args.planner !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(args.planner)) die("--planner needs harness/model, such as claude-code/opus-5.5");
    const scope = listArg("scope", "plan");
    const r = await call("POST", `${P(name)}/items`, { kind: "plan", goal, scope, ...(args.planner ? { planner: args.planner } : {}) }, OWNER);
    console.log(`${r.item.id} is a plan for: ${flat(goal)}`);
    console.log(`Planner: ${r.planner}. ${flat(r.reasons[0] ?? "")}`);
    console.log(`The plan job waits in the queue for ${r.planner}; a runner that offers plan jobs takes it. To plan by hand, claim ${r.item.id} as ${r.planner} with --runner home:NAME, then atelier plan post ${r.item.id} FILE. When a proposal arrives, read it with atelier plan show ${r.item.id} ${flag}.`);
    return;
  }
  const id = words[1];
  if (!id) die(COMMAND_USAGE.plan);
  if (words.length > (sub === "post" ? 3 : 2)) {
    die(`"${words.join(" ")}" reads as ${form} with too many words; ${form} takes ${sub === "post" ? "an id and a file" : "one id"}. If that phrase is the goal, quote it: atelier plan "${words.join(" ")}"`);
  }
  if (sub === "show") {
    const view = await call("GET", `${I(name, id)}/plan`, undefined, await actor(OWNER));
    return console.log(args.json ? JSON.stringify(view, null, 2) : planText(view, name));
  }
  if (sub === "post") {
    const file = words[2] ?? die("atelier plan post ID FILE: name the file that holds the plan document");
    let document;
    try { document = JSON.parse(readFileSync(file, "utf8")); } catch (error) { die(`${file} is not a JSON plan document: ${error.message}`); }
    const r = await call("POST", `${I(name, id)}/plan`, document, await actor());
    console.log(`Proposed ${r.parts} part${r.parts === 1 ? "" : "s"} for ${id} as ${r.hash}.`);
    console.log(`The owner reads it with atelier plan show ${id} and approves that hash. Release your claim: atelier release ${id} ${flag}`);
    return;
  }
  if (sub === "approve") {
    if (typeof args.hash !== "string" || !/^[a-f0-9]{64}$/.test(args.hash)) die(`--hash needs the full hash atelier plan show ${id} prints: atelier plan approve ${id} --hash HASH`);
    const view = await call("POST", `${I(name, id)}/plan/approve`, { hash: args.hash, allowPaid: args["allow-paid"] === true }, OWNER);
    const queued = view.parts.filter((p) => p.dispatch && p.state === "open");
    console.log(`${id} is approved at ${args.hash.slice(0, 12)}: ${view.parts.map((p) => `${p.id} ${p.key}`).join(", ")}.`);
    console.log(queued.length ? `Queued now: ${queued.map((p) => `${p.id} for ${p.dispatch.agent}/${p.dispatch.model}`).join(", ")}.` : "Nothing could start yet.");
    console.log(`Follow it with atelier plan show ${id} ${flag}`);
    return;
  }
  if (sub === "revise") {
    if (typeof args.note !== "string" || !args.note.trim()) die(`--note needs text: atelier plan revise ${id} --note "what to change"`);
    const view = await call("POST", `${I(name, id)}/plan/revise`, { note: args.note }, OWNER);
    console.log(`${id} is back in the queue for its planner, ${view.planner}, with your note. Its next proposal comes to your inbox.`);
    return;
  }
  if (sub === "reroute") {
    if (typeof args.to !== "string" || !args.to.trim()) die(`--to needs harness/model: atelier plan reroute ${id} --to claude-code/opus-5.5`);
    const view = await call("POST", `${I(name, id)}/plan/reroute`, { to: args.to }, OWNER);
    const part = view.parts.find((p) => p.id === id);
    // Only an open part's builder is rerouted, so a part submitted or
    // blocked now had its reviewer named.
    if (part && (part.state === "submitted" || part.state === "blocked")) {
      console.log(`${id} is reviewed by ${args.to.trim()} from now on; ${part.state === "blocked" ? `it is still blocked: ${flat(part.blocked?.reason ?? "")}` : "the plan asks it for the next review the part needs"}.`);
      return;
    }
    console.log(part ? `${id} is built by ${args.to} from now on; ${part.dispatch && part.state === "open" ? "it is queued for it" : `it is ${part.state}, and the plan dispatches it when it may start`}.` : `${id}'s planner is now ${view.planner}, and the plan job is queued for it.`);
    return;
  }
  if (sub === "retry") {
    const view = await call("POST", `${I(name, id)}/plan/retry`, {}, OWNER);
    const part = view.parts.find((p) => p.id === id);
    console.log(part ? `${id}'s attempts count afresh; ${part.dispatch && part.state === "open" ? `it is queued for ${part.dispatch.agent}/${part.dispatch.model}` : `it is ${part.state}`}.${view.blocked ? ` The plan is still blocked: ${flat(view.blocked)}` : ""}` : `${id}'s planner, ${view.planner}, is asked again; the plan job is queued for it.`);
    return;
  }
  // A plan submitted or accepted is put back to building by a refresh,
  // which withdraws the submission and any acceptance first; the server
  // says so with `reopened`.
  const reopenedLine = (view) => view.reopened ? `${id} was ${view.reopened.from === "accepted" ? `accepted at ${short(view.reopened.acceptedHead)}` : "submitted"}; that is withdrawn, and the plan is building again until its branch holds main. The integrator submits it again once every part is integrated.` : null;
  if (sub === "refresh" && args.resolve === true) {
    if (args.to !== undefined && (typeof args.to !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(args.to.trim()))) die(`--to needs harness/model: atelier plan refresh ${id} --resolve --to claude-code/opus-5.5`);
    const view = await call("POST", `${I(name, id)}/plan/refresh`, { resolve: true, ...(args.to !== undefined ? { to: args.to.trim() } : {}) }, OWNER);
    const main = view.refresh?.main ?? "";
    const part = view.parts.find((p) => p.added?.mainHead === main);
    const who = part?.dispatch && part.state === "open" ? `queued for ${part.dispatch.agent}/${part.dispatch.model}` : part ? `${part.state}, and the plan dispatches it before any other part` : "added";
    if (view.reopened) console.log(reopenedLine(view));
    console.log(`${view.item.id} has part ${part ? `${part.id} (${part.key})` : "merge-main"} to merge main at ${main.slice(0, 8)} into its branch: ${who}. Its builder resolves the conflicts; no other part is dispatched until it is integrated.`);
    console.log(`Follow it with atelier plan show ${view.item.id} ${flag}`);
    return;
  }
  if (sub === "refresh") {
    if (args.to !== undefined) die(`--to names the builder of the part --resolve adds: atelier plan refresh ${id} --resolve --to H/M`);
    const view = await call("POST", `${I(name, id)}/plan/refresh`, {}, OWNER);
    if (view.reopened) console.log(reopenedLine(view));
    const main = view.refresh?.last?.mainHead ?? view.refresh?.main ?? "";
    const taken = view.refresh?.taken;
    console.log(`${view.item.id}'s refresh from main at ${main.slice(0, 8)} is queued for atelier/integrator${taken ? `; the branch last took main at ${taken.slice(0, 8)}` : ""}. A runner started with --integrate merges it; parts wait for it before they are dispatched.`);
    console.log(`Follow it with atelier plan show ${view.item.id} ${flag}`);
    return;
  }
  if (sub === "stop") {
    const view = await call("POST", `${I(name, id)}/plan/stop`, { note: args.note ?? "" }, OWNER);
    const closed = [view.item, ...view.parts].filter((i) => i.state === "abandoned").map((i) => i.id);
    console.log(`${id} is stopped: ${closed.join(", ")} ${closed.length === 1 ? "is" : "are"} abandoned, and their write tokens revoked. History and evidence stay. A new plan may start.`);
  }
}
