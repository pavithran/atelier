// A real runner process for test/run-sweep.test.mjs: node runner.mjs PARAMS.json.
// It runs runRunner over one criteria review whose agent is agent.mjs, and
// does nothing else: the test sends it SIGTERM, as the machine's launcher does
// on a stop flag, and watches what the run leaves behind.
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runRunner } from "../../../cli/runner.mjs";

process.env.ATELIER_LOAD = "0";
const { dir, cache, workspace, name, configPath, pidfile, claimed, assignment } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const io = {
  log: () => {}, stopped: () => false, env: { ...process.env, ATELIER_CACHE: cache }, ownerTokens: () => [], readSecret: () => "atl_" + "f".repeat(64),
  workspacePath: () => workspace,
  async cli(argv) { return argv[0] === "criteria-review-claim" ? JSON.stringify(claimed) : "{}"; },
  makeDir: (d) => mkdirSync(d, { recursive: true }), async brief() { return { file: join(dir, "brief.txt") }; }, verdictPath: () => join(dir, "verdict.txt"),
  readVerdict: () => "VERDICT: APPROVE\nSUMMARY: Fine.", async removeBrief() {}, removeFile() {}, removeTree() {},
  async dataHome() { return { dir: join(dir, "data") }; }, async removeDataHome() {},
};
await runRunner({ _: ["runner"], multi: {}, name, config: configPath }, {
  workspacePath: io.workspacePath, taskIO: io, credential: "runner-secret", heartbeatMs: 20, heartbeat: async () => {}, wait: () => pause(5),
  queue: async () => (existsSync(pidfile) ? [] : [assignment]),
});
