import { postMergeArgs } from "../post-merge-policy.mjs";
// atelier init. Its forms, flags and help are declared in src/usage/commands/init.ts.
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { PROSE_TEXT_MAX } from "../../src/prose-standard.ts";
import { checkFiles, parseRiskReviews, preparationPaths } from "../../src/rules.ts";
import { limitText } from "../../src/check-limit.ts";
import { appliesText, checkClasses, classText, knownReadOnly, refusalOf, refusalText } from "../../src/checks.ts";
import { discoverPrivate, guardedPush, moveProjectEntryOnDisk, privateGuardFor, remoteBases } from "../private-guard.mjs";
import { shipPolicy } from "../ship.mjs";
import { familyModeText } from "../status.mjs";
import { deployGateLines, packageScripts } from "../deploy-gate.mjs";
import { OWNER, P, agentsMdOffer, apiToken, args, call, cfg, coreArg, die, git, holds, initName, listArg, project, saveConfig, short, tailnetHost, wsConfig } from "../atelier.mjs";

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
    // The old name stays with the entry as a former name, so a task
    // workspace still named it stays guarded (t645).
    // Made in config.json under its lock, and followed in memory.
    const moved = moveProjectEntryOnDisk(cfg.projects, existing, name);
    if (moved.error) die(moved.error);
    console.log(`Local registration changed from ${existing} to ${name}. No server project or repository was changed.`);
    return;
  }
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: top });
  // Only what this command names is sent; the server keeps everything else
  // as it is. --reset starts the policy over from these options and the
  // defaults. A ControlPlane checkout's files are not read (t149).
  const reset = args.reset === true;
  // --risk-reviews JSON replaces the reviews each risk class needs (t631,
  // t756); off sends null, which clears them; omitted keeps them. An invalid
  // value is refused here, before any request, by the rule the server applies.
  let riskReviews;
  if (args["risk-reviews"] !== undefined) {
    if (args["risk-reviews"] === "off") riskReviews = null;
    else {
      let parsed;
      try { parsed = JSON.parse(args["risk-reviews"]); }
      catch { die(`--risk-reviews needs JSON or off: ${JSON.stringify(args["risk-reviews"])} is not valid JSON. Nothing was sent.`); }
      try { riskReviews = parseRiskReviews(parsed); }
      catch (error) { die(`--risk-reviews: ${error.message}. Nothing was sent.`); }
    }
  }
  const protect = given ?? (reset ? [] : cfg.projects?.[name]?.protect ?? []);
  const policy = {};
  if (args["criteria-review"] !== undefined || reset) {
    const timing = args["criteria-review"] ?? "before";
    if (timing !== "parallel" && timing !== "before") die("--criteria-review needs parallel or before. Nothing was sent.");
    policy.criteriaReview = timing;
    if (args["criteria-review"] !== undefined) policy.requireCriteriaReview = true;
  }
  const postMerge = postMergeArgs(args);
  if (postMerge !== undefined && args.multi?.["post-merge"]) {
    // The server's support is land.post-merge.v1, which init declares and
    // the CLI checked before this handler ran (t458).
    policy.postMerge = postMerge;
  }
  if (args.multi.check || reset) policy.checks = checks;
  // Each check must be read-only (src/checks.ts). One that is never
  // read-only is refused here, before any request. The ControlPlane
  // adapter declares the checks it lists as read-only capabilities, and
  // --declare-read-only declares, with the owner's reason, the ones Atelier
  // cannot tell from their words. Without --check, the checks classed are
  // the ones registered now, and only declarations are sent.
  const declaring = args["declare-read-only"];
  if (declaring !== undefined && (typeof declaring !== "string" || !declaring.trim())) die('--declare-read-only needs a reason: atelier init --declare-read-only "why the checks change nothing outside the clone"');
  let registered = null;
  if (!policy.checks && declaring !== undefined) {
    const list = await call("GET", "/projects", undefined, OWNER);
    registered = (Array.isArray(list) ? list.find((p) => p.name === name)?.policy : null) ?? { checks: [] };
  }
  if (args["prepare-input"] !== undefined || args["prepare-output"] !== undefined) {
    if (!args.prepare) die("--prepare-input and --prepare-output require --prepare CMD");
  }
  if (args.prepare !== undefined) {
    if (typeof args.prepare !== "string") die("--prepare needs a command");
    if (args.prepare === "") policy.prepare = null;
    else {
      const command = args.prepare.trim();
      if (!command) die("--prepare needs a nonempty command, or an empty value to clear it");
      const why = refusalOf(command);
      if (why) die(`${refusalText(command, why)}.\nNothing was sent.`);
      let inputs, outputs;
      try {
        inputs = preparationPaths(listArg("prepare-input", "init"));
        outputs = preparationPaths(listArg("prepare-output", "init"));
      } catch (error) { die(error.message); }
      const declaration = (!knownReadOnly(command) && declaring !== undefined ? { command, by: "owner", note: declaring.trim() } : undefined);
      policy.prepare = { command, inputs, outputs, ...(declaration ? { declaration } : {}) };
    }
  }
  const classed = policy.checks ?? registered?.checks ?? [];
  const byWords = classed.flatMap((cmd) => { const why = refusalOf(cmd); return why ? [refusalText(cmd, why)] : []; });
  if (policy.checks && byWords.length) die(`${byWords.join(".\n")}.\nNothing was sent.`);
  // A registered check is refused at run time by its words alone.
  for (const refusal of byWords) console.log(`Warning: ${refusal}. It is registered, and Atelier runs it nowhere; replace it with atelier init --check.`);
  const settled = new Set([...(registered?.checkClasses ?? [])].map((d) => d.command));
  const needing = classed.filter((cmd) => !refusalOf(cmd) && !knownReadOnly(cmd) && !settled.has(cmd));
  const owned = declaring === undefined ? [] : needing.map((command) => ({ command, by: "owner", note: declaring.trim() }));
  if (declaring !== undefined && !owned.length && !policy.prepare?.declaration) console.log("--declare-read-only declared nothing: every check is already known to be read-only.");
  if (owned.length) policy.checkClasses = owned;
  // The ship order's commands and kinds are recorded with the policy from
  // the checkout's own files, so the gate guards what ship runs like a
  // check's files and the inbox can say a merged revision is not delivered.
  const ship = shipPolicy(top);
  policy.shipRuns = ship.runs;
  policy.shipKinds = ship.kinds;
  if (args.multi.protect || reset) policy.protected = [...new Set(["AGENTS.md", "CLAUDE.md", "wrangler.*", ...protect])];
  // --refuse-overlap is a switch: given, it turns the setting on; given as
  // --refuse-overlap=false or --refuse-overlap false, off.
  if (args["refuse-overlap"] !== undefined || reset) policy.refuseOverlap = args["refuse-overlap"] === true;
  if (args["require-criteria"] !== undefined || reset) policy.requireCriteria = args["require-criteria"] === true;
  if (args["require-criteria-review"] !== undefined || reset) policy.requireCriteriaReview = args["require-criteria-review"] === true || args["criteria-review"] !== undefined;
  // --no-override is a switch too (t371): given, overrides of the
  // independent review are refused in the project; --no-override=false
  // allows them again, with the owner's confirmation.
  if (args["no-override"] !== undefined || reset) policy.noOverride = args["no-override"] === true;
  // --core names the core files, once per glob, replacing the recorded
  // ones; --core "" alone clears them, and --reset without it does too.
  const core = coreArg();
  if (core || reset) policy.coreFiles = core ?? [];
  // --single-family COMPANY has the project build and review with one
  // company's models alone; --cross-family returns to the default, where
  // a protected change needs a model of another company than every
  // contributor. Omitted, the recorded mode stays; the server records
  // either switch with who made it and when.
  if (args["single-family"] !== undefined && args["cross-family"] === true) die("--single-family and --cross-family contradict each other; give one of them");
  const singleFamily = args["single-family"] !== undefined ? args["single-family"] : args["cross-family"] === true ? null : undefined;
  // The commit identity (t451): each flag given replaces what is recorded,
  // and the server checks the whole and refuses an invalid one. A list
  // flag given once as "" clears its list.
  if (args["commit-name"] !== undefined) policy.commitName = args["commit-name"];
  if (args["commit-email"] !== undefined) policy.commitEmail = args["commit-email"];
  for (const [flag, field] of [["agent-email", "agentEmails"], ["private-email", "privateEmails"], ["public-mirror", "publicMirrors"]]) {
    const values = args.multi[flag];
    if (values) policy[field] = values.length === 1 && values[0] === "" ? [] : values;
  }
  // The prose standard's text goes with its path (Atelier 2.0, task 5), so a
  // claim can hand it to a builder that has no checkout to read it from.
  const proseText = proseStandardText(top, args["prose-standard"]);
  const r = await call("PUT", P(name), {
    ...policy,
    ...(args["clear-secret"] !== undefined ? { clearSecret: args["clear-secret"], quote: args.quote } : {}),
    ...(reset ? { reset: true } : {}),
    // The command that regenerates the project's fixtures after a task
    // merges main (atelier land); omitted keeps it, "" clears it.
    ...(args.regenerate !== undefined ? { regenerate: args.regenerate } : {}),
    // The affected-tests declaration (G20), read from a JSON file in the
    // checkout; omitted keeps it, "" clears it.
    ...(args["affected-tests"] !== undefined ? { affectedTests: affectedTestsArg(top, args["affected-tests"]) } : {}),
    // What may block a review, stated in every review brief; omitted keeps
    // it, "" restores the default bar.
    ...(args["review-bar"] !== undefined ? { reviewBar: args["review-bar"] } : {}),
    // The path of the document the project's prose follows, named in every
    // build, plan and review brief (t675); omitted keeps it, "" clears it.
    ...(args["prose-standard"] !== undefined ? { proseStandard: args["prose-standard"] } : {}),
    ...(proseText ? { proseStandardText: proseText } : {}),
    // The check limit (G7): the hard ceiling and the silence limit, in
    // minutes from the held test slot, and the checks with a silence limit
    // of their own (CMD=MINUTES, once per check); omitted keeps them, ""
    // returns to the default (or clears the checks' own).
    ...(args["check-limit"] !== undefined ? { checkLimitMinutes: args["check-limit"] } : {}),
    ...(args["silence-limit"] !== undefined ? { silenceLimitMinutes: args["silence-limit"] } : {}),
    ...(args["startup-limit"] !== undefined ? { startupLimitMinutes: args["startup-limit"] } : {}),
    ...(args["slot-wait-limit"] !== undefined ? { slotWaitLimitMinutes: args["slot-wait-limit"] } : {}),
    ...(args["build-limit"] !== undefined ? { buildLimitMinutes: args["build-limit"] } : {}),
    ...(args.multi["check-silence"] ? { checkSilence: args.multi["check-silence"].length === 1 && args.multi["check-silence"][0] === "" ? [] : args.multi["check-silence"] } : {}),
    // The model that triages a landing's diff against the task's criteria
    // before its review (t475), harness/model; omitted keeps it, "" clears it.
    ...(args.triage !== undefined ? { triage: args.triage } : {}),
    // The frontier models that may resolve a refresh's mechanical conflicts
    // (t462), harness/model actors separated by commas; omitted keeps
    // them, "" clears them.
    ...(args.resolver !== undefined ? { resolvers: args.resolver } : {}),
    ...(riskReviews !== undefined ? { riskReviews } : {}),
    ...(singleFamily !== undefined ? { singleFamily } : {}),
    approval: args.approval,
    // Omitted keeps the current title; --title "" clears it.
    ...(args.title === undefined ? {} : { title: args.title }),
    defaultBranch: branch,
  }, OWNER);
  // The server mints no token for the developer's push of the project's
  // branch: the developer pushes with the server token (docs/branches.md).
  r.baseline.token = apiToken();
  // The repository is the baseline, and once its branch exists only a
  // landing moves it (task 6): a later init records the policy and pushes
  // nothing (Atelier 2.0, task 11). What the checkout holds that the
  // server's branch lacks is said, with the way it gets there.
  const serverHead = serverBranchHead(r.baseline.remote, branch, top, r.baseline.token);
  // No commit the repository lacks may carry a private file (t645). A list
  // in iCloud opts a registered project in first.
  if (cfg.projects?.[name]) privateGuardFor(name, { discover: true });
  // A first init, of a project this Mac does not register yet, finds its
  // iCloud folder as clone does and reads its list before the first push,
  // so that push is guarded like later ones; the copy is kept once the
  // project is registered below.
  const pending = cfg.projects?.[name] ? null : {};
  if (pending) discoverPrivate(name, pending);
  const baselineBases = () => remoteBases({ git, cwd: top, remote: r.baseline.remote, ref: `refs/heads/${branch}`, opts: { token: r.baseline.token, ownerRemote: false } });
  // The first push sends the whole history.
  if (!serverHead) {
    guardedPush({ project: name, pending, cwd: top, tip: `refs/heads/${branch}`, bases: baselineBases, what: `${branch}'s history for ${name}'s repository`, fail: die },
      (sha) => git(["push", "--quiet", "--recurse-submodules=no", r.baseline.remote, `${sha}:refs/heads/${branch}`], { cwd: top, token: r.baseline.token, failureHint: (detail) => initialPushHint(detail, name) }));
  }
  cfg.projects ??= {};
  cfg.projects[name] = { ...pending, ...cfg.projects[name], path: top, branch, protect };
  saveConfig(cfg);
  // Now that the project is registered here, the copy of its list of
  // private files is kept with it (Argon's second review of t645).
  privateGuardFor(name);
  const pol = r.project.policy;
  if (postMerge && !pol.postMerge) die("server did not record post-merge policy; stop and upgrade the server");
  if (pol.postMerge) console.log(`Post-merge: ${pol.postMerge.steps.map(s => `${s.name} (${s.class})`).join(" → ")}; developer approval recorded`);
  const titled = r.project.title ? `${r.project.title} (${name})` : name;
  console.log(serverHead ? serverInitText(titled, name, branch, serverHead, top, r.baseline)
    : `${titled}: ${name}'s repository on this server now holds ${branch} @ ${short(git(["rev-parse", "HEAD"], { cwd: top }))}.`);
  console.log(`Checks:     ${pol.checks.join(" | ") || "none"}`);
  if (!pol.checks.length) console.log("Warning: this project has no required checks; runner dispatches are refused until you register one with atelier init --check CMD.");
  // t293: a command the deploy gate runs that no required check runs, the
  // same warning `atelier status` prints, with the init that adds it.
  for (const line of deployGateLines(pol, packageScripts(top))) console.log(line);
  for (const v of checkClasses(pol)) console.log(`  ${v.command}: ${classText(v)}${pol.checkPaths?.some((c) => c.command === v.command) ? `; ${appliesText(pol, v.command)}` : ""}`);
  console.log(`Ship:       ${pol.shipKinds?.length ? `needs ${pol.shipKinds.join(", ")}; ` : ""}${pol.shipRuns?.length ?? 0} protected command${(pol.shipRuns?.length ?? 0) === 1 ? "" : "s"}`);
  if (pol.prepare) console.log(`Prepare:    ${pol.prepare.command} (inputs: ${pol.prepare.inputs.join(", ")}; outputs: ${pol.prepare.outputs.join(", ")})`);
  if (pol.regenerate) console.log(`Regenerate: ${pol.regenerate}`);
  if (pol.affectedTests) console.log(`Affected:   a task's \`${pol.affectedTests.check}\` runs ${pol.affectedTests.map ? `the tests a ${pol.affectedTests.map.length}-entry map selects` : `the tests \`${pol.affectedTests.list}\` lists`} with \`${pol.affectedTests.run}\`; ship runs \`${pol.affectedTests.check}\` whole before it delivers anything`);
  console.log(`Review bar: ${pol.reviewBar ?? "the default, which blocks for a correctness, security or data-loss defect, a behaviour change without a test that covers it, docs or help that now contradict the code, a breaking change to a command, route or API field without a migration, or a visible regression on a user-facing page; anything else is a follow-up"}`);
  // A server older than the review bar ignores it and answers without one.
  if (typeof args["review-bar"] === "string" && args["review-bar"].trim() && !pol.reviewBar) console.log("Warning: the server did not record the review bar; deploy the server, then run atelier init --review-bar again.");
  console.log(`Prose:      ${pol.proseStandard ? `${pol.proseStandard}, which every build, plan and review brief names for the agent to load before it writes prose` : "no prose standard; no brief names one (atelier init --prose-standard PATH)"}`);
  // A server older than the prose standard ignores it and answers without one.
  if (typeof args["prose-standard"] === "string" && args["prose-standard"].trim() && !pol.proseStandard) console.log("Warning: the server did not record the prose standard; deploy the server, then run atelier init --prose-standard again.");
  console.log(`Check limit: ${limitText(pol)}`);
  // A server older than the check limit ignores it and answers without one.
  if ((typeof args["check-limit"] === "string" && args["check-limit"].trim() && !pol.checkLimitMinutes) || (typeof args["silence-limit"] === "string" && args["silence-limit"].trim() && !pol.silenceLimitMinutes) || (typeof args["startup-limit"] === "string" && args["startup-limit"].trim() && !pol.startupLimitMinutes) || (typeof args["slot-wait-limit"] === "string" && args["slot-wait-limit"].trim() && !pol.slotWaitLimitMinutes)) console.log("Warning: the server did not record the check limit; deploy the server, then run atelier init --check-limit MINUTES --silence-limit MINUTES --startup-limit MINUTES --slot-wait-limit MINUTES again.");
  console.log(`Triage:     ${pol.triage ? `${pol.triage}, which triages each landing's diff against the task's acceptance criteria before the review is asked for (atelier land --triage H/M names another, --no-triage REASON skips it)` : "none, unless a landing names a model with atelier land --triage H/M"}`);
  // A server older than the triage setting ignores it and answers without one.
  if (typeof args.triage === "string" && args.triage.trim() && !pol.triage) console.log("Warning: the server did not record the triage model; deploy the server, then run atelier init --triage again.");
  console.log(`Resolvers:  ${pol.resolvers?.length ? `${pol.resolvers.join(", ")}, the first eligible of which resolves a refresh's mechanical conflicts` : "none; a refresh's mechanical conflict waits for one (atelier init --resolver H/M)"}`);
  if (typeof args.resolver === "string" && args.resolver.trim() && !pol.resolvers?.length) console.log("Warning: the server did not record the resolvers; deploy the server, then run atelier init --resolver again.");
  if (pol.riskReviews) console.log(`Risk reviews: ${pol.riskReviews.reviews["docs-or-tests"]} for docs or tests, ${pol.riskReviews.reviews.other} for other changes, ${pol.riskReviews.reviews.core} for core (${pol.riskReviews.core.join(", ") || "no extra core globs"}), each independent review counted by the change's paths`);
  console.log(`Models:     ${familyModeText(pol)}`);
  // A server older than single-family mode ignores it and answers without one.
  if (typeof singleFamily === "string" && singleFamily.trim() && !pol.familyMode?.single) console.log("Warning: the server did not record single-family mode; deploy the server, then run atelier init --single-family again.");
  const checkInputs = checkFiles(pol.checks ?? []);
  console.log(`Protected:  ${[...new Set([...(pol.protected ?? []), ...checkInputs])].sort().join(", ")}`);
  console.log(`Overlap:    ${pol.refuseOverlap ? "refused" : "flagged"}`);
  console.log(`Overrides:  ${pol.noOverride ? "refused; every change needs its independent review" : "allowed with a reason, once the developer confirms on the task's page with the Access sign-in or the server's confirmation secret"}`);
  // A server older than --no-override ignores it and answers without it.
  if (args["no-override"] === true && !pol.noOverride) console.log("Warning: the server did not record --no-override; deploy the server, then run atelier init --no-override again.");
  console.log(`Criteria:   ${pol.requireCriteria ? "required on every task" : "optional"}`);
  // A server older than the criteria requirement ignores it and answers without one.
  if (args["require-criteria"] === true && !pol.requireCriteria) console.log("Warning: the server did not record the criteria requirement; deploy the server, then run atelier init --require-criteria again.");
  console.log(`Criteria review: ${pol.requireCriteriaReview ? (pol.criteriaReview === "parallel" ? "required before gate review and landing; dispatch and claim may proceed" : "required before a build is dispatched or claimed") : "not required"}`);
  if (args["require-criteria-review"] === true && !pol.requireCriteriaReview) console.log("Warning: the server did not record the criteria review requirement; deploy the server, then run atelier init --require-criteria-review again.");
  console.log(`Core files: ${pol.coreFiles?.length ? `${pol.coreFiles.join(", ")}; the queue holds a dispatch whose scope overlaps a claimed or landing item's in one` : "none; the queue holds no dispatch for its scope"}`);
  // A server older than core files ignores them and answers without any.
  if (core?.length && !pol.coreFiles?.length) console.log("Warning: the server did not record the core files; deploy the server, then run atelier init --core again.");
  const ci = pol.commitIdentity;
  console.log(`Commits:    ${ci ? `${ci.name} <${ci.email}>${ci.agentEmails.length ? `; agents may also commit as ${ci.agentEmails.join(", ")}` : ""}${ci.privateEmails?.length ? `; declared private: ${ci.privateEmails.join(", ")}` : ""}${ci.publicMirrors?.length ? `; public mirrors: ${ci.publicMirrors.join(", ")}` : ""}` :"no identity named; claims fall back to the checkout's, and runners refuse to start a builder: set one with --commit-name NAME --commit-email EMAIL"}`);
  if ((args["commit-email"] !== undefined || args["commit-name"] !== undefined) && !ci) console.log("Warning: the server did not record the commit identity; deploy the server, then run atelier init --commit-name NAME --commit-email EMAIL again.");
  if (pol.approval) console.log(`Approval:   ${pol.approval}`);
  let agentsMd = null;
  try { agentsMd = readFileSync(join(top, "AGENTS.md"), "utf8"); } catch {}
  const offer = agentsMdOffer(agentsMd);
  if (offer) console.log(`\n${offer}`);
}

// The text of the prose standard at `path` (from the checkout `top` when
// relative), or null with a warning when it cannot be read or is too long.
function proseStandardText(top, path) {
  if (typeof path !== "string" || !path.trim()) return null;
  const source = isAbsolute(path) ? path : resolve(top, path);
  let text;
  try { text = readFileSync(source, "utf8"); }
  catch (error) { console.log(`Warning: the prose standard ${source} cannot be read (${error.code ?? error.message}); its path is recorded, but builders on the Studio will not have its text.`); return null; }
  if (!text) return null;
  if (text.length > PROSE_TEXT_MAX) { console.log(`Warning: the prose standard ${source} is ${text.length} characters, over the ${PROSE_TEXT_MAX} the server keeps; its path is recorded without its text.`); return null; }
  return text;
}

// The tip of `branch` in the project's repository on the Node server, or
// null while it has none (the first init pushes it).
function serverBranchHead(remote, branch, cwd, token) {
  const listed = git(["ls-remote", remote, `refs/heads/${branch}`], { cwd, token, allowFail: true });
  if (listed.status !== 0) die(`could not read ${remote}: ${(listed.stderr ?? "").trim().slice(0, 300)}; nothing was pushed`);
  return /^([0-9a-f]{40,64})\s/.exec(listed.stdout ?? "")?.[1] ?? null;
}

// What a later init on the Node server says: the policy is recorded, and how
// the checkout's branch stands against the server's, which only a landing
// moves. The server's tip is fetched so the two can be compared.
function serverInitText(titled, name, branch, serverHead, cwd, baseline) {
  const head = git(["rev-parse", "HEAD"], { cwd });
  const lines = [`${titled}: policy recorded; nothing was pushed. On this server the repository is the baseline, and ${branch} there is at ${short(serverHead)}.`];
  if (head === serverHead) return [...lines, `This checkout's ${branch} is at the same commit.`].join("\n");
  git(["fetch", "--quiet", "--no-tags", baseline.remote, `refs/heads/${branch}`], { cwd, token: baseline.token, allowFail: true });
  if (holds(head, serverHead, cwd)) return [...lines, `This checkout's ${branch} is behind it, at ${short(head)}.`, `next: atelier pull --project ${name}`].join("\n");
  const ahead = git(["rev-list", "--count", head, "--not", serverHead], { cwd, allowFail: true }).stdout?.trim() || "some";
  return [...lines,
    `This checkout holds ${ahead} commit${ahead === "1" ? "" : "s"} the server's ${branch} lacks; only a landing moves ${branch} there, so they were not sent.`,
    `next: carry them as a task: atelier new "TITLE" --project ${name}, claim it, push the commits to its branch, then atelier land tN --project ${name}`,
  ].join("\n");
}

// --affected-tests PATH (G20): the declaration's JSON, from a file in the
// checkout; "" clears it. The server checks its shape.
function affectedTestsArg(top, path) {
  if (path === "") return null;
  if (typeof path !== "string") die('--affected-tests needs the path of a JSON file: atelier init --affected-tests docs/atelier/affected-tests.json, or --affected-tests "" to clear it');
  try { return JSON.parse(readFileSync(resolve(top, path), "utf8")); }
  catch (error) { die(`--affected-tests: ${path} could not be read as JSON: ${error.message}`); }
}

// A proxy may reject the pack before receive-pack sees it. Retry through the
// Studio directly; never forward the stored token to a guessed address.
function initialPushHint(detail, name) {
  if (!/\bHTTP(?: error:?)?\s+413\b|returned error:\s*413\b/i.test(detail)) return "";
  let direct = null;
  try {
    const url = new URL(cfg.server);
    if (tailnetHost(url.hostname)) direct = cfg.server;
  } catch { /* No configured direct address. */ }
  const login = direct ? `log in to the Studio's tailnet address: atelier login --server ${JSON.stringify(direct)}`
    : "log in to the Studio's tailnet address with atelier login --server URL";
  return `The configured server's proxy refused the first push (HTTP 413). ${login}, then retry: atelier init --name ${JSON.stringify(name)}. If ATELIER_SERVER is set, change it to the same tailnet address before retrying.`;
}
