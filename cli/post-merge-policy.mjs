import { parsePostMerge } from "../src/post-merge.ts";

// NAME=CMD is split only on its first equals sign; quote the entire argument
// in the shell. Options are JSON so globs, commas and spaces remain literal.
export function postMergeArgs(args, actor = "owner", at = new Date().toISOString()) {
  const entries = args.multi?.["post-merge"];
  const options = args.multi?.["post-merge-options"] ?? [];
  const approval = args["post-merge-approval"];
  if (!entries) {
    if (options.length || approval !== undefined) throw new Error("--post-merge-options and --post-merge-approval require --post-merge");
    return args.reset === true ? null : undefined;
  }
  if (entries.length === 1 && entries[0] === "") {
    if (options.length || approval !== undefined) throw new Error("--post-merge \"\" must be given alone");
    return null;
  }
  const settings = new Map();
  for (const value of options) {
    const eq = typeof value === "string" ? value.indexOf("=") : -1;
    if (eq <= 0) throw new Error("--post-merge-options needs NAME=JSON");
    const name = value.slice(0, eq);
    if (settings.has(name)) throw new Error("duplicate post-merge options");
    const spec = JSON.parse(value.slice(eq + 1));
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("post-merge options must be an object");
    settings.set(name, spec);
  }
  const steps = entries.map(value => {
    const eq = typeof value === "string" ? value.indexOf("=") : -1;
    if (eq <= 0) throw new Error("--post-merge needs NAME=CMD");
    const name = value.slice(0, eq), options = settings.get(name);
    if (!options) throw new Error(`missing --post-merge-options for ${name}`);
    settings.delete(name);
    return { timeoutMs: 1200000, ...options, name, command: value.slice(eq + 1) };
  });
  if (settings.size) throw new Error("post-merge options name an unregistered step");
  return parsePostMerge({ version: 1, steps, approval: { reason: approval } }, actor, at);
}
