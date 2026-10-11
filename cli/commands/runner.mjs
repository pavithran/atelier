// atelier runner. Its forms, flags and help are declared in src/usage/commands/runner.ts.
import { OWNER, apiToken, args, die, discoverModels, reportUsage, server, setupRunner, workspacePath } from "../atelier.mjs";

// `runner --discover` reports what each home model's harness serves (discover.mjs);
// `runner --usage` reports each tool's windows, served models and balances (usage.mjs).
export default async function runnerCommand() {
  if (args._[1] === "setup") return setupRunner();
  if (args.discover === true) return discoverModels();
  if (args.usage === true) return reportUsage();
  const { runRunner, runnerTransport } = await import("../runner.mjs");
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
      workspacePath,
      // The server's route level against the CLI's, checked once at start:
      // a server behind this CLI would fail the runner's calls one by one.
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
        if (res.incomplete) console.log(`Could not read: ${res.incomplete}. Tasks waiting there are not listed.`);
        return res.data;
      },
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
      // A run that stalled, timed out or was refused goes to the run
      // reports, under the runner's name, as a model's status does. A report
      // the server refuses throws its status and detail, as a skip does.
      async reportRun(body, _runner, signal) {
        const res = await transport.send("runs", {}, { body, actor: OWNER, signal });
        if (!res.ok) throw new Error(`${res.status}${detail(res)}`);
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
    });
  } catch (error) { die(error.message); }
}
