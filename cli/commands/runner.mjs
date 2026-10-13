// atelier runner. Its forms, flags and help are declared in src/usage/commands/runner.ts.
import { P, I, OWNER, apiToken, args, die, discoverModels, postAsRunner, reportUsage, resolveTokenActor, server, setupRunner, tokenActor, tokenRunner, workspacePath } from "../atelier.mjs";

// Queue polling has already resolved the runner's identity. A failed policy
// read must reach the job's infrastructure handling, never call()'s process.exit.
export async function hasPreparation(project, actor) {
  try {
    const res = await fetch(server() + `/api${P(project)}`, {
      headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": actor, ...(tokenRunner ? { "x-atelier-runner": tokenRunner } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.project?.policy) throw new Error("missing project policy");
    return !!data.project.policy.prepare;
  } catch (error) {
    throw Object.assign(new Error(`the preparation policy could not be read: ${error.message}`), { infrastructure: true });
  }
}

// `runner --discover` reports what each home model's harness serves (discover.mjs);
// `runner --usage` reports each tool's windows, served models and balances (usage.mjs).
export default async function runnerCommand() {
  if (args._[1] === "setup") return setupRunner();
  if (args.discover === true) return discoverModels();
  if (args.usage === true) return reportUsage();
  const { reexecSelf, runRunner, runnerCheckout } = await import("../runner.mjs");
  // The runner's own server calls for plan jobs and parts, as the queue's:
  // fetches under the runner's token, naming the assignment's actor. They
  // throw rather than die, so the runner's loop decides what a failure
  // means; a 422 from posting a plan is a result the runner reports, not an
  // error thrown here.
  const auth = (actor) => ({ authorization: `Bearer ${apiToken()}`, "x-atelier-actor": actor, ...(tokenRunner ? { "x-atelier-runner": tokenRunner } : {}), "content-type": "application/json" });
  const readJson = async (res) => { try { return await res.json(); } catch { return null; } };
  try {
    await runRunner(args, {
      credential: apiToken(),
      api: { server, I },
      workspacePath,
      // An idle runner reloads itself from this checkout once it holds the
      // deployed commit (t265), handing off to an initialized replacement.
      reload: { checkout: runnerCheckout(), reexec: reexecSelf },
      // The server's route level against the CLI's, checked at start: a
      // server behind this CLI would fail the runner's calls one by one. An
      // idle runner reads it again for the deployed commit (t265).
      // A server that cannot be read is refused as land refuses it, with
      // the same "does not answer" message (GET /api/version is public).
      async version(signal) {
        try {
          const res = await fetch(server() + "/api/version", { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
          if (!res.ok) return null;
          return await res.json();
        } catch {
          return null;
        }
      },
      // A poll that times out, cannot reach the server, or meets a 5xx or a
      // 429 throws an error marked transient, which the runner's loop takes
      // as the server being slow rather than a failure (transientQueueError).
      async queue(offer, signal) {
        await resolveTokenActor();
        let res;
        try {
          res = await fetch(server() + "/api/queue", {
            method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": tokenActor ?? OWNER, "content-type": "application/json" },
            body: JSON.stringify(offer),
          });
        } catch (error) {
          if (signal.aborted) throw error;
          throw Object.assign(new Error(`queue: ${error.message}`), { transient: true });
        }
        if (!res.ok) throw Object.assign(new Error(`queue: ${res.status}`), { transient: res.status >= 500 || res.status === 429 });
        const incomplete = res.headers.get("x-atelier-incomplete");
        if (incomplete) console.log(`Could not read: ${incomplete}. Tasks waiting there are not listed.`);
        return res.json();
      },
      // A busy runner's heartbeat (t537): its offer, marked as a heartbeat,
      // renews its last poll while a job runs, so the claim it builds under
      // is not taken for one its runner orphaned. Nothing is offered back.
      async heartbeat(offer, signal) {
        await resolveTokenActor();
        const res = await fetch(server() + "/api/queue", {
          method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": tokenActor ?? OWNER, "content-type": "application/json" },
          body: JSON.stringify({ ...offer, heartbeat: true }),
        });
        if (!res.ok) throw new Error(`heartbeat: ${res.status}`);
      },
      hasPreparation,
      async jobBrief(project, id, actor) {
        await resolveTokenActor();
        let res;
        try {
          res = await fetch(server() + `/api${I(project, id)}/job-brief`, { headers: auth(actor), signal: AbortSignal.timeout(30_000) });
        } catch (error) { throw Object.assign(new Error(`the job brief could not be read: ${error.message}`), { infrastructure: true }); }
        const data = await readJson(res);
        if (!res.ok) throw Object.assign(new Error(`the job brief could not be read: ${res.status} ${data?.detail ?? ""}`.trim()), { infrastructure: res.status >= 500 || res.status === 429 });
        return data;
      },
      async postPlan(project, id, actor, text) {
        await resolveTokenActor();
        let res;
        try {
          res = await fetch(server() + `/api${I(project, id)}/plan`, { method: "POST", headers: auth(actor), body: text, signal: AbortSignal.timeout(60_000) });
        } catch (error) { throw Object.assign(new Error(`the plan could not be posted: ${error.message}`), { infrastructure: true }); }
        const data = await readJson(res);
        if (res.status === 422 && data && data.valid === false) return data;
        if (!res.ok) throw Object.assign(new Error(`the plan could not be posted: ${res.status} ${data?.detail ?? ""}`.trim()), { infrastructure: res.status >= 500 || res.status === 429 });
        return data;
      },
      // The baseline's head (GET baseline-head, which a runner token may
      // read), for a post-merge review this runner keeps waiting on a merge
      // commit no source held (t591): it is claimed again once the head moves.
      async baselineHead(project, actor, signal) {
        await resolveTokenActor();
        const res = await fetch(server() + `/api${P(project)}/baseline-head`, { headers: auth(actor), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
        if (!res.ok) throw new Error(`baseline-head: ${res.status}`);
        return (await res.json())?.head ?? null;
      },
      // A run that stalled, timed out or was refused goes to the run
      // reports, under the runner's name, as a model's status does.
      reportRun: (body, runner, signal) => postAsRunner("/runs", body, runner, signal),
      // Why an idle runner found nothing to claim: its poll asked with
      // `why`, which lists each waiting dispatch of the token's projects
      // with its reason (t420); a runner token may not GET the owner's
      // listing. Asked only when a poll offers nothing, never on the busy
      // path. A server older than this answers with the tasks offered,
      // which carry no reason, so the runner says only its own.
      idleWhy: async (offer, signal) => {
        await resolveTokenActor();
        let res;
        try {
          res = await fetch(server() + "/api/queue", {
            method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": tokenActor ?? OWNER, "content-type": "application/json" },
            body: JSON.stringify({ ...offer, why: true }),
          });
        } catch (error) {
          if (signal.aborted) throw error;
          throw Object.assign(new Error(`queue: ${error.message}`), { transient: true });
        }
        if (!res.ok) throw Object.assign(new Error(`queue: ${res.status}`), { transient: res.status >= 500 || res.status === 429 });
        return res.json();
      },
      // A review this runner will not serve is reported to the project, so
      // the landing waiting on it can say, by runner, when every runner
      // that offers the reviewer has skipped (t353). Under a runner token,
      // which cannot act as the owner, the report goes as the review job's
      // actor, for which the poll was offered the job; under the owner's
      // token it goes as the owner, as the run reports do.
      async reportReviewSkip(body, runner, signal) {
        await resolveTokenActor();
        return postAsRunner(`${I(body.project, body.item)}/review-skip`, body, runner, signal, tokenRunner ? body.actor : OWNER);
      },
      // A build or plan job this runner gives up under its dispatch, after
      // failed runs or infrastructure failures in a row, is reported the
      // same way (t420), so status and show name this runner as what passes
      // it by.
      async reportRunSkip(body, runner, signal) {
        await resolveTokenActor();
        return postAsRunner(`${I(body.project, body.item)}/run-skip`, body, runner, signal, tokenRunner ? body.actor : OWNER);
      },
    });
  } catch (error) { die(error.message); }
}
