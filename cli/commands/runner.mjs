// atelier runner. Its forms, flags and help are declared in src/usage/commands/runner.ts.
import { I, OWNER, actor, apiToken, args, auth, die, discoverModels, postAsRunner, project, readJson, reportUsage, resolveTokenActor, server, setupRunner, tokenActor, tokenRunner, workspacePath } from "../atelier.mjs";

// `runner --discover` reports what each home model's harness serves (discover.mjs);
// `runner --usage` reports each tool's windows, served models and balances (usage.mjs).
export default async function runnerCommand() {
  if (args._[1] === "setup") return setupRunner();
  if (args.discover === true) return discoverModels();
  if (args.usage === true) return reportUsage();
  const { runRunner } = await import("../runner.mjs");
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
      workspacePath,
      // The server's route level against the CLI's, checked once at start:
      // a server behind this CLI would fail the runner's calls one by one.
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
      // A run that stalled, timed out or was refused goes to the run
      // reports, under the runner's name, as a model's status does.
      reportRun: (body, runner, signal) => postAsRunner("/runs", body, runner, signal),
    });
  } catch (error) { die(error.message); }
}
