// atelier forget-skip. Its forms, flags and help are declared in src/usage/commands/forget-skip.ts.
import { OWNER, args, call, itemArg, project } from "../atelier.mjs";

// Clears what a runner (every runner without --runner) remembers of a task: a
// skip, a refusal, a failure count, a wait (G5). The server keeps the memory;
// the runner drops it when it next reads its record. A task nothing is
// remembered of is not an error.
export default async function forgetSkipCommand() {
  const name = project(), id = itemArg();
  const runner = typeof args.runner === "string" ? args.runner : undefined;
  const res = await call("POST", "/runners/forget-skip", { project: name, item: id, ...(runner ? { runner } : {}) }, OWNER);
  const n = res?.forgotten ?? 0;
  console.log(n ? `${runner ?? "every runner"} no longer remembers ${n} stop${n === 1 ? "" : "s"} of ${id}; it is tried again at the runner's next poll` : `no remembered skip of ${id}${runner ? ` on ${runner}` : ""}`);
}
