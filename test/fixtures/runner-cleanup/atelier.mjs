// A stand-in for `atelier runner --name NAME`: ps shows it as a runner, and it
// does what a runner slow to exit does, ignoring SIGTERM and SIGINT, so
// only SIGKILL ends it. With --once it exits at once, as a runner that
// has finished. Used by test/runner-cleanup.test.mjs.
if (process.argv.includes("--once")) process.exit(0);
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
setInterval(() => {}, 1000);
