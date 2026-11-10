// A stand-in agent for test/run-sweep.test.mjs: node agent.mjs MODE PIDFILE CWD.
// It starts a detached sleeper (its own session, so outside the agent's
// process group) through a launcher that exits at once, so the sleeper is an
// orphan the agent's tree no longer reaches. The sleeper's pid is appended to
// PIDFILE. CWD, if not "-", is the sleeper's working directory, so it is
// outside the run's workspace; the launcher then stays alive a moment, as a
// parent does while its child starts up. The run's marker (ATELIER_RUN_MARK)
// is written to PIDFILE.mark. Then MODE says what the agent does: "exit" ends
// 0, "fail" ends 1, "hang" stays running. The sleeper ends itself after 60 s,
// so a failed test leaves nothing for long.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [mode, pidfile, cwd = "-"] = process.argv.slice(2);
writeFileSync(`${pidfile}.mark`, process.env.ATELIER_RUN_MARK ?? "");
const where = cwd === "-" ? "" : `, cwd: ${JSON.stringify(cwd)}`;
const linger = cwd === "-" ? "" : "setTimeout(() => {}, 800);";
const launcher = `const { spawn } = require("node:child_process");
const s = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore"${where} });
s.unref();
require("node:fs").appendFileSync(${JSON.stringify(pidfile)}, s.pid + "\\n");
${linger}`;
await new Promise((resolve) => spawn(process.execPath, ["-e", launcher], { stdio: "ignore" }).on("exit", resolve));
if (mode === "fail") process.exit(1);
if (mode === "hang") setInterval(() => {}, 1000);
