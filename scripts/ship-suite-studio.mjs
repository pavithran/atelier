// Run the captured source on the Studio without using its working checkout.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceHead, SHIP_GIT } from "./ship-studio.mjs";

export const remoteSuite = `
const { spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const path = require("node:path");
mkdirSync(".scratch", { recursive: true });
const work = mkdtempSync(path.resolve(".scratch/atelier-ship-"));
const head = process.argv[1];
function run(command, args, cwd) {
  const r = spawnSync(command, args, { cwd, stdio: "inherit", timeout: 59 * 60_000,
    env: { ...process.env, ATELIER_TEST_TIMEOUT_MS: "3540000" } });
  if (r.error || r.status !== 0) throw new Error(command + " failed: " + (r.error?.message ?? r.status));
}
try {
  writeFileSync(path.join(work, "source.bundle"), readFileSync(0));
  run("git", ["clone", "--quiet", path.join(work, "source.bundle"), path.join(work, "source")], work);
  const cwd = path.join(work, "source");
  run("git", ["checkout", "--quiet", "--detach", head], cwd);
  console.log("Studio full suite at " + head);
  run("npm", ["ci", "--no-audit", "--no-fund"], cwd);
  run("npm", ["test"], cwd);
} finally { rmSync(work, { recursive: true, force: true }); }
`;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function studioSuite({ cwd = process.cwd(), env = process.env, run = spawnSync } = {}) {
  const head = sourceHead({ cwd, env });
  mkdirSync(resolve(cwd, ".scratch"), { recursive: true });
  const bundle = resolve(cwd, ".scratch", `ship-${process.pid}.bundle`);
  try {
    const made = run(SHIP_GIT, ["bundle", "create", bundle, "HEAD"], { cwd, stdio: "inherit" });
    if (made.error || made.status !== 0) throw new Error("Cannot snapshot the shipped head.");
    const r = run("/usr/bin/ssh", ["-o", "BatchMode=yes", "--", "ai-studio",
      `PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" node -e ${quote(remoteSuite)} ${head}`],
      { input: readFileSync(bundle), stdio: ["pipe", "inherit", "inherit"], env, timeout: 59 * 60_000 });
    if (r.error || r.status !== 0) throw new Error(`Studio full suite failed: ${r.error?.message ?? r.status}`);
  } finally { try { unlinkSync(bundle); } catch (e) { if (e.code !== "ENOENT") throw e; } }
  sourceHead({ cwd, env });
  return head;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { studioSuite(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
