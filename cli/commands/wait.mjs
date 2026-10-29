// atelier wait. Its declaration lives in src/usage/commands/wait.ts.
import { I, OWNER, P, actor, args, die, itemArg, project, request } from "../atelier.mjs";
import { STAGE_ORDER, STATE_TARGETS, WAIT_FOR, waitFor, waitUntil } from "../wait.mjs";

// One task and one of the original targets reads the task itself, as before;
// anything else is a condition (G3) judged on the situation read, which
// lists the named tasks, their review requests and the runners. Every read
// is a GET: a wait holds no lock, two waits never interfere, and a server
// restart is ridden through and read again.
export default async function waitCommand() {
  const name = project();
  const seconds = (flag, fallback) => {
    if (args[flag] === undefined) return fallback;
    const n = Number(args[flag]);
    if (!Number.isFinite(n) || n <= 0) die(`--${flag} needs a number of seconds above zero: atelier wait t3 --${flag} 60`);
    return n;
  };
  const timeout = seconds("timeout", Infinity), interval = seconds("interval", 5);
  const opts = { intervalMs: interval * 1000, timeoutMs: timeout * 1000 };
  const condition = conditionOf();
  const result = condition
    ? await waitUntil(condition, (signal) => request("GET", `${P(name)}/situation${condition.ids?.length ? `?tasks=${condition.ids.join(",")}` : ""}`, undefined, OWNER, {}, signal), opts)
    : await (async () => {
      const id = itemArg(), as = await actor(OWNER), target = args.for ?? "merged";
      return waitFor(target, (signal) => request("GET", I(name, id), undefined, as, {}, signal), opts);
    })();
  console.log(result.text);
  process.exit(result.code);
}

const TARGETS = [...new Set([...WAIT_FOR, "answered", ...STATE_TARGETS, ...STAGE_ORDER])];
const ids = (flag) => {
  const list = String(args[flag] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!list.length || list.some((t) => !/^t[1-9][0-9]*$/.test(t))) die(`--${flag} needs task ids: atelier wait --${flag} t3,t4 --for merged`);
  return [...new Set(list)];
};

// The condition the flags name, or null for the original one-task wait.
function conditionOf() {
  const target = args.for ?? "merged";
  if (!TARGETS.includes(target)) die(`--for needs one of ${TARGETS.join(", ")}: atelier wait t3 --for merged`);
  const named = ["all", "any", "runner"].filter((f) => args[f] !== undefined);
  if (named.length > 1 || (named.length && args._[1] !== undefined)) die("name one of: a task (atelier wait t3), --all t3,t4, --any t3,t4, or --runner home:NAME --silent MINUTES");
  if (args.runner !== undefined || args.silent !== undefined) {
    const minutes = Number(args.silent);
    if (typeof args.runner !== "string" || !Number.isFinite(minutes) || minutes <= 0) die("--runner names the runner and --silent the minutes of silence: atelier wait --runner home:studio --silent 10");
    return { kind: "silent", runner: args.runner.toLowerCase(), minutes };
  }
  if (args.all !== undefined || args.any !== undefined) {
    const mode = args.all !== undefined ? "all" : "any", list = ids(mode);
    if (target === "reviewed" || target === "any-change") die(`--for ${target} waits on one task: atelier wait t3 --for ${target}`);
    return target === "answered" ? { kind: "answered", ids: list } : { kind: "tasks", mode, ids: list, target };
  }
  const id = args._[1];
  if (id === undefined || WAIT_FOR.includes(target)) return null;
  if (!/^t[1-9][0-9]*$/.test(id)) die(`atelier wait takes a task id such as t3, not "${id}"`);
  return target === "answered" ? { kind: "answered", ids: [id] } : { kind: "tasks", mode: "all", ids: [id], target };
}
