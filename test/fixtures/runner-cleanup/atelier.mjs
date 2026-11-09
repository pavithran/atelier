// A stand-in for `atelier runner --name NAME`: ps shows it as a runner, and it
// does what a runner slow to exit does, ignoring SIGTERM and SIGINT, so
// only SIGKILL ends it. With --once it exits at once, as a runner that
// has finished. With --crash it dies abnormally after starting a child. Used by test/runner-cleanup.test.mjs.
if (process.argv.includes("--once")) process.exit(0);
// With --crash it starts a child of its own, which ignores SIGTERM and whose
// pid it appends to ATELIER_FIXTURE_PIDS, then dies abnormally, leaving the
// child parented to launchd, outside the runner's tree.
if (process.argv.includes("--crash")) {
  const { spawn } = await import("node:child_process");
  const { appendFileSync } = await import("node:fs");
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  appendFileSync(process.env.ATELIER_FIXTURE_PIDS, `${child.pid}\n`);
  process.exit(1);
}
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
setInterval(() => {}, 1000);
