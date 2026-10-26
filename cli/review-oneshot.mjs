// The one-shot review (t273). A landing that asks for a review no live runner
// offers runs the reviewer here, on this Mac: one review job of the runner
// (runReview in cli/runner.mjs), under the reviewer's own token from this
// Mac's runner config, with nothing polled and nothing held after the verdict.
// The landing records no review itself and never uses another identity.
import { offering } from "../src/dispatch/rules.ts";
import { defaultConfigPath, readConfig } from "./runner-config.mjs";

// Whether a live runner offers the reviewer for the review job. `offers` is
// GET /runners; null when it could not be read, which is no answer either
// way, so the caller leaves the request to the runners.
export function reviewerOffered(offers, reviewer, now = new Date()) {
  if (!Array.isArray(offers)) return null;
  return !!offering({ to: "home", job: "review" }, offers, now)?.actors.has(String(reviewer).toLowerCase());
}

// The reviewer's harness and model as this Mac's runner config names them, or
// the one that is missing. Named by what is missing: no config, the harness,
// or the model of a harness the config has.
export function reviewerHere(reviewer, configPath, read = readConfig) {
  const [harness, model] = String(reviewer).split("/");
  let config;
  try { config = read(configPath); }
  catch (error) {
    const none = error?.code === "ENOENT";
    return { missing: none ? `${reviewer} cannot be run on this Mac: there is no runner config at ${configPath}` : `${reviewer} cannot be run on this Mac: the runner config at ${configPath} is unusable (${error.message})` };
  }
  const harnesses = config.agents.filter((a) => a.agent.toLowerCase() === harness.toLowerCase());
  if (!harnesses.length) return { missing: `the harness ${harness} is missing: ${configPath} lists ${[...new Set(config.agents.map((a) => a.agent))].join(", ")}, so ${reviewer} cannot be run on this Mac` };
  const entry = harnesses.find((a) => a.models.some((m) => m.toLowerCase() === model.toLowerCase()));
  if (!entry) return { missing: `the model ${model} is missing: ${configPath} lists ${harnesses.flatMap((a) => a.models).join(", ")} for ${harness}, so ${reviewer} cannot be run on this Mac` };
  return { config, agent: entry.agent, model: entry.models.find((m) => m.toLowerCase() === model.toLowerCase()), configPath };
}

// Claims the review request and runs the reviewer once. The claim, the
// verdict and any release are the review job's, made with the reviewer's own
// token (reviewToken); a job that fails releases its claim before it returns,
// so nothing is held when this does. Answers { missing } when the model is
// not on this Mac (nothing was claimed), otherwise { phase, verdict?, reason? }.
// deps: configPath, read, runRunner, runReview, api, workspacePath, checkoutOf,
// taskIO (tests replace them).
export async function runOneShotReview({ project, id, reviewer, log = () => {}, deps = {} }) {
  const here = reviewerHere(reviewer, deps.configPath ?? defaultConfigPath(), deps.read);
  if (here.missing) return { missing: here.missing };
  const runtime = deps.runRunner ? deps : { ...(await import("./atelier.mjs").then((m) => ({ api: { server: m.server, I: m.I }, workspacePath: m.workspacePath, checkoutOf: (name) => m.cfg.projects?.[name]?.path ?? null }))), ...deps };
  const { runRunner, runReview } = deps.runRunner ? { runRunner: deps.runRunner, runReview: deps.runReview } : await import("./runner.mjs");
  const name = `home:oneshot-${id}-${process.pid}`;
  const actor = `${here.agent}/${here.model}`;
  log(`no live runner offers ${reviewer}: running its review of ${id} once on this Mac as ${name}`);
  // No runner token: the review job's calls carry the reviewer's own token,
  // and the landing's token goes to none of them.
  return runRunner({ _: ["runner"], multi: { name: [name] }, name, config: here.configPath }, {
    credential: null, taskIO: deps.taskIO, api: runtime.api, workspacePath: runtime.workspacePath, checkoutOf: runtime.checkoutOf,
    oneShot: ({ io, config, name: runner }) => runReview({ project, item: { id }, agent: here.agent, model: here.model, actor }, config, runner, io),
  });
}
