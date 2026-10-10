// atelier ship. Its forms, flags and help are declared in src/usage/commands/ship.ts.
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { WRAP_MARKERS } from "../../src/sessions.ts";
import { landingJournalFile, oldLandingJournalFile } from "../landing.mjs";
import { loadPairs } from "../fresh.mjs";
import { COMMAND_USAGE } from "../help.mjs";
import { runCommand, ship as runShip, shipSecrets } from "../ship.mjs";
import { OWNER, P, actor, apiToken, args, call, cfg, cliState, die, git, landingHome, project, redact, request, workspaceTokens } from "../atelier.mjs";

// The project owner runs the project's ship order in its registered
// checkout (cli/ship.mjs): each protected step only with an approval at the
// revision shipped, each step recorded on the ledger.
export default async function shipCommand() {
  if (args._.length !== 1) die(COMMAND_USAGE.ship);
  const name = project(), as = await actor(OWNER);
  if (as !== OWNER) die(`only the project owner ships: run ship as ${OWNER}, without --as or ATELIER_ACTOR naming another actor`);
  const p = cfg.projects?.[name];
  if (!p?.path || !existsSync(p.path)) die(`ship runs in ${name}'s registered checkout, and this machine has none; run atelier init in that checkout first`);
  const top = git(["rev-parse", "--show-toplevel"], { allowFail: true });
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(p.path)) die(`run ship in ${name}'s registered checkout: cd ${JSON.stringify(p.path)}`);
  const cwd = p.path, gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd });
  const { head: baselineHead } = await call("GET", `${P(name)}/baseline-head`, undefined, OWNER);
  // The operations wrap refuses to run beside, read the way wrapReady reads them.
  const inProgress = () => [...new Set(Object.keys(WRAP_MARKERS).filter((marker) => (marker === "landing"
    ? [landingJournalFile(landingHome(gitDir)), oldLandingJournalFile(gitDir)]
    : [resolve(cwd, git(["rev-parse", "--git-path", marker], { cwd }))]).some((file) => existsSync(file))).map((marker) => WRAP_MARKERS[marker]))];
  await runShip({
    name, cwd, branch: p.branch, baselineHead, inProgress,
    paired: (sha) => (p.fresh === true ? loadPairs(gitDir, name)[sha] ?? null : sha),
    git: (a, o = {}) => git(a, o),
    request: (method, path, body) => call(method, path, body, OWNER),
    stage: (text) => { cliState.doneStep = text ?? undefined; },
    fail: (message) => die(message),
    print: (line) => console.log(line),
    // The wrap step is atelier wrap itself, run in the checkout as the owner would.
    wrap: (summary) => runCommand([process.execPath, fileURLToPath(new URL("../atelier.mjs", import.meta.url)), "wrap", summary, "--project", name], { cwd, env: process.env }),
    env: process.env,
    secrets: shipSecrets(process.env, [apiToken(), ...workspaceTokens(cwd)]),
    redact,
    dryRun: args["dry-run"] === true,
    push: args.push === true,
  });
}
