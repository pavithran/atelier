// atelier runner. Its forms, flags and help are declared in src/usage/commands/runner.ts.
import { guardName } from "../procs.mjs";
import { I, OWNER, apiToken, args, cfg, die, discoverModels, liveHere, reportUsage, server, setupRunner, tokenRunner, workspacePath } from "../atelier.mjs";

// Queue polling has already resolved the runner's identity. A failed policy
// read must reach the job's infrastructure handling, never the process.exit
// the CLI's own call helper makes of a refusal.
// The read goes through the runner's transport (t478), as the declared
// "project" call in RUNNER_CALLS (src/tokens.ts).
export async function hasPreparation(project, actor) {
  try {
    const { runnerTransport } = await import("../runner.mjs");
    const transport = runnerTransport({ server: server(), credential: apiToken(), runner: tokenRunner });
    const res = await transport.send("project", { project }, { actor });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.data?.project?.policy) throw new Error("missing project policy");
    return !!res.data.project.policy.prepare;
  } catch (error) {
    throw Object.assign(new Error(`the preparation policy could not be read: ${error.message}`), { infrastructure: true });
  }
}

// A helper's console line, stamped as every runner log line is (logLine
// supplies the ISO UTC time and the "runner:" label, so a message's own
// leading label is dropped).
export const stampedSay = (logLine, print) => (message) => logLine(String(message).replace(/^runner: /, ""), print ? { print } : undefined);
export const NO_PROCESS_TABLE = "the process table could not be read, so a second runner of this name is not ruled out.";
export const incompleteLine = (incomplete) => `Could not read: ${incomplete}. Tasks waiting there are not listed.`;

// `runner --discover` reports what each home model's harness serves (discover.mjs);
// `runner --usage` reports each tool's windows, served models and balances (usage.mjs).
export default async function runnerCommand() {
  if (args._[1] === "setup") return setupRunner();
  if (args.discover === true) return discoverModels();
  if (args.usage === true) return reportUsage();
  const { isReloaded, reexecSelf, runnerUsage, runRunner, runnerCheckout, runnerTransport, logLine } = await import("../runner.mjs");
  const say = stampedSay(logLine);
  // One name is one process (t581). A reload's replacement is the same
  // process, which would find itself, so it is let through; so is a start that
  // cannot read the process table, which says so.
  try { runnerUsage(args); } catch (error) { die(error.message); }
  if (!isReloaded(process.env)) {
    const live = liveHere();
    if (!live) say(NO_PROCESS_TABLE);
    const refusal = live && await guardName({
      runners: live.runners, name: args.name, replace: args.replace === true, say,
      kill: (pid) => process.kill(pid, "SIGTERM"),
      alive: (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    if (refusal) die(refusal);
  }
  // The runner's own server calls, every one through the transport (t478):
  // the queue poll, the plan job's brief and document, the run reports and
  // the review skips, under the runner's token and the name it polls as,
  // each a call RUNNER_CALLS in src/tokens.ts declares. They throw rather
  // than die, so the runner's loop decides what a failure means; a 422 from
  // posting a plan is a result the runner reports, not an error thrown here.
  const transport = runnerTransport({ server: server(), credential: apiToken(), runner: typeof args.name === "string" ? args.name.toLowerCase() : undefined });
  const detail = (res) => (res.data?.detail ? ` ${res.data.detail}` : "");
  try {
    await runRunner(args, {
      credential: apiToken(),
      api: { server, I },
      workspacePath,
      // Where the developer's checkout of a project is on this Mac, which the
      // project's prose standard (a path from it) is copied from (t676).
      checkoutOf: (name) => cfg.projects?.[name]?.path ?? null,
      // An idle runner reloads itself from this checkout once it holds the
      // deployed commit (t265), replacing the process in place once the new code loads.
      reload: { checkout: runnerCheckout(), reexec: reexecSelf },
      // The server's route level against the CLI's, checked at start: a
      // server behind this CLI would fail the runner's calls one by one. An
      // idle runner reads it again for the deployed commit (t265).
      // A server that cannot be read is refused as land refuses it, with
      // the same "does not answer" message (GET /api/version is public).
      async version(signal) {
        try {
          const res = await transport.send("version", {}, { signal });
          return res.ok ? res.data : null;
        } catch {
          return null;
        }
      },
      // A poll that times out, cannot reach the server, or meets a 5xx or a
      // 429 throws an error marked transient, which the runner's loop takes
      // as the server being slow rather than a failure (transientQueueError).
      // The poll goes as the token's actor for an agent token and as the
      // owner otherwise; a runner token names no actor, and the queue reads
      // the offer's runner, not the header.
      // A credential the server refuses on the config read (401, 403) ends
      // the runner, as `call` ended it before t478; a config read that
      // cannot reach the server is as transient as a poll that cannot.
      async queue(offer, signal) {
        let res;
        try {
          const who = await transport.identity(signal);
          res = await transport.send("queue", {}, { body: offer, actor: who.actor ?? OWNER, signal });
        } catch (error) {
          if (signal.aborted) throw error;
          if (error.status) throw Object.assign(new Error(error.message), { transient: error.status >= 500 || error.status === 429 });
          throw Object.assign(new Error(`queue: ${error.message}`), { transient: true });
        }
        if (!res.ok) throw Object.assign(new Error(`queue: ${res.status}`), { transient: res.status >= 500 || res.status === 429 });
        if (res.incomplete) say(incompleteLine(res.incomplete));
        return res.data;
      },
      // A busy runner's heartbeat (t537): its offer, marked as a heartbeat,
      // renews its last poll while a job runs, so the claim it builds under
      // is not taken for one its runner orphaned. Nothing is offered back.
      // It goes as the poll does, through the transport: the declared
      // "queue-heartbeat" call, as the token's actor or the owner.
      async heartbeat(offer, signal) {
        const who = await transport.identity(signal);
        const res = await transport.send("queue-heartbeat", {}, { body: { ...offer, heartbeat: true }, actor: who.actor ?? OWNER, signal });
        if (!res.ok) throw new Error(`heartbeat: ${res.status}`);
      },
      hasPreparation,
      async jobBrief(project, id, actor) {
        let res;
        try { res = await transport.send("job-brief", { project, item: id }, { actor }); }
        catch (error) { throw Object.assign(new Error(`the job brief could not be read: ${error.message}`), { infrastructure: true }); }
        if (!res.ok) throw Object.assign(new Error(`the job brief could not be read: ${res.status}${detail(res)}`.trim()), { infrastructure: res.status >= 500 || res.status === 429 });
        return res.data;
      },
      async postPlan(project, id, actor, text) {
        let res;
        try { res = await transport.send("plan", { project, item: id }, { body: text, actor, timeoutMs: 60_000 }); }
        catch (error) { throw Object.assign(new Error(`the plan could not be posted: ${error.message}`), { infrastructure: true }); }
        if (res.status === 422 && res.data && res.data.valid === false) return res.data;
        if (!res.ok) throw Object.assign(new Error(`the plan could not be posted: ${res.status}${detail(res)}`.trim()), { infrastructure: res.status >= 500 || res.status === 429 });
        return res.data;
      },
      // The baseline's head (GET baseline-head, which a runner token may
      // read), for a post-merge review this runner keeps waiting on a merge
      // commit no source held (t591): it is claimed again once the head moves.
      // The declared "baseline-head" call, through the transport.
      async baselineHead(project, actor, signal) {
        const res = await transport.send("baseline-head", { project }, { actor, signal });
        if (!res.ok) throw new Error(`baseline-head: ${res.status}`);
        return res.data?.head ?? null;
      },
      // A run that stalled, timed out or was refused goes to the run
      // reports, under the runner's name, as a model's status does. A report
      // the server refuses throws its status and detail, as a skip does.
      async reportRun(body, _runner, signal) {
        const res = await transport.send("runs", {}, { body, actor: OWNER, signal });
        if (!res.ok) throw new Error(`${res.status}${detail(res)}`);
        return res.data;
      },
      // Why an idle runner found nothing to claim: its poll asked with
      // `why`, which lists each waiting dispatch of the token's projects
      // with its reason (t420); a runner token may not GET the owner's
      // listing. Asked only when a poll offers nothing, never on the busy
      // path, as the poll goes: the declared "queue-why" call, through the
      // transport, under the token's actor. A server older than this
      // answers with the tasks offered, which carry no reason, so the
      // runner says only its own.
      async idleWhy(offer, signal) {
        let res;
        try {
          const who = await transport.identity(signal);
          res = await transport.send("queue-why", {}, { body: { ...offer, why: true }, actor: who.actor ?? OWNER, signal });
        } catch (error) {
          if (signal.aborted) throw error;
          throw Object.assign(new Error(`queue: ${error.message}`), { transient: true });
        }
        if (!res.ok) throw Object.assign(new Error(`queue: ${res.status}`), { transient: res.status >= 500 || res.status === 429 });
        return res.data;
      },
      // A review this runner will not serve is reported to the project, so
      // the landing waiting on it can say, by runner, when every runner
      // that offers the reviewer has skipped (t353). Under a runner token,
      // which cannot act as the owner, the report goes as the review job's
      // actor, for which the poll was offered the job; under the owner's
      // token it goes as the owner, as the run reports do. The project, the
      // item and the actor name the path and the header; the body carries
      // the rest.
      async reportReviewSkip(body, _runner, signal) {
        const who = await transport.identity(signal);
        const { project, item, actor, ...rest } = body;
        const res = await transport.send("review-skip", { project, item }, { body: rest, actor: who.runner ? actor : OWNER, signal });
        if (!res.ok) throw new Error(`${res.status}${detail(res)}`);
        return res.data;
      },
      // A build or plan job this runner gives up under its dispatch, after
      // failed runs or infrastructure failures in a row, is reported the
      // same way (t420), so status and show name this runner as what passes
      // it by.
      // It goes as the review skip does: the declared "run-skip" call, as
      // the job's actor under a runner token and as the owner otherwise;
      // the body keeps the actor, which the server reads under the owner's
      // token alone.
      async reportRunSkip(body, _runner, signal) {
        const who = await transport.identity(signal);
        const { project, item, ...rest } = body;
        const res = await transport.send("run-skip", { project, item }, { body: rest, actor: who.runner ? body.actor : OWNER, signal });
        if (!res.ok) throw new Error(`${res.status}${detail(res)}`);
        return res.data;
      },
    });
  } catch (error) { die(error.message); }
}

