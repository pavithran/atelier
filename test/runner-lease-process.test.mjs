import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { ROUTE_LEVEL } from "../src/route-level.ts";

// t505: inside `atelier runner`, cli/atelier.mjs is the main module and is
// still in its top-level await. A lease call (review-renew, -release,
// -unparsable with --request) that imported atelier.mjs again waited on that
// unfinished evaluation; with nothing else left to run, Node exited 13
// ("unsettled top-level await") on the runner's first review. This runs the
// real CLI as the main module against a server of the test's own: the review
// is claimed with a request number, its clone fails, and the runner must
// release the claim through the lease path and exit normally.

const root = resolve(".cache/runner-lease-process-tests");
mkdirSync(root, { recursive: true });
const model = "glm-5.3", actor = `opencode/${model}`;
const H0 = "0".repeat(40), H1 = "a".repeat(40);

test("a review runner's lease call keeps the CLI process alive and reaches the server", { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(root, "test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  let offered = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, path: req.url, body });
      let answer = {};
      if (req.url === "/api/version") answer = { routeLevel: ROUTE_LEVEL };
      else if (req.url === "/api/config") answer = { ownerActor: "owner", ownerName: "The owner", actor };
      else if (req.url === "/api/queue") {
        answer = offered ? [] : [{ project: "atelier", item: { id: "t21", dispatch: { job: "review" } }, agent: "opencode", model, actor }];
        offered = true;
      } else if (req.url.endsWith("/review-claim")) answer = {
        request: 7, head: H1, plan: null, events: [], owner: "owner",
        item: { id: "t21", title: "Review rules", base: H0, scope: ["src/**"], fork: "p--t21", head: H1 },
        need: { needed: true, reason: "a protected change", head: H1, kind: "review", basis: "task", changeClass: "protected", changedPaths: ["src/a.ts"], outOfScope: [], checks: [], round: 1 },
        // A clone that cannot succeed: the runner must then release its claim.
        readToken: { remote: "http://127.0.0.1:9/nowhere", token: "read-token", defaultBranch: "main" },
        target: { remote: "http://127.0.0.1:9/nowhere", token: "base-token", branch: "main" },
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;

  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: origin }));
  mkdirSync(join(dir, "tokens"));
  writeFileSync(join(dir, "tokens/glm"), `atl_${"e".repeat(64)}\n`, { mode: 0o600 });
  const config = join(dir, "runner.json");
  writeFileSync(config, JSON.stringify({ agents: [{ agent: "opencode", models: [model], command: ["unused", "{model}", "{brief_file}", "{diff_file}", "{verdict_file}"] }], jobs: ["review"], tokens: { [model]: "tokens/glm" } }));

  const cli = resolve("cli/atelier.mjs");
  const env = { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file", ATELIER_SERVER: origin, ATELIER_OWNER: "owner", ATELIER_TOKEN: `atl_owner_${"0".repeat(60)}`, GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: root };
  for (const key of ["ATELIER_RUNNER_TOKEN", "ATELIER_RUNNER_NAME", "ATELIER_ACTOR"]) delete env[key];
  const child = spawn(process.execPath, [cli, "runner", "--name", "home:t505", "--config", config, "--once"], { cwd: dir, env });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((done) => child.on("close", done));

  assert.doesNotMatch(output, /unsettled top-level await/, output);
  assert.notEqual(code, 13, output);
  const release = requests.find((r) => r.path === "/api/projects/atelier/items/t21/review-release");
  assert.ok(release, `the claim was released through the lease path\n${output}\n${requests.map((r) => `${r.method} ${r.path}`).join("\n")}`);
  assert.equal(JSON.parse(release.body).request, 7);
});
