import { test } from "node:test";
import assert from "node:assert/strict";
import { checkStep, landStep } from "../cli/land.mjs";

// t161: a wave's checks share the host test slots because every landing runs
// the required checks as `atelier check`, whose checks run under the slot
// wrapper (test/check-load.test.mjs). This pins the land code's half, for the
// plain landing (cli/land.mjs, step wrapped by guardLease) and the Workflow
// landing (landStep directly): the check is the CLI command `check`, run as a
// child of this command for the project, and nothing else runs the checks.
// A landing that ran the suite itself would bypass the slots and bring back
// the 2026-10-21 load of three suites at once on one Mac.
test("both landings run the required checks as the atelier check command", async () => {
  const ran = [], recorded = [];
  const io = { atelier: "/x/atelier.mjs", name: "proj", env: { A: "1" }, print() {}, request: async () => { throw new Error("no failure to read"); },
    runCommand: async (argv, opts) => { ran.push({ argv, cwd: opts.cwd, env: opts.env }); return { passed: true, durationMs: 1, output: "", status: 0 }; } };
  const record = async (kind) => { recorded.push(kind); };
  // The plain landing's `step` adds a lease guard before this call and the
  // Workflow's has none; both end in landStep with the same arguments.
  await checkStep(io, "/projects/proj/items/t1", "t1", (kind, argv, cwd) => landStep(io, record, kind, argv, cwd), "/work/t1");
  assert.deepEqual(ran, [{ argv: [process.execPath, "/x/atelier.mjs", "check", "--project", "proj"], cwd: "/work/t1", env: { A: "1" } }]);
  assert.deepEqual(recorded, ["check"]);
});
