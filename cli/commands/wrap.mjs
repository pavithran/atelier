// atelier wrap. Its forms, flags and help are declared in src/usage/commands/wrap.ts.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FILING_RELAY, cleanSession, failingChecksOverridden, failingChecksRefusal, sessionCommitMessage, sessionNoteText, sessionText, staleState, wrapRelay } from "../../src/sessions.ts";
import { refusalOf, refusalText } from "../../src/checks.ts";
import { OWNER, P, actor, args, at, call, cfg, die, git, project, runGroupedCheck, sessionCheckout, sessionFiles, sessionTree, wrapReady } from "../atelier.mjs";
import publishCommand from "./publish.mjs";
import syncCommand from "./sync.mjs";

export default async function wrapCommand() {
  const name = project(), as = await actor(OWNER), cwd = sessionCheckout(name, true);
  // The server records a session only for the project owner. Refuse here,
  // before wrap commits or pushes anything the server would then not take a
  // note for.
  if (as !== OWNER) die(`only the project owner records a session: run wrap as ${OWNER}, without --as or ATELIER_ACTOR naming another actor`);
  const head = git(["rev-parse", "HEAD"], { cwd });
  let data;
  // An unquoted summary reaches here as several words: they are one summary.
  try { data = cleanSession({ summary: args._.slice(1).join(" "), next: args.next, head, dirty: false, checks: [] }); }
  catch (err) { die(err.message); }
  const found = args.multi.found ?? [];
  if (found.length > 100 || found.some((text) => !sessionText(text))) die("--found needs text, at most 100 times");
  const allowFailing = args["allow-failing"] === true;
  data.checksSkipped = args["no-check"] === true;
  // Skipped checks cannot fail, so the override would record nothing: the
  // owner says which of the two is meant.
  if (allowFailing && data.checksSkipped) die("--allow-failing and --no-check together: skipped checks cannot fail; give one or the other");
  wrapReady(name, cwd, true);
  const { project: record } = await call("GET", P(name), undefined, as);
  const refused = data.checksSkipped ? [] : record.policy.checks.flatMap((cmd) => { const why = refusalOf(cmd); return why ? [refusalText(cmd, why)] : []; });
  if (refused.length) die(`${refused.join(".\n")}.\nwrap runs the registered checks in this checkout, so it stopped before running any. Replace the check with atelier init --check, or wrap with --no-check.`);
  const failing = [];
  if (!data.checksSkipped) for (const command of record.policy.checks) {
    const result = await runGroupedCheck(command, { cwd, env: process.env, maxBytes: 1024 * 1024 });
    const passed = result.status === 0 && !result.error;
    data.checks.push({ command, passed, grade: "reported" });
    console.log(`Reported: ${command}: ${passed ? "passed" : "failed"} (owner's checkout, not a clean clone).`);
    if (!passed) failing.push({ command, status: result.status, signal: result.signal, timedOut: result.timedOut });
  }
  // A failing registered check stops wrap here, with every result printed
  // and nothing staged, recorded or pushed: the checks ran in the checkout
  // as the owner left it, and the refusal touches nothing after them.
  // --allow-failing commits anyway, and the note names the checks it let
  // through beside their Reported results.
  if (failing.length && !allowFailing) die(failingChecksRefusal(failing));
  if (failing.length) {
    data.checksOverridden = failing.map((c) => c.command);
    console.log(failingChecksOverridden(failing));
  }
  const [previous] = await call("GET", `${P(name)}/sessions`, undefined, as);
  const { state, modified } = sessionFiles(cwd);
  if (state && previous) {
    // A state file Git does not track has no copy at the previous session's
    // HEAD to compare with: its modification time stands in, counted as
    // unchanged while it is not later than that note.
    const tracked = git(["--no-optional-locks", "ls-files", "--error-unmatch", "--", state], { cwd, allowFail: true }).status === 0;
    let unchanged = false, compared = true;
    if (tracked) {
      const before = git(["show", `${previous.data.head}:${state}`], { cwd, allowFail: true });
      unchanged = before.status === 0 && before.stdout === readFileSync(join(cwd, state), "utf8");
      compared = before.status === 0;
    } else unchanged = new Date(modified[state]) <= new Date(previous.at);
    const warning = staleState(state, previous.data.head, unchanged);
    if (warning) console.log(warning);
    if (!compared) console.log(`Could not compare ${state} with the previous session HEAD.`);
  }
  const tree = sessionTree(cwd);
  console.log(`Uncommitted files:\n${tree || "none"}`);
  const branch = wrapReady(name, cwd, false);
  const remotes = args.push ? git(["remote"], { cwd }).split("\n").filter(Boolean) : [];
  if (remotes.length > 100) die("wrap supports at most 100 remote results");
  data = cleanSession(data);
  data.sessionAt = new Date().toISOString();
  // Conflict markers refuse the commit, checked before anything is staged so
  // a refusal leaves the index as the owner had it: tracked changes against
  // HEAD, staged or not, and each new file against nothing. A conflict
  // resolved with `git add` and its markers left in leaves no operation
  // marker or unmerged entry behind, so only the content shows it.
  // The scan reads the lines the commit would add, never Git's diff
  // attributes: a file marked -diff or binary skips git diff --check, so
  // tracked changes are read with --text and new files are read whole. A
  // line opening or closing a conflict (seven < or > then a space or the
  // end) refuses the commit; a bare ======= alone does not, since Markdown
  // underlines headings with it. The scan fails closed: if git cannot
  // diff a path, wrap stops. Paths are literal, so none is read as an
  // option, a pathspec or standard input. No call writes the index, so a
  // refusal leaves even its cached file data as it was: git diff refreshes
  // a stat-dirty index on its own unless diff.autoRefreshIndex is off,
  // whatever --no-optional-locks says, and iCloud leaves files stat-dirty.
  const opensOrCloses = /^(<{7}|>{7})( |$)/;
  const marked = [];
  const readOnly = ["-c", "diff.autoRefreshIndex=false", "--no-optional-locks"];
  const changed = git([...readOnly, "diff", "HEAD", "--name-only", "--no-renames", "-z"], { cwd, raw: true }).split("\0").filter(Boolean);
  for (const file of changed) {
    const added = git([...readOnly, "--literal-pathspecs", "diff", "HEAD", "--text", "--no-ext-diff", "--no-textconv", "-U0", "--", file], { cwd, allowFail: true });
    if (added.status !== 0) die(`wrap could not read the changes to ${sessionText(file, 200)} (git diff exited ${added.status}); nothing was staged`);
    if ((added.stdout || "").split("\n").some((line) => line.startsWith("+") && !line.startsWith("+++") && opensOrCloses.test(line.slice(1)))) marked.push(file);
  }
  for (const file of git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd, raw: true }).split("\0").filter(Boolean)) {
    const path = join(cwd, file);
    let stat;
    try { stat = lstatSync(path); } catch { die(`wrap could not read ${sessionText(file, 200)}; nothing was staged`); }
    if (!stat.isFile()) continue; // a symbolic link is committed as a link, not as the content it names
    if (readFileSync(path).toString("latin1").split("\n").some((line) => opensOrCloses.test(line))) marked.push(file);
  }
  if (marked.length) {
    die(`wrap will not commit conflict markers: ${marked.map((p) => sessionText(p, 200)).join(", ")}; resolve them first. Nothing was staged.`);
  }
  git(["add", "-A"], { cwd });
  // Whitespace is checked on what the commit will hold, after staging: the
  // index against HEAD takes in staged changes and new files, which a diff of
  // the working tree against the index leaves out.
  const diff = git(["diff", "--cached", "--check"], { cwd, allowFail: true });
  data.checks.push({ command: "git diff --cached --check", passed: diff.status === 0, grade: "reported" });
  console.log(`Reported: git diff --cached --check: ${diff.status === 0 ? "passed" : "failed"} (owner's checkout, not a clean clone).`);
  if (diff.stdout || diff.stderr) console.log(diff.stdout || diff.stderr);
  const staged = git(["diff", "--cached", "--quiet"], { cwd, allowFail: true });
  if (staged.status === 1) {
    git(["commit", "-F", "-"], { cwd, input: sessionCommitMessage(data.summary, data.next, data.sessionAt) });
    data.commit = git(["rev-parse", "HEAD"], { cwd });
    console.log(`Committed session as ${data.commit}.`);
  } else if (staged.status === 0) console.log("Nothing to commit.");
  else die("could not inspect staged changes");
  data.pushes = [];
  for (const remote of remotes) {
    // The owner's own remotes: a normal push, LFS objects included (see gitEnv).
    const result = git(["-c", `remote.${remote}.mirror=false`, "push", "--no-force", "--no-follow-tags", remote, `refs/heads/${branch}:refs/heads/${branch}`], { cwd, allowFail: true, ownerRemote: true });
    data.pushes.push({ remote, passed: result.status === 0 });
    console.log(`Remote ${sessionText(remote, 200)}: ${result.status === 0 ? "pushed" : "failed"}.`);
  }
  if (!args.push) console.log("Checkout remotes not pushed (no --push).");
  data.found = [];
  for (const text of found) {
    const item = await call("POST", `${P(name)}/items`, { title: sessionText(text), scope: [] }, as);
    data.found.push(item.id);
    console.log(`Filed ${item.id}: ${sessionText(text)}`);
  }
  data.dirty = !!sessionTree(cwd);
  data.head = git(["rev-parse", "HEAD"], { cwd });
  const note = await call("POST", `${P(name)}/sessions`, cleanSession(data), as);
  console.log(sessionNoteText(note));
  if (cfg.projects[name].fresh === true) await syncCommand();
  else await publishCommand();
  console.log("Nothing deployed or published as a release.");
  console.log(FILING_RELAY);
  console.log(wrapRelay(note));
  // Every remote was tried, the note is recorded and the baseline is in
  // step; only now does a remote that did not take the push fail the command.
  const failed = data.pushes.filter((p) => !p.passed);
  if (failed.length) die(`the session is recorded, but the push failed for ${failed.length} remote${failed.length === 1 ? "" : "s"}: ${failed.map((p) => sessionText(p.remote, 200)).join(", ")}`);
}
