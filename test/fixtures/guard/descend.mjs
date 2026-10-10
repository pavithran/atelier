// Children that exit at once but leave a descendant behind: a shell that
// starts a sleeper with & (async, then sync by execSync and execFileSync).
// Each writes the sleeper's pid to a line of GUARD_PID_FILE, and passes.
import { test } from "node:test";
import { execFileSync, execSync, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const file = process.env.GUARD_PID_FILE;
const sleeper = "sleep 300 > /dev/null 2>&1 & echo $!";

test("an async child's background process", async () => {
  const child = spawn("/bin/sh", ["-c", sleeper], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (s) => out += s);
  await new Promise((ok) => child.on("close", ok));
  appendFileSync(file, out);
});

test("a sync child's background process", () => {
  appendFileSync(file, execSync(sleeper, { encoding: "utf8" }));
  appendFileSync(file, execFileSync("/bin/sh", ["-c", sleeper], { encoding: "utf8" }));
});
