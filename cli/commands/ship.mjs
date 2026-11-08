// atelier ship. Its forms, flags and help are declared in src/usage/commands/ship.ts.
import { appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { WRAP_MARKERS } from "../../src/sessions.ts";
import { landingJournalFile, oldLandingJournalFile } from "../landing.mjs";
import { loadPairs } from "../fresh.mjs";
import { COMMAND_USAGE } from "../help.mjs";
import { autoDeploy, composeShip, fileDeployStore, pinnedDeployCheck, runCommand, ship as runShip, shipSecrets, shipWrapArgs } from "../ship.mjs";
import { OWNER, P, actor, apiToken, args, call, cfg, cliState, die, git, landingHome, project, redact, request, saveConfig, workspaceTokens } from "../atelier.mjs";
import { holdCheckout, postOnExit, stayHeld } from "../checkout-hold.mjs";

// The project owner runs the project's ship order in its registered
// checkout (cli/ship.mjs): each protected step only with an approval at the
// revision shipped, each step recorded on the ledger.
export default async function shipCommand() {
  if (process.env.ATELIER_AUTO_DEPLOY) return deployOnLandingWorker();
  if (args._.length !== 1) die(COMMAND_USAGE.ship);
  const name = project(), as = await actor(OWNER);
  if (as !== OWNER) die(`only the developer ships: run ship as ${OWNER}, without --as or ATELIER_ACTOR naming another actor`);
  const p = cfg.projects?.[name];
  if (!p?.path || !existsSync(p.path)) die(`ship runs in ${name}'s registered checkout, and this machine has none; run atelier init in that checkout first`);
  const top = git(["rev-parse", "--show-toplevel"], { allowFail: true });
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(p.path)) die(`run ship in ${name}'s registered checkout: cd ${JSON.stringify(p.path)}`);
  const cwd = p.path, gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd });
  // The checkout lease (G9): a ship never runs beside a landing's merge
  // step; it waits, saying who holds the checkout. It is taken before the
  // baseline is read, which a merge it waited for moves. A dry run changes
  // nothing and takes none.
  const checkout = args["dry-run"] === true ? null : await holdCheckout({ project: name, kind: "ship", cwd });
  const { head: baselineHead, repository } = await call("GET", `${P(name)}/baseline-head`, undefined, OWNER);
  // The operations wrap refuses to run beside, read the way wrapReady reads them.
  const inProgress = () => [...new Set(Object.keys(WRAP_MARKERS).filter((marker) => (marker === "landing"
    ? [landingJournalFile(landingHome(gitDir)), oldLandingJournalFile(gitDir)]
    : [resolve(cwd, git(["rev-parse", "--git-path", marker], { cwd }))]).some((file) => existsSync(file))).map((marker) => WRAP_MARKERS[marker]))];
  // The push reads the project's commit identity, whose public mirrors take
  // only commits under the project's own address (cli/checkout-push.mjs).
  const identity = args.push === true ? (await call("GET", P(name), undefined, OWNER)).project?.policy?.commitIdentity ?? null : null;
  // Once begun, the ship records its deploy, shipped or failed (G9); one
  // that ends any other way (a refused request, say) is recorded as failed
  // on its way out, since die() runs no finally.
  // `recorded` is set only once the server took the record; the exit path
  // posts what is left, retrying briefly.
  let begun = null, recorded = false, pending = null;
  const onExit = () => {
    if (!begun || recorded) return;
    recorded = postOnExit(`${P(name)}/deploys`, pending ?? { ...begun, result: "failed", note: "atelier ship ended before it finished; its output says why" });
  };
  const deployed = async (record) => {
    pending = record;
    try { await request("POST", `${P(name)}/deploys`, record, OWNER); recorded = true; }
    catch (error) {
      recorded = postOnExit(`${P(name)}/deploys`, record);
      if (!recorded) console.log(`Warning: the deploy record could not be written: ${error.message}`);
    }
  };
  process.on("exit", onExit);
  try {
    // A deploy the worker started names the one head it is for. Under the
    // lease just taken, that head is checked against the baseline and for
    // what waits on PAVI, and approved, before the same ship deploys it.
    if (process.env.ATELIER_DEPLOY_PIN) {
      const pin = JSON.parse(process.env.ATELIER_DEPLOY_PIN);
      const stop = pinnedDeployCheck({ pin, baselineHead, plan: composeShip(cwd), git: (a, o = {}) => git(a, { cwd, ...o }), cwd });
      if (stop?.superseded) { console.log(`auto-deploy-superseded: ${stop.superseded}`); process.exitCode = 1; return; }
      if (stop?.waits) { for (const why of stop.waits) console.log(`auto-deploy-waits: ${why}`); process.exitCode = 1; return; }
      await request("POST", `${P(name)}/actions`, { kind: "deploy", commit: pin.head, note: "given by the standing instruction deploy-on-landing", expires: "1h" }, OWNER);
    }
    await runShip({
      name, cwd, branch: p.branch, baselineHead, inProgress, repositoryIsBaseline: repository === "server",
      paired: (sha) => (p.fresh === true ? loadPairs(gitDir, name)[sha] ?? null : sha),
      git: (a, o = {}) => git(a, o),
      request: (method, path, body) => (path.endsWith("/actions/starts") ? request : call)(method, path, body, OWNER),
      read: (path) => request("GET", path, undefined, OWNER),
      stage: (text) => { cliState.doneStep = text ?? undefined; },
      fail: (message) => die(message),
      print: (line) => console.log(line),
      // The wrap step is atelier wrap itself, run in the checkout as the owner
      // would, with the environment ship gives it (stepEnv in cli/ship.mjs).
      wrap: (summary, env) => runCommand([process.execPath, fileURLToPath(new URL("../atelier.mjs", import.meta.url)), ...shipWrapArgs(summary, name)], { cwd, env }),
      env: process.env,
      secrets: shipSecrets(process.env, [apiToken(), ...workspaceTokens(cwd)]),
      redact,
      dryRun: args["dry-run"] === true,
      push: args.push === true,
      identity,
      began: (record) => { begun = record; },
      deployed,
      // A lease lost to a takeover stops the ship before its next step,
      // recorded as a failed deploy (G9).
      checkpoint: (step, ran) => stayHeld(checkout, (lost) => deployed({ ...begun, result: "failed", step, ran: [...ran], note: lost.detail.slice(0, 1000) })),
    });
  } finally { process.off("exit", onExit); await checkout?.release(); }
}

// The process cli/post-merge.mjs starts after a merge, when the standing
// instruction deploy-on-landing is on: ATELIER_AUTO_DEPLOY holds the landed
// head and the commit last delivered. It deploys through autoDeploy
// (cli/ship.mjs), which keeps one deploy running per checkout and queues the
// newest head that lands meanwhile. Each deploy is an ordinary
// `atelier ship`, run in the registered checkout once the merge lets go of
// it, with the deploy approval the standing instruction gives; only a
// `deploy` approval is ever given this way.
async function deployOnLandingWorker() {
  let landed;
  try { landed = JSON.parse(process.env.ATELIER_AUTO_DEPLOY); } catch { die("ATELIER_AUTO_DEPLOY is set by a landing and holds JSON: {\"head\": SHA, \"since\": SHA or null}"); }
  const name = project(), as = await actor(OWNER);
  if (as !== OWNER) die(`only the developer ships: run ship as ${OWNER}`);
  const cwd = cfg.projects?.[name]?.path;
  if (!cwd || !existsSync(cwd)) die(`deploy on landing runs in ${name}'s registered checkout, and this machine has none`);
  const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd });
  const dir = join(gitDir, "atelier-auto-deploy");
  mkdirSync(dir, { recursive: true });
  const print = (line) => appendFileSync(join(dir, "auto-deploy.log"), `${new Date().toISOString()} ${line}\n`);
  const store = fileDeployStore(dir);
  const env = { ...process.env };
  delete env.ATELIER_AUTO_DEPLOY;
  const result = await autoDeploy({
    name, head: landed.head, on: true, store, print,
    deploy: async (at) => {
      const since = store.read().deployed ?? landed.since ?? null;
      const r = await runCommand([process.execPath, fileURLToPath(new URL("../atelier.mjs", import.meta.url)), "ship", "--project", name], { cwd, env: { ...env, ATELIER_DEPLOY_PIN: JSON.stringify({ head: at, since }) }, timeoutMs: 45 * 60_000 });
      if (r.passed) return { passed: true, output: r.output };
      if (/^auto-deploy-superseded:/m.test(r.output)) return { passed: false, superseded: true, output: r.output };
      const waits = [...r.output.matchAll(/^auto-deploy-waits: (.*)$/gm)].map((m) => m[1]);
      return waits.length ? { passed: false, waits, output: r.output } : { passed: false, output: r.output };
    },
    record: (record) => request("POST", `${P(name)}/deploys`, record, OWNER),
  });
  print(`Deploy on landing ended: ${result.state}`);
}
