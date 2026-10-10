// atelier init. Its forms, flags and help are declared in src/usage/commands/init.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkFiles } from "../../src/rules.ts";
import { adapterCheckPaths, adapterClasses, appliesText, checkClasses, classText, knownReadOnly, refusalOf, refusalText } from "../../src/checks.ts";
import { buildHistory, loadPairs, savePairs } from "../fresh.mjs";
import { pushHistory } from "../push-steps.mjs";
import { shipPolicy } from "../ship.mjs";
import { OWNER, OWNER_NAME, P, agentsMdOffer, args, call, cfg, coreArg, die, git, holds, initName, listArg, project, readControlPlane, recordedApproval, saveConfig, short, wsConfig } from "../atelier.mjs";

// The project owner, in the project's checkout.
export default async function initCommand() {
  // A task workspace is a clone claimWorkspace made, named by the project
  // and item in its Git config. Registering it would make the workspace a
  // project called after its folder, so init stops here and says where to run.
  const wsItem = wsConfig("item"), wsProject = wsConfig("project");
  if (wsItem) {
    const path = cfg.projects?.[wsProject]?.path;
    die(`this folder is ${wsProject}/${wsItem}'s task workspace, not a project checkout; nothing was registered. Run atelier init in ${wsProject}'s checkout${path ? `: cd ${JSON.stringify(path)} && atelier init` : ", which is not registered on this Mac."}`);
  }
  const checks = listArg("check", "init"), given = args.multi.protect ? listArg("protect", "init") : null;
  const top = git(["rev-parse", "--show-toplevel"]);
  let name, existing;
  try { ({ name, existing } = initName(cfg.projects, top, args.name, args["rename-local"] === true)); }
  catch (err) { die(err.message); }
  if (args["rename-local"] === true) {
    cfg.projects[name] = cfg.projects[existing];
    if (name !== existing) delete cfg.projects[existing];
    saveConfig(cfg);
    console.log(`Local registration changed from ${existing} to ${name}. No server project or repository was changed.`);
    return;
  }
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: top });
  let cp;
  try { cp = readControlPlane(top); }
  catch (error) { die(`ControlPlane policy could not be read: ${error.message}. Fix the file, then run atelier init again.`); }
  // A ControlPlane project is copied into Artifacts with the owner's
  // approval recorded on it. An init that changes the checks, the title or
  // the policy of a project already registered keeps that approval; it is
  // asked for again when --reset starts the policy over, which drops it,
  // and when --history-since replaces the baseline.
  if (cp && !args.approval) {
    const replaced = args.reset === true ? "--reset starts the policy over" : args["history-since"] !== undefined ? "--history-since replaces the baseline" : null;
    const recorded = replaced ? null : await recordedApproval(name);
    if (!recorded) {
      die(`${name} is governed by ControlPlane, and copying it into Artifacts is an off-machine copy.${replaced ? ` ${replaced}, so the approval recorded on the project does not carry over.` : ""}\nRecord the project owner's approval: atelier init --approval "${OWNER_NAME}, ${new Date().toISOString().slice(0, 10)}: …"`);
    }
  }
  // Only what this command names is sent; the server keeps everything else
  // as it is. --reset starts the policy over from these options and the
  // defaults. A ControlPlane project always sends the policy ControlPlane holds.
  const reset = args.reset === true;
  const protect = given ?? (reset ? [] : cfg.projects?.[name]?.protect ?? []);
  const policy = {};
  if (args.multi.check || reset) policy.checks = checks;
  // Each check must be read-only (src/checks.ts). One that is never
  // read-only is refused here, before any request. The ControlPlane
  // adapter declares the checks it lists as read-only capabilities, and
  // --declare-read-only declares, with the owner's reason, the ones Atelier
  // cannot tell from their words. Without --check, the checks classed are
  // the ones registered now, and only declarations are sent.
  const declaring = args["declare-read-only"];
  if (declaring !== undefined && (typeof declaring !== "string" || !declaring.trim())) die('--declare-read-only needs a reason: atelier init --declare-read-only "why the checks change nothing outside the clone"');
  let registered = null, onServer = false;
  if (!policy.checks && (cp?.adapter || declaring !== undefined)) {
    const list = await call("GET", "/projects", undefined, OWNER);
    onServer = Array.isArray(list) && list.some((p) => p.name === name);
    registered = (Array.isArray(list) ? list.find((p) => p.name === name)?.policy : null) ?? { checks: [] };
  }
  const classed = policy.checks ?? registered?.checks ?? [];
  const fromAdapter = cp?.adapter ? adapterClasses(cp.adapter, classed) : { declarations: [], refusals: [] };
  const byWords = classed.flatMap((cmd) => { const why = refusalOf(cmd); return why ? [refusalText(cmd, why)] : []; });
  const byAdapter = fromAdapter.refusals.filter((r) => !refusalOf(r.command)).map((r) => r.text);
  if (policy.checks && (byWords.length || byAdapter.length)) die(`${[...byWords, ...byAdapter].join(".\n")}.\nNothing was sent.`);
  // A registered check is refused at run time by its words alone; what the adapter says is read here only.
  for (const refusal of byWords) console.log(`Warning: ${refusal}. It is registered, and Atelier runs it nowhere; replace it with atelier init --check.`);
  for (const refusal of byAdapter) console.log(`Warning: ${refusal}. It is registered, and Atelier still runs it, since its words do not show this; replace it with atelier init --check.`);
  const settled = new Set([...fromAdapter.refusals, ...fromAdapter.declarations, ...(registered?.checkClasses ?? [])].map((d) => d.command));
  const needing = classed.filter((cmd) => !refusalOf(cmd) && !knownReadOnly(cmd) && !settled.has(cmd));
  const owned = declaring === undefined ? [] : needing.map((command) => ({ command, by: "owner", note: declaring.trim() }));
  if (declaring !== undefined && !owned.length) console.log("--declare-read-only declared nothing: every check is already known to be read-only.");
  if (fromAdapter.declarations.length || owned.length) policy.checkClasses = [...fromAdapter.declarations, ...owned];
  // The adapter's change_rules say which checks apply to which paths. A
  // first init, or one that names the checks with --check or starts over
  // with --reset, takes them, as it takes protected paths. A re-init that
  // names no check narrows nothing: rules that condition a check to some
  // paths can drop coverage outright, since a change to none of the checks'
  // paths then runs no check at all (on 2026-10-06 Omniscope's check would
  // have applied only to **.py, omniscope/**, tests/**, frontend/** and
  // **.sh, leaving family/** and package.json with no check). The recorded
  // paths stand, and each narrowing the rules would make is named here.
  const fromRules = cp?.adapter ? adapterCheckPaths(cp.adapter, classed) : null;
  const reinit = onServer && !policy.checks;
  if (fromRules && !reinit) policy.checkPaths = fromRules.paths;
  if (fromRules && reinit) {
    for (const rule of fromRules.paths) {
      const current = registered.checkPaths?.find((c) => c.command === rule.command);
      if (current && current.paths.join("\u0000") === rule.paths.join("\u0000")) continue;
      console.log(`Warning: ControlPlane's change rules would set \`${rule.command}\` to apply only when the change touches ${rule.paths.join(", ")}; as registered it applies to ${current ? `${current.paths.join(", ")} only` : "every change"}, and a re-init does not narrow a check's coverage. Take the rules with atelier init --reset.`);
    }
  }
  // The ship order's commands and kinds are recorded with the policy from
  // the checkout's own files, so the gate guards what ship runs like a
  // check's files and the inbox can say a merged revision is not delivered.
  const ship = shipPolicy(top);
  policy.shipRuns = ship.runs;
  policy.shipKinds = ship.kinds;
  if (cp || args.multi.protect || reset) policy.protected = [...new Set([...(cp?.protected ?? ["AGENTS.md", "CLAUDE.md", "wrangler.*"]), ...protect])];
  if (cp) {
    policy.eligible = cp.eligible ?? [];
    if (cp.agents) policy.agents = cp.agents;
    if (cp.execution) policy.execution = cp.execution;
  }
  // --refuse-overlap and --sandbox-only are switches: given, they turn the
  // setting on; given as --sandbox-only=false or --sandbox-only false, off.
  if (cp || args["refuse-overlap"] !== undefined || reset) policy.refuseOverlap = cp?.refuseOverlap ?? args["refuse-overlap"] === true;
  if (args["require-criteria"] !== undefined || reset) policy.requireCriteria = args["require-criteria"] === true;
  if (args["sandbox-only"] !== undefined || reset) policy.sandboxOnly = args["sandbox-only"] === true;
  // --no-override is a switch too (t371): given, overrides of the
  // independent review are refused in the project; --no-override=false
  // allows them again, with the owner's confirmation.
  if (args["no-override"] !== undefined || reset) policy.noOverride = args["no-override"] === true;
  // --core names the core files, once per glob, replacing the recorded
  // ones; --core "" alone clears them, and --reset without it does too.
  const core = coreArg();
  if (core || reset) policy.coreFiles = core ?? [];
  const r = await call("PUT", P(name), {
    ...policy,
    ...(reset ? { reset: true } : {}),
    // The command that regenerates the project's fixtures after a task
    // merges main (atelier land); omitted keeps it, "" clears it.
    ...(args.regenerate !== undefined ? { regenerate: args.regenerate } : {}),
    // What may block a review, stated in every review brief; omitted keeps
    // it, "" restores the default bar.
    ...(args["review-bar"] !== undefined ? { reviewBar: args["review-bar"] } : {}),
    // The top review tier, harness/model actors separated by commas, each
    // reviewing every protected change beside the gate's review; omitted
    // keeps it, "" clears it.
    ...(args["review-tier"] !== undefined ? { reviewTier: args["review-tier"] } : {}),
    approval: args.approval,
    // Omitted keeps the current title; --title "" clears it.
    ...(args.title === undefined ? {} : { title: args.title }),
    defaultBranch: branch,
  }, OWNER);
  // A project too large for Artifacts joins with its recent history only
  // (cli/fresh.mjs). Once set up that way it stays that way: a later init
  // changes the policy and pushes nothing; atelier sync carries new commits.
  const fresh = cfg.projects?.[name]?.fresh === true;
  const since = typeof args["history-since"] === "string" ? args["history-since"] : null;
  if (args["history-since"] === "") die("give the day the baseline's history starts: --history-since YYYY-MM-DD");
  let pushed = "HEAD";
  if (fresh) {
    if (since) die(`${name} already has a baseline from part of its history; use atelier sync to carry new commits`);
  } else if (since) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) die("--history-since takes a day, YYYY-MM-DD");
    if (git(["status", "--porcelain"], { cwd: top })) die("commit or set aside the checkout's changes first; the baseline is built from its commits");
    const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd: top });
    const start = git(["rev-list", "-1", "--first-parent", `--before=${since}T00:00:00`, "HEAD"], { cwd: top });
    if (!start) die(`${branch} has no commit before ${since}`);
    const head = git(["rev-parse", "HEAD"], { cwd: top });
    const built = buildHistory(git, top, start, head);
    // The baseline may already hold the project's original history, which an
    // init that pushed in steps and stopped partway leaves behind without
    // registering the project: --history-since replaces the baseline, so the
    // rebuilt history is pushed over that remainder, on a lease on the tip
    // read here. A baseline this checkout cannot account for (set up from
    // another machine) is left to git to refuse.
    const lease = [];
    if (!cfg.projects?.[name]) {
      const listed = git(["ls-remote", r.baseline.remote, `refs/heads/${branch}`], { cwd: top, token: r.baseline.token, allowFail: true });
      const held = listed.status === 0 ? /^([0-9a-f]{40,64})\s/.exec(listed.stdout)?.[1] ?? null : null;
      if (held && holds(held, head, top)) lease.push(`--force-with-lease=${branch}:${held}`);
    }
    git(["push", "--quiet", "--recurse-submodules=no", ...lease, r.baseline.remote, `${built.head}:refs/heads/${branch}`], { cwd: top, token: r.baseline.token });
    savePairs(gitDir, name, { ...loadPairs(gitDir, name), ...built.pairs });
    pushed = built.head;
    console.log(`Baseline history starts at ${short(start)} (${since}): ${Object.keys(built.pairs).length - 1} commits on ${branch}'s first-parent line rebuilt with the same trees, authors, dates and messages.`);
  } else {
    try { pushHistory(git, top, { remote: r.baseline.remote, token: r.baseline.token, branch, say: console.log }); }
    catch (err) { die(err.message); }
  }
  cfg.projects ??= {};
  cfg.projects[name] = { ...cfg.projects[name], path: top, branch, protect, ...(since || fresh ? { fresh: true } : {}) };
  saveConfig(cfg);
  const pol = r.project.policy;
  console.log(fresh
    ? `${r.project.title ? `${r.project.title} (${name})` : name}: policy updated; the baseline was not pushed (it holds part of the history; atelier sync carries new commits).`
    : `${r.project.title ? `${r.project.title} (${name})` : name}: baseline ${r.project.repo} now holds ${branch} @ ${short(git(["rev-parse", pushed], { cwd: top }))}.`);
  if (cp) console.log(`Policy read from ControlPlane (${cp.sources.join(", ")}).`);
  console.log(`Checks:     ${pol.checks.join(" | ") || "none"}`);
  for (const v of checkClasses(pol)) console.log(`  ${v.command}: ${classText(v)}${pol.checkPaths?.some((c) => c.command === v.command) ? `; ${appliesText(pol, v.command)}` : ""}`);
  if (fromRules?.unrun.length) console.log(`ControlPlane change rules also require ${fromRules.unrun.map((u) => `${u.name} (\`${u.command}\`)`).join(", ")}, which no registered check runs; add one with --check to require it.`);
  console.log(`Ship:       ${pol.shipKinds?.length ? `needs ${pol.shipKinds.join(", ")}; ` : ""}${pol.shipRuns?.length ?? 0} protected command${(pol.shipRuns?.length ?? 0) === 1 ? "" : "s"}`);
  if (pol.regenerate) console.log(`Regenerate: ${pol.regenerate}`);
  console.log(`Review bar: ${pol.reviewBar ?? "the default, which blocks for a correctness, security or data-loss defect, a behaviour change without a test that covers it, docs or help that now contradict the code, a breaking change to a command, route or API field without a migration, or a visible regression on a user-facing page; anything else is a follow-up"}`);
  // A server older than the review bar ignores it and answers without one.
  if (typeof args["review-bar"] === "string" && args["review-bar"].trim() && !pol.reviewBar) console.log("Warning: the server did not record the review bar; deploy the server, then run atelier init --review-bar again.");
  console.log(`Review tier: ${pol.reviewTier?.length ? `${pol.reviewTier.join(", ")}, one of which reviews every protected change: the gate's review goes to the tier first, and a separate tier review is asked only when the gate's reviewer is outside it` : "none"}`);
  if (typeof args["review-tier"] === "string" && args["review-tier"].trim() && !pol.reviewTier?.length) console.log("Warning: the server did not record the review tier; deploy the server, then run atelier init --review-tier again.");
  const checkInputs = checkFiles(pol.checks ?? []);
  console.log(`Protected:  ${[...new Set([...(pol.protected ?? []), ...checkInputs])].sort().join(", ")}`);
  console.log(`Eligible:   ${pol.eligible?.join(", ") || "any agent"}`);
  console.log(`Overlap:    ${pol.refuseOverlap ? "refused" : "flagged"}`);
  console.log(`Overrides:  ${pol.noOverride ? "refused; every change needs its independent review" : "allowed with a reason, once the owner confirms on the task's page with the Access sign-in or the server's confirmation secret"}`);
  // A server older than --no-override ignores it and answers without it.
  if (args["no-override"] === true && !pol.noOverride) console.log("Warning: the server did not record --no-override; deploy the server, then run atelier init --no-override again.");
  console.log(`Criteria:   ${pol.requireCriteria ? "required on every task" : "optional"}`);
  // A server older than the criteria requirement ignores it and answers without one.
  if (args["require-criteria"] === true && !pol.requireCriteria) console.log("Warning: the server did not record the criteria requirement; deploy the server, then run atelier init --require-criteria again.");
  console.log(`Core files: ${pol.coreFiles?.length ? `${pol.coreFiles.join(", ")}; the queue holds a dispatch whose scope overlaps a live item's in one` : "none; the queue holds no dispatch for its scope"}`);
  // A server older than core files ignores them and answers without any.
  if (core?.length && !pol.coreFiles?.length) console.log("Warning: the server did not record the core files; deploy the server, then run atelier init --core again.");
  if (pol.approval) console.log(`Approval:   ${pol.approval}`);
  let agentsMd = null;
  try { agentsMd = readFileSync(join(top, "AGENTS.md"), "utf8"); } catch {}
  const offer = agentsMdOffer(agentsMd);
  if (offer) console.log(`\n${offer}`);
}
