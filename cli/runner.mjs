import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseConfig, readConfig } from "./runner-config.mjs";

export function offerFrom(config, name) {
  if (typeof name !== "string" || !/^home:[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) throw new Error("use --name home:NAME");
  const { agents, errors } = parseConfig(config);
  if (errors.length) throw new Error(errors.join("; "));
  return { runner: `home:${name.slice(5)}`, kind: "home", agents: agents.map(({ agent, models }) => ({ agent, models })) };
}

export function briefFor(item, project) {
  return [
    `Project: ${project}`, `Task: ${item.id}`, `Title: ${item.title}`, "", "Scope:",
    ...item.scope.map((path) => `  ${path}`), "", "Rules:",
    "Stay in scope. Work only in this workspace.",
    "Write tests for new behaviour.",
    "Run npm test and npm run typecheck. Both must pass.",
    `Commit your work with a final line: Agent: ${item.owner ?? "<harness>/<model>"}`,
    "Do not push. Run no atelier command.", "",
  ].join("\n");
}

export function commandFor(entry, { model, briefFile, workspace }) {
  const values = { model, brief_file: briefFile, workspace };
  return entry.command.map((arg) => arg.replace(/\{(model|brief_file|workspace)\}/g, (_, key) => values[key]));
}

// Observations are supplied by the loop; terminal states remain terminal.
export function nextStep(state, result) {
  if (["failed", "submitted"].includes(state.phase)) return state;
  if (result.error) return { ...state, phase: "failed", reason: String(result.error) };
  const expected = { idle: "queue", asked: "claim", claimed: "start", working: "exit", committed: "finish" };
  if (result.type !== expected[state.phase]) return { ...state, phase: "failed", reason: `unexpected ${result.type} while ${state.phase}` };
  switch (state.phase) {
    case "idle": return { phase: "asked", assignment: result.assignment ?? null };
    case "asked": return result.empty ? { phase: "idle" } : { ...state, phase: "claimed" };
    case "claimed": return { ...state, phase: "working" };
    case "working":
      if (result.code !== 0) return { ...state, phase: "failed", reason: `harness exited ${result.code}` };
      if (!result.head || result.head === result.before) return { ...state, phase: "failed", reason: "harness made no new commit" };
      return { ...state, phase: "committed", head: result.head };
    case "committed": return { ...state, phase: "submitted" };
    default: return { ...state, phase: "failed", reason: "unknown runner state" };
  }
}

const cli = fileURLToPath(new URL("./atelier.mjs", import.meta.url));
const line = (message) => console.log(`runner: ${String(message).replace(/[\r\n]+/g, " ")}`);

function execute(argv, { cwd, signal, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("interrupted"));
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, detached: true,
      stdio: capture ? ["ignore", "pipe", "inherit"] : ["ignore", "inherit", "inherit"] });
    let output = "", timer, error;
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { /* The child may already have exited. */ } };
    const stop = () => { kill("SIGTERM"); timer = setTimeout(() => kill("SIGKILL"), 5000); };
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.on("error", (e) => { error = e; });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      if (signal?.aborted) kill("SIGKILL");
      signal?.removeEventListener("abort", stop);
      if (error) reject(error);
      else resolve({ code, output: output.trim(), signal: sig });
    });
  });
}

async function checked(argv, options) {
  const result = await execute(argv, options);
  if (result.code !== 0) throw new Error(`${argv[0]} exited ${result.signal ?? result.code}`);
  return result.output;
}

// Dependencies keep the task lifecycle testable without a server or a harness.
export async function runTask(assignment, config, name, io) {
  let state = nextStep({ phase: "idle" }, { type: "queue", assignment });
  const advance = (result) => { state = nextStep(state, result); io.log(`${state.phase}${state.reason ? `: ${state.reason}` : ""}`); };
  io.log("asked");
  if (!assignment) { advance({ type: "claim", empty: true }); return state; }
  const { project, item, agent, model, actor } = assignment;
  let workspace, before, claimed = false, brief;
  try {
    const entry = config.agents.find((a) => a.agent === agent && a.models.includes(model));
    if (!entry || actor !== `${agent}/${model}`) throw new Error("queue returned an unsupported assignment");
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(project) || !/^t[0-9]+$/.test(item.id)) throw new Error("queue returned an invalid project or task id");
    workspace = io.workspacePath(project, item.id);
    if (io.stopped()) throw new Error("interrupted");
    await io.cli(["claim", item.id, "--project", project, "--as", actor, "--runner", name]);
    claimed = true;
    advance({ type: "claim" });
    before = await io.head(workspace);
    if (io.stopped()) throw new Error("interrupted");
    brief = await io.brief(workspace, briefFor({ ...item, owner: actor }, project));
    advance({ type: "start" });
    const result = await io.harness(commandFor(entry, { model, briefFile: brief.file, workspace }), workspace);
    const head = await io.head(workspace);
    advance(io.stopped() ? { error: "interrupted" } : { type: "exit", code: result.code, before, head });
    if (state.phase === "failed") throw new Error(state.reason);
    await io.cli(["finish", item.id, "--project", project, "--as", actor], workspace);
    advance({ type: "finish" });
  } catch (error) {
    if (state.phase !== "failed") advance({ error: error.message });
    if (claimed && before) {
      let head;
      try { head = await io.head(workspace); } catch { /* Unknown commit status preserves the claim. */ }
      if (head === before) {
        try { await io.cli(["release", item.id, "--project", project, "--as", actor, "--note", state.reason], workspace); io.log("released: no new commit"); }
        catch (releaseError) { io.log(`claim preserved: release failed: ${releaseError.message}`); }
      } else io.log("claim preserved: a commit exists or commit status is unknown");
    } else io.log("claim not released: claim or commit status is unknown");
  } finally {
    if (brief) await io.removeBrief(brief);
  }
  return state;
}

export async function runRunner(args, { queue, workspacePath }) {
  if (args._.length !== 1 || Object.keys(args.multi).some((key) => !["name", "once", "config"].includes(key) || args.multi[key].length !== 1) ||
      (args.once !== undefined && args.once !== true) || (args.config !== undefined && typeof args.config !== "string")) {
    throw new Error("usage: atelier runner --name home:NAME [--once] [--config PATH]");
  }
  const config = readConfig(args.config), offer = offerFrom(config, args.name);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  const io = {
    workspacePath, log: line, stopped: () => controller.signal.aborted,
    cli: (argv, cwd) => checked([process.execPath, cli, ...argv], { cwd }),
    head: (cwd) => checked(["git", "rev-parse", "HEAD"], { cwd, capture: true }),
    harness: (argv, cwd) => execute(argv, { cwd, signal: controller.signal }),
    brief(workspace, text) {
      const file = join(dirname(workspace), `.atelier-brief-${randomUUID()}.txt`);
      writeFileSync(file, text, { mode: 0o600, flag: "wx" });
      return { file };
    },
    removeBrief: ({ file }) => rmSync(file, { force: true }),
  };
  try {
    while (!controller.signal.aborted) {
      let state;
      try {
        const tasks = await queue(offer, controller.signal);
        if (!Array.isArray(tasks)) throw new Error("queue did not return an array");
        if (controller.signal.aborted) break;
        state = await runTask(tasks[0], config, offer.runner, io);
      } catch (error) { state = nextStep({ phase: "idle" }, { error: error.message }); line(`failed: ${state.reason}`); }
      if (args.once) { if (state.phase === "failed" && !controller.signal.aborted) process.exitCode = 1; break; }
      await delay(30_000, undefined, { signal: controller.signal }).catch((error) => { if (error.name !== "AbortError") throw error; });
    }
  } finally { process.removeListener("SIGINT", stop); }
}
