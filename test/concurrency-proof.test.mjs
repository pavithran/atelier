import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// t339: the concurrency proof drives N simulated agents against a throwaway
// project over the CLI's request protocol. These tests stand in for the live
// server: one owner per item (a claim is refused with its holder named), one
// fork per claim, and pushes observed, over a real local HTTP server, so the
// script's concurrency and its report are both judged on what was measured.

const script = resolve("bin/concurrency-proof.mjs");

// A fake server with the item routes the proof touches, tracking every request
// so the tests can check exactly what raced. With bareRoot, each fork is a
// real local bare repository and a push is observed from its actual head.
async function fakeServer(t, { bareRoot = null, fault = null } = {}) {
  const items = new Map();
  let n = 0;
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const method = req.method;
    const actor = req.headers["x-atelier-actor"] ?? "owner";
    let body = {};
    if (method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { body = {}; }
    }
    requests.push({ method, path: url.pathname, actor, body });
    let send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (url.pathname === "/api/config") return send(200, { ownerActor: "owner", ownerName: "Pavi" });
    const m = /^\/api\/projects\/([^/]+)\/items(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return send(404, { error: "not_found", detail: "no such route" });
    const [, name, id, verb] = m;
    if (!id && method === "POST") {
      const item = { id: `t${++n}`, title: body.title ?? "", state: "open", owner: null, firstOwner: null, fork: null, head: null, pushes: 0 };
      items.set(item.id, item);
      return send(201, item);
    }
    const item = items.get(id);
    if (!item) return send(404, { error: "not_found", detail: `no item ${id}` });
    if (!verb && method === "GET") return send(200, { item, criteria: [], evidence: [] });
    // fault(req) may answer 503 before the request is handled ("before"), or
    // handle it and then lose the reply as a 503 ("after").
    const f = fault ? fault({ method, verb, actor, item }) : null;
    if (f?.when === "before") { res.writeHead(503, { "content-type": "application/json", ...(f.headers ?? {}) }); return res.end(JSON.stringify(f.body ?? { error: "unavailable", detail: "try again" })); }
    if (f?.when === "after") {
      const real = send;
      send = (status, data) => real(503, { error: "artifacts_unavailable", detail: "reply lost" });
    }
    if (verb === "claim") {
      if (item.owner && item.owner !== actor) {
        return send(409, { error: "owned", detail: `${id} is owned by ${item.owner}; ask for a handoff` });
      }
      if (!item.owner) item.firstOwner = actor;
      item.owner = actor;
      item.state = "claimed";
      if (!item.fork) {
        item.fork = `${name}--${id}`;
        if (bareRoot) {
          mkdirSync(join(bareRoot, item.fork), { recursive: true });
          spawnSync("git", ["init", "--bare", "-q", join(bareRoot, item.fork)], { encoding: "utf8" });
        }
      }
      const remote = bareRoot ? join(bareRoot, item.fork) : `https://git.test/${item.fork}.git`;
      const token = `art_secret_${item.fork}`;
      return send(200, { item, workspace: { remote, token, expiresAt: new Date(Date.now() + 3600e3).toISOString(), defaultBranch: "main" }, baseline: { remote, token, defaultBranch: "main" } });
    }
    if (verb === "push") {
      item.pushes += 1;
      let observed = body.head ?? null;
      if (bareRoot && item.fork) {
        const r = spawnSync("git", ["--git-dir", join(bareRoot, item.fork), "rev-parse", "main"], { encoding: "utf8" });
        observed = r.status === 0 ? r.stdout.trim() : null;
      }
      item.head = observed;
      return send(200, { item });
    }
    if (verb === "abandon") { item.state = "abandoned"; item.owner = null; return send(200, item); }
    return send(404, { error: "not_found", detail: "no such route" });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise((ok) => server.close(ok)));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    items: () => [...items.values()],
    requests: () => [...requests],
  };
}

function run(t, server, argv) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-concurrency-proof-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [script, "--project", "demo", "--server", server.url, "--token", "owner-token", "--scratch", join(dir, ".scratch"), ...argv], { cwd: dir, env: { ...process.env } });
  let output = "";
  child.stdout.on("data", (s) => (output += s));
  child.stderr.on("data", (s) => (output += s));
  return new Promise((ok) => child.on("close", (code) => ok({ code, output })));
}

test("N agents claim N tasks at once: all succeed, each with its own fork, and the tasks are abandoned after", async (t) => {
  const server = await fakeServer(t);
  const r = await run(t, server, ["--agents", "5"]);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /claim spread: 5 requests, 5 ok/);
  assert.match(r.output, /5 distinct forks/);
  assert.match(r.output, /claim race: 5 requests, 1 ok, 4 refused/);
  assert.match(r.output, /holder sim\/agent-\d/);
  assert.match(r.output, /4\/4 refusals name the holder/);
  assert.match(r.output, /pushes: none \(run with --push/);
  assert.match(r.output, /cleanup: 6 requests, 6 ok/);

  const items = server.items();
  const spread = items.filter((i) => i.title.startsWith("concurrency proof task"));
  assert.equal(spread.length, 5);
  assert.deepEqual(new Set(spread.map((i) => i.firstOwner)), new Set([0, 1, 2, 3, 4].map((i) => `sim/agent-${i}`)));
  assert.equal(new Set(spread.map((i) => i.fork)).size, 5, "each agent gets its own fork");
  const race = items.find((i) => i.title === "concurrency proof race");
  assert.ok(race, "the race task exists");
  assert.match(race.firstOwner, /^sim\/agent-\d$/, "one agent won the race");
  assert.ok(items.every((i) => i.state === "abandoned"), "every task is cleaned up");

  const raceClaims = server.requests().filter((q) => q.path.endsWith(`/${race.id}/claim`));
  assert.equal(raceClaims.length, 5);
  assert.equal(raceClaims.filter((q) => q.actor === race.firstOwner).length, 1);
  assert.equal(raceClaims.filter((q) => q.actor !== race.firstOwner).length, 4);
});

test("N agents race for one task: the holder is named to every refusal", async (t) => {
  const server = await fakeServer(t);
  const r = await run(t, server, ["--agents", "7"]);
  assert.equal(r.code, 0, r.output);
  const race = server.items().find((i) => i.title === "concurrency proof race");
  const refusals = server.requests().filter((q) => q.path.endsWith(`/${race.id}/claim`) && q.actor !== race.firstOwner);
  assert.equal(refusals.length, 6);
  // The refusal the server sent for each losing claim names the holder; the
  // report confirms the script read the same.
  assert.match(r.output, /6\/6 refusals name the holder/);
});

test("--push makes a tiny commit and push per agent, and each push is observed at the fork's head", async (t) => {
  const bareRoot = mkdtempSync(join(tmpdir(), "atelier-concurrency-proof-bare-"));
  t.after(() => rmSync(bareRoot, { recursive: true, force: true }));
  const server = await fakeServer(t, { bareRoot });
  const r = await run(t, server, ["--agents", "3", "--push"]);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /pushes: 3 requests, 3 ok/);

  const spread = server.items().filter((i) => i.title.startsWith("concurrency proof task"));
  assert.equal(spread.length, 3);
  for (const item of spread) {
    assert.equal(item.pushes, 1, "one push observed per fork");
    assert.match(item.head ?? "", /^[a-f0-9]{40}$/, "the observed head is the pushed commit");
  }
});

test("--push runs the N git pushes concurrently, not one after another", async (t) => {
  const bareRoot = mkdtempSync(join(tmpdir(), "atelier-concurrency-proof-bare-"));
  t.after(() => rmSync(bareRoot, { recursive: true, force: true }));
  const server = await fakeServer(t, { bareRoot });
  const r = await run(t, server, ["--agents", "5", "--push", "--json"]);
  assert.equal(r.code, 0, r.output);
  const report = JSON.parse(r.output);
  assert.equal(report.phases.pushes.ok, 5);
  // The script counts its live git subprocesses while it pushes, and reports
  // the peak. Blocking on spawnSync would mean at most one git process is ever
  // alive (or none at all, since the counting lives in the async spawn path),
  // so this reading of 5 is the proof the pushes really ran together.
  assert.equal(report.phases.pushes.maxConcurrent, 5, `expected all 5 git pushes to overlap, measured at most ${report.phases.pushes.maxConcurrent} in flight`);
});

test("the race holder is read from item.owner in the server's item shape", async (t) => {
  const server = await fakeServer(t);
  const r = await run(t, server, ["--agents", "3", "--json"]);
  assert.equal(r.code, 0, r.output);
  const report = JSON.parse(r.output);
  const race = server.items().find((i) => i.title === "concurrency proof race");
  assert.equal(report.phases.claimRace.holder, race.firstOwner, "the holder is the agent that won the race");
  assert.equal(report.phases.claimRace.holderError, null);
});

test("the report is machine-readable with --json, and its figures match the measured requests", async (t) => {
  const server = await fakeServer(t);
  const r = await run(t, server, ["--agents", "4", "--json"]);
  assert.equal(r.code, 0, r.output);
  const report = JSON.parse(r.output);
  assert.equal(report.agents, 4);
  assert.equal(report.project, "demo");
  assert.equal(report.phases.claimSpread.ok, 4);
  assert.equal(report.phases.claimSpread.distinctForks, 4);
  assert.equal(report.phases.claimRace.winners, 1);
  assert.equal(report.phases.claimRace.refused, 3);
  assert.equal(report.phases.claimRace.namingHolder, 3);
  assert.equal(report.phases.cleanup.ok, 5);
  assert.equal(report.cost.modelCalls, 0);
  assert.ok(report.cost.wallSeconds >= 0);
  assert.ok(typeof report.phases.claimSpread.median === "number");
  assert.ok(typeof report.phases.claimSpread.p90 === "number");
  // The request totals count the N+1 task creations too, not just claims.
  assert.equal(report.created, 5);
  assert.equal(report.phases.claimSpread.created, 4);
  assert.equal(report.phases.claimRace.created, 1);
  assert.equal(report.requests, 19);
  assert.deepEqual(report.outcomes, { firstTry: 19, onRetry: 0, failed: 0, retries: 0, retryLimit: 6 });
});

test("a retryable 503 is retried with backoff, and the report counts first-try, retried and failed apart", async (t) => {
  const failedOnce = new Set();
  const server = await fakeServer(t, {
    fault: ({ verb, actor }) => {
      // Every spread claim by agents 0 and 1 gets one Retry-After 503; agent 2's claim always gets 503 unavailable.
      if (verb !== "claim") return null;
      if (actor === "sim/agent-2") return { when: "before" };
      if ((actor === "sim/agent-0" || actor === "sim/agent-1") && !failedOnce.has(actor)) { failedOnce.add(actor); return { when: "before", headers: { "retry-after": "0" }, body: { error: "weird", detail: "x" } }; }
      return null;
    },
  });
  const r = await run(t, server, ["--agents", "3", "--json", "--retries", "2", "--backoff-ms", "1"]);
  const report = JSON.parse(r.output);
  assert.equal(r.code, 1, "a final failure fails the run");
  assert.ok(report.outcomes.onRetry >= 2, JSON.stringify(report.outcomes));
  assert.ok(report.outcomes.failed >= 1, JSON.stringify(report.outcomes));
  assert.equal(report.outcomes.retryLimit, 2);
  // agent 2 was asked 1 + 2 retries times for its spread claim
  assert.ok(server.requests().filter((q) => q.actor === "sim/agent-2" && q.path.endsWith("/claim")).length >= 3);
  assert.equal(report.outcomes.firstTry + report.outcomes.onRetry + report.outcomes.failed, report.requests - report.outcomes.retries);
});

test("a 503 that is not retryable (no Retry-After, other code) is a final failure at once", async (t) => {
  const server = await fakeServer(t, { fault: ({ verb }) => (verb === "claim" ? { when: "before", body: { error: "internal", detail: "boom" } } : null) });
  const r = await run(t, server, ["--agents", "1", "--json", "--backoff-ms", "1"]);
  const report = JSON.parse(r.output);
  assert.equal(report.outcomes.retries, 0);
  assert.ok(report.outcomes.failed >= 1);
});

test("the race is judged from the server's holder when the winner's reply is lost as a 503", async (t) => {
  // Every claim is handled but the winning agent's reply is always lost.
  const server = await fakeServer(t, { fault: ({ verb, item, actor }) => (verb === "claim" && item.title === "concurrency proof race" && (!item.owner || item.owner === actor) ? { when: "after" } : null) });
  const r = await run(t, server, ["--agents", "6", "--json", "--retries", "1", "--backoff-ms", "1"]);
  const report = JSON.parse(r.output);
  const race = server.items().find((i) => i.title === "concurrency proof race");
  assert.equal(report.phases.claimRace.winners, 0, "no winning reply arrived");
  assert.equal(report.phases.claimRace.holder, race.firstOwner);
  assert.equal(report.phases.claimRace.winner, race.firstOwner);
  assert.equal(report.phases.claimRace.winnerReplied, false);
  assert.equal(report.phases.claimRace.refused, 5);
  assert.equal(report.phases.claimRace.namingHolder, 5);
});

test("cleanup retries until every task is abandoned, and names any it could not abandon", async (t) => {
  let abandonCalls = 0;
  const stuck = new Set();
  const server = await fakeServer(t, {
    fault: ({ verb, item }) => {
      if (verb !== "abandon") return null;
      abandonCalls += 1;
      if (item.title === "concurrency proof task 0") { stuck.add(item.id); return { when: "before" }; }
      // task 1 fails 503 on its first two abandons only
      if (item.title === "concurrency proof task 1" && abandonCalls <= 2) return { when: "before", body: { error: "internal", detail: "x" } };
      return null;
    },
  });
  const r = await run(t, server, ["--agents", "3", "--retries", "2", "--backoff-ms", "1"]);
  assert.equal(r.code, 1);
  const states = Object.fromEntries(server.items().map((i) => [i.title, i.state]));
  assert.equal(states["concurrency proof task 1"], "abandoned", "retried until it went through");
  assert.equal(states["concurrency proof task 2"], "abandoned");
  assert.equal(states["concurrency proof task 0"], "claimed");
  const id0 = server.items().find((i) => i.title === "concurrency proof task 0").id;
  assert.match(r.output, new RegExp(`NOT ABANDONED: ${id0}\\b`));
});

test("--agents above the limit, a missing project, or an insecure server is refused before any request", async (t) => {
  const server = await fakeServer(t);
  const cases = [
    [["--agents", "1001"], /--agents must be an integer from 1 to 1000/],
    [["--agents", "0"], /--agents must be an integer from 1 to 1000/],
    [["--server", "http://example.com", "--token", "x"], /is not https: the owner token goes with every request/],
  ];
  for (const [argv, message] of cases) {
    const r = await run(t, server, argv);
    assert.notEqual(r.code, 0, argv.join(" "));
    assert.match(r.output, message, argv.join(" "));
  }
  const noProject = spawn(process.execPath, [script, "--server", server.url, "--token", "x", "--agents", "1"], { env: { ...process.env } });
  let out = "";
  noProject.stderr.on("data", (s) => (out += s));
  noProject.stdout.on("data", (s) => (out += s));
  const code = await new Promise((ok) => noProject.on("close", ok));
  assert.notEqual(code, 0);
  assert.match(out, /--project NAME is required/);
  assert.equal(server.requests().length, 0, "no request reached the server");
});
