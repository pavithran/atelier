// atelier wait. Its declaration lives in src/usage/commands/wait.ts.
import { I, OWNER, actor, args, die, itemArg, project, request } from "../atelier.mjs";
import { WAIT_FOR, waitFor } from "../wait.mjs";

export default async function waitCommand() {
  const name = project(), id = itemArg(), as = await actor(OWNER);
  const target = args.for ?? "merged";
  if (!WAIT_FOR.includes(target)) die(`--for needs one of ${WAIT_FOR.join(", ")}: atelier wait ${id} --for merged`);
  const seconds = (flag, fallback) => {
    if (args[flag] === undefined) return fallback;
    const n = Number(args[flag]);
    if (!Number.isFinite(n) || n <= 0) die(`--${flag} needs a number of seconds above zero: atelier wait ${id} --${flag} 60`);
    return n;
  };
  const timeout = seconds("timeout", Infinity), interval = seconds("interval", 5);
  const result = await waitFor(target, () => request("GET", I(name, id), undefined, as), { intervalMs: interval * 1000, timeoutMs: timeout * 1000 });
  console.log(result.text);
  process.exit(result.code);
}
