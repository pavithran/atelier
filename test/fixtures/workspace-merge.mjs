// The workspace merge of main a runner's merge-main job makes
// (mergeMainAndRegenerate in cli/land.mjs), run on its own against the land
// fixture's stand-in server (test/land-fixture.mjs, workspaceMerge): main is
// merged into the task's workspace through the merge pipeline, the route
// level compared, the fixtures regenerated, and the result pushed with
// `atelier push`, each step recorded as a land.* event. The tests of that
// merge reached it through the 1.x landing Workflow's workspace step until
// the Workflow was removed (Atelier 2.0, task 6). Not a test file:
// discovery runs only *.test.* and *.spec.* files.
//
// Usage: node test/fixtures/workspace-merge.mjs ID, in the environment the
// fixture's CLI runs with. Exits 0 once the merge is pushed; prints the
// stop and exits 1 otherwise.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { landStep, mergeMainAndRegenerate } from "../../cli/land.mjs";

const id = process.argv[2], name = "proj";
const server = process.env.ATELIER_SERVER;
const itemPath = `/projects/${name}/items/${id}`;
const dir = `${process.env.ATELIER_CACHE}/work/${name}/${id}`;
const print = (line) => console.log(line);
const request = async (method, path, body) => {
  const res = await fetch(`${server}/api${path}`, { method, headers: { authorization: `Bearer ${process.env.ATELIER_TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${data.error ?? res.status}: ${data.detail ?? ""}`), { status: res.status });
  return data;
};
// Git as the landing's io runs it: a failure throws, and allowFail answers
// Git's own result. The fixture's remotes are local paths, so no token rides.
const git = (args, o = {}) => {
  const r = spawnSync("git", args, { cwd: o.cwd, env: { ...process.env, ...o.env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (o.allowFail) return r;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${(r.stderr || r.stdout || "").trim()}`);
  return o.raw ? r.stdout : r.stdout.trim();
};
const record = async (step, ms, data = {}) => {
  try { await request("POST", `${itemPath}/land`, { step, ms: Math.max(0, Math.round(ms)), ...data }); } catch (error) { print(`Warning: the ${step} step could not be recorded: ${error.message}`); }
};
const io = {
  name, id, request, git, print, env: process.env,
  atelier: fileURLToPath(new URL("../../cli/atelier.mjs", import.meta.url)),
  redact: (text) => text, secrets: () => [],
};
try {
  const d0 = await request("GET", itemPath);
  const regenerate = typeof d0.policy?.regenerate === "string" ? d0.policy.regenerate : null;
  const merged = await mergeMainAndRegenerate(io, { dir, id, name, regenerate, record, guard: () => {}, d0 });
  await landStep(io, record, "push", ["push"], dir, () => ({ head: merged.head }));
  print(`Merged main into ${id}'s workspace and pushed ${merged.head.slice(0, 8)}.`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
