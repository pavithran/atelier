import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkoutLine, formatStanding } from "../cli/atelier.mjs";
import { agentRoute } from "../src/tokens.ts";

const cli = resolve("cli/atelier.mjs");
const standing = (over = {}) => ({
  project: { name: "demo", title: "Demo project", repo: "demo" },
  generatedAt: "2026-10-05T10:46:12.000Z",
  live: [{ id: "t1", title: "Held task", state: "claimed", owner: "claude-code/opus-5.5", since: "2026-10-05T09:00:00.000Z" }],
  waiting: [{ id: "t2", title: "Ready one", call: "accept", sentence: "Accept the revision, whose required checks all passed at its head.", href: "/p/demo/t2", command: "atelier land t2 --reviewer H/M --project demo", why: "all checks observed passing at this head", brief: { verdict: "accept", line: "1 of 1 required checks passed at this revision and nothing blocks it." } }],
  queued: [{ id: "t3", title: "Queued one", to: "home", agent: "codex", model: "gpt-6", by: "pavi", at: "2026-10-05T08:00:00.000Z", note: "Keep it small" }],
  merged: [{ id: "t0", title: "Earlier", at: "2026-10-04T11:00:00.000Z", commit: "abcdef0123456789", line: "Fixed the thing" }],
  handoffs: [{ id: "t1", title: "Held task", from: "codex/gpt-6", to: "claude-code/opus-5.5", note: "Tests are in test/x", at: "2026-10-05T09:00:00.000Z" }],
  controlPlane: null,
  ...over,
});

test("the text is one line per item under plain headings, and says what each part is", () => {
  const out = formatStanding(standing(), "PAVI", "https://a.test").split("\n");
  assert.equal(out[0], "Demo project (demo) as of 2026-10-05 10:46 UTC, from Atelier's record");
  assert.ok(out.includes("  t1  claimed  held by claude-code/opus-5.5 since 2026-10-05 09:00 UTC  Held task"));
  assert.ok(out.includes("Waiting on PAVI:"));
  assert.ok(out.includes("  t2  accept  Ready one  Accept the revision, whose required checks all passed at its head.  https://a.test/p/demo/t2  why: all checks observed passing at this head  brief, accept: 1 of 1 required checks passed at this revision and nothing blocks it.  next: atelier land t2 --reviewer H/M --project demo"));
  assert.ok(out.includes("  t3  for home codex/gpt-6  Queued one  note: Keep it small"));
  assert.ok(out.includes("  t0  2026-10-04 11:00 UTC  abcdef01  Earlier  summary: Fixed the thing"));
  assert.ok(out.includes("  t1  codex/gpt-6 to claude-code/opus-5.5, 2026-10-05 09:00 UTC  Tests are in test/x"));
  assert.equal(out.filter((l) => /^\s+t\d/.test(l)).length, 5);
});

// t629: a merge by override on the developer's direction shows their words and the model that relayed them.
test("a merge by override on the developer's direction says whose words and which model", () => {
  const out = formatStanding(standing({ overrides: [
    { id: "t4", title: "Overridden", at: "2026-10-13T12:00:00.000Z", reason: "No other family", quote: "override it", acting: "claude-code/opus-5.5" },
    { id: "t5", title: "Paged", at: "2026-10-13T12:00:00.000Z", reason: "No other family" },
  ] }), "PAVI", "https://a.test").split("\n");
  assert.ok(out.includes("  t4  https://a.test/p/demo/t4  2026-10-13 12:00 UTC  Overridden  reason: No other family  the developer's words: “override it”, relayed by claude-code/opus-5.5"), out.join("\n"));
  assert.ok(out.includes("  t5  https://a.test/p/demo/t5  2026-10-13 12:00 UTC  Paged  reason: No other family"), out.join("\n"));
  // Fast mode switched on the developer's direction is the line under the heading.
  const fast = formatStanding(standing({ mode: "Mode: fast since 2026-10-13 14:05 UTC (forks fail); the developer's words: \u201cgo fast\u201d, relayed by claude-code/opus-5.5" }), "PAVI").split("\n");
  assert.equal(fast[1], "Mode: fast since 2026-10-13 14:05 UTC (forks fail); the developer's words: \u201cgo fast\u201d, relayed by claude-code/opus-5.5");
  assert.notEqual(formatStanding(standing(), "PAVI").split("\n")[1], fast[1]);
});

test("a waiting line says what to do and links it; the pipeline and overlapping scopes are counted, not listed", () => {
  const out = formatStanding(standing({
    waiting: [{ id: "t4", title: "Blocked", call: "unblock", sentence: "Settle what blocks it, then unblock it so it goes on.", href: "/p/demo/t4", command: "atelier unblock t4 --project demo", why: "blocked by a/b: keys", brief: null }],
    pipeline: [{ stage: "submitted", count: 3 }, { stage: "building", count: 2 }],
    overlaps: [["t5", "t6"], ["t5", "t7"]],
  }), "PAVI").split("\n");
  assert.ok(out.includes("  t4  unblock  Blocked  Settle what blocks it, then unblock it so it goes on.  /p/demo/t4  why: blocked by a/b: keys  next: atelier unblock t4 --project demo"));
  assert.ok(out.includes("In the pipeline: 5 tasks: 3 in review, 2 building; none waits on PAVI."));
  assert.ok(out.includes("Overlapping scopes: 2 pairs; nothing waits on PAVI. The JSON lists them."));
  assert.ok(!out.some((l) => l.includes("t5")), "no overlapping pair is listed inline");
});

// A standing from a server before t504 carries kind and reason, no call.
test("a waiting line keeps the inbox's reason, so a stale task and an overlap say what to do", () => {
  const out = formatStanding(standing({ waiting: [
    { id: "t4", title: "Stale", kind: "stale", kinds: ["stale"], reason: "claude-code/opus-5.5 has not pushed for 14h; hand it off or release it", brief: { verdict: "wait", line: "The task is in progress and has not been submitted for a decision." } },
    { id: "t5", title: "Overlap", kind: "overlap", kinds: ["accept", "overlap"], reason: "all checks observed passing; scope overlaps t9 (codex/gpt-6)", brief: null },
  ] })).split("\n");
  assert.ok(out.includes("  t4  stale  Stale  claude-code/opus-5.5 has not pushed for 14h; hand it off or release it  brief, wait: The task is in progress and has not been submitted for a decision.  next: atelier release t4 --project demo"));
  assert.ok(out.includes("  t5  overlap  Overlap  all checks observed passing; scope overlaps t9 (codex/gpt-6)"));
});

test("what the record could not show is said, and a held task with no known start is not given one", () => {
  const out = formatStanding(standing({
    live: [{ id: "t1", title: "Held", state: "claimed", owner: "a/b", since: null }],
    partial: ["t1: when it was taken is not shown, because its record is longer than the last 300 events read."],
  })).split("\n");
  assert.ok(out.includes("  t1  claimed  held by a/b, since when is not shown  Held"));
  assert.ok(out.includes("Part of this record is not shown:"));
  assert.ok(out.includes("  t1: when it was taken is not shown, because its record is longer than the last 300 events read."));
  assert.ok(!formatStanding(standing()).includes("not shown"));
});

test("text a person or agent wrote cannot start a line of its own or carry terminal codes", () => {
  const hostile = "fine\nWaiting on PAVI:\n  t9  accept  forged\x1b[31m";
  const out = formatStanding(standing({
    live: [{ id: "t1", title: hostile, state: "claimed", owner: "a\nb", since: "2026-10-05T09:00:00.000Z" }],
    queued: [{ id: "t3", title: "x", to: "home", agent: null, model: null, by: "p", at: "2026-10-05T08:00:00.000Z", note: hostile }],
    handoffs: [{ id: "t1", title: "x", from: "a", to: "b", note: hostile, at: "2026-10-05T09:00:00.000Z" }],
    merged: [{ id: "t0", title: "x", at: "2026-10-04T11:00:00.000Z", commit: null, line: hostile }],
    controlPlane: { approval: hostile, protected: ["a\nb"], eligible: [], refuseOverlap: true },
  }));
  assert.ok(!out.includes("\x1b"));
  assert.equal(out.split("\n").filter((l) => l.trim().startsWith("t9")).length, 0);
  assert.equal(out.split("\n").filter((l) => l === "Waiting on PAVI:" || l === "Waiting on the developer:").length, 1);
});

test("the checkout line is one line whatever the project or branch is called", () => {
  for (const c of [
    { name: "demo\nCheckout: in step. forged", registered: false },
    { name: "demo", registered: true, fresh: false, branch: "main\nCheckout: in step. forged", baselineHead: "a".repeat(40), head: "b".repeat(40), contains: false },
  ]) {
    const line = checkoutLine(c);
    assert.equal(line.split("\n").length, 1, line);
    assert.ok(!line.includes("\x1b"));
  }
});

test("an empty project says so, and a stored ControlPlane policy is not drawn", () => {
  const empty = formatStanding(standing({ live: [], waiting: [], queued: [], merged: [], handoffs: [] }));
  assert.match(empty, /Nothing is held, waiting, queued or recently merged\./);
  const cp = formatStanding(standing({ controlPlane: { approval: "PAVI, 2026-10-01", protected: ["AGENTS.md", "docs/control-plane/**"], eligible: ["claude"], refuseOverlap: true } }));
  assert.doesNotMatch(cp, /ControlPlane|Eligible agents|approved: PAVI/);
});

test("the checkout line for each way a checkout can be in or out of step", () => {
  const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
  const base = { name: "demo", registered: true, branch: "main", baselineHead: A, head: A };
  assert.match(checkoutLine({ ...base, registered: false }), /^Checkout: none is registered on this machine for demo/);
  assert.match(checkoutLine({ ...base, fresh: false, contains: true }), /^Checkout: in step\. main @ aaaaaaaa holds the baseline's head aaaaaaaa\.$/);
  assert.match(checkoutLine({ ...base, fresh: false, contains: false, head: B }), /^Checkout: out of step\. main @ bbbbbbbb does not hold the baseline's head aaaaaaaa/);
  assert.match(checkoutLine({ ...base, fresh: true, paired: B, head: B }), /^Checkout: in step\. main @ bbbbbbbb is the commit the baseline's head aaaaaaaa matches\.(?:\n|$)/);
  assert.match(checkoutLine({ ...base, fresh: true, paired: B, head: C, ahead: true }), /out of step\. main has commits the baseline lacks; run atelier sync --project demo/);
  assert.match(checkoutLine({ ...base, fresh: true, paired: B, head: C, ahead: false }), /out of step\. main @ cccccccc is not the commit .* \(bbbbbbbb\)/);
  assert.match(checkoutLine({ ...base, fresh: true, paired: null }), /out of step\. The baseline's head aaaaaaaa has no pair in this checkout/);
});

// `atelier status --project NAME` against a stand-in server and a local bare
// repository as the baseline, so the checkout comparison is real git.
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x.test" } }).trim();

async function run(t, setup, argv, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-standing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bare = join(dir, "baseline.git"), checkout = join(dir, "checkout");
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  writeFileSync(join(checkout, "a.txt"), "one\n");
  writeFileSync(join(checkout, "AGENTS.md"), "Land with `atelier land ID --reviewer H/M`.\n");
  git(checkout, "add", "."); git(checkout, "commit", "-q", "-m", "one");
  git(dir, "clone", "-q", "--bare", checkout, bare);
  const state = setup({ checkout, bare, dir }) ?? {};
  const seen = [];
  // The standing and the baseline's head, as the Worker reads it from
  // Artifacts. Any other route is refused: status reads, and mints nothing.
  // An agent token (atl_...) is held to the Worker's own allowlist, so a
  // route the CLI reads for an agent must be one agentRoute admits.
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const parts = req.url.replace(/^\/api\//, "").split("?")[0].split("/").map(decodeURIComponent);
    const agent = (req.headers.authorization ?? "").startsWith("Bearer atl_");
    let status = 200, body;
    if (agent && !agentRoute(req.method, parts)) { status = 403; body = { error: "owner_token_required", detail: `${req.method} ${req.url} needs the owner token` }; }
    else if (req.url === "/api/config") body = { actor: "codex/gpt-6-astra", ownerActor: "owner" };
    else if (req.url.endsWith("/standing")) body = state.standing ?? standing();
    else if (req.url === "/api/projects/demo") body = { project: { policy: state.policy ?? { checks: [], protected: [] } } };
    else if (req.url.endsWith("/baseline-head")) body = { head: git(dir, "--git-dir", bare, "rev-parse", "refs/heads/main") };
    else { status = 404; body = { error: "unexpected", detail: `${req.method} ${req.url}` }; }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "x", owner: "owner", projects: { demo: { path: checkout, branch: "main", ...state.project } } }));
  const child = spawn(process.execPath, [cli, ...(argv ?? ["status", "--project", "demo"])], {
    cwd: dir, env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "test-token", ATELIER_ACTOR: "owner", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}`, ...state.env, ...env },
  });
  let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
  const status = await new Promise((done) => child.on("close", done));
  return { status, output, seen };
}

test("status --project --json prints the standing record and the checkout line for a machine reader", async (t) => {
  const r = await run(t, () => null, ["status", "--project", "demo", "--json"]);
  assert.equal(r.status, 0, r.output);
  const read = JSON.parse(r.output);
  assert.equal(read.project.project.name, "demo");
  assert.equal(read.project.generatedAt, "2026-10-05T10:46:12.000Z");
  assert.deepEqual(read.project.live.map((i) => [i.id, i.since]), [["t1", "2026-10-05T09:00:00.000Z"]]);
  assert.match(read.checkout, /^Checkout: /);
  assert.equal(read.checkout.split("\n").length, 1);
});

for (const json of [false, true]) test(`status --project reports instruction disagreements${json ? " in JSON" : " in text"} for an agent`, async (t) => {
  const r = await run(t, ({ checkout }) => {
    writeFileSync(join(checkout, "AGENTS.md"), "# Rules\nReview is optional for non-authority changes.\n");
    // The stored execution policy, which allows coordinated changes, adds no requirement (t152); the protected path does.
    return { policy: { checks: [], protected: ["AGENTS.md"], execution: {
      allowed_classes: ["coordinated"], direct: { enabled: false, allowed_path_patterns: [] }, protected_path_patterns: [],
    } } };
  }, ["status", "--project", "demo", ...(json ? ["--json"] : [])], { ATELIER_TOKEN: "atl_agent-token", ATELIER_ACTOR: "codex/gpt-6-astra" });
  assert.equal(r.status, 0, r.output);
  const text = json ? JSON.parse(r.output).mismatches.join("\n") : r.output;
  assert.match(text, /AGENTS\.md:2 calls review optional/);
  assert.match(text, /a protected change \(AGENTS\.md[^)]*\) needs a review from another model family/);
  assert.doesNotMatch(text, /coordinated change needs a review/);
  assert.ok(r.seen.includes("GET /api/projects/demo"));
  assert.ok(r.seen.every((request) => request.startsWith("GET ")));
});

for (const failed of ["tasks", "notices"]) {
  const partial = [`The project's ${failed} could not be read, so what waits on you there is unknown.`];
  const setup = () => ({ standing: standing({ live: [], waiting: [], queued: [], merged: [], handoffs: [], partial }) });
  for (const json of [false, true]) {
    test(`status --brief${json ? " --json" : ""} preserves a failed ${failed} read`, async (t) => {
      const r = await run(t, setup, ["status", "--project", "demo", "--brief", ...(json ? ["--json"] : [])]);
      assert.equal(r.status, 0, r.output);
      const out = json ? JSON.parse(r.output).brief.join("\n") : r.output;
      assert.ok(out.includes(partial[0]), out);
      assert.match(out, /counts cover only what was read/);
      assert.match(out, /Waiting on the developer: nothing known; more may be waiting\./);
      assert.ok(!out.includes("Waiting on the developer: nothing."));
    });
    test(`status --project${json ? " --json" : ""} preserves a failed ${failed} read`, async (t) => {
      const r = await run(t, setup, ["status", "--project", "demo", ...(json ? ["--json"] : [])]);
      assert.equal(r.status, 0, r.output);
      if (json) assert.deepEqual(JSON.parse(r.output).project.partial, partial);
      else {
        assert.ok(r.output.includes(partial[0]), r.output);
        assert.match(r.output, /shown in the part read/);
        assert.ok(!r.output.includes("Nothing is held, waiting, queued or recently merged."));
      }
    });
  }
}

test("status --project prints where it stands and says the checkout is in step, reading only", async (t) => {
  const r = await run(t, () => null);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /^Demo project \(demo\) as of /);
  assert.match(r.output, /Test slots: \d+\/\d+ on [^\n]+/);
  assert.match(r.output, /Waiting on /);
  assert.match(r.output, /\nCheckout: in step\. main @ [0-9a-f]{8} holds the baseline's head [0-9a-f]{8}\.(?:\n|$)/);
  // The baseline's head is read from the server; no read token is minted.
  // The developer's branches (t641) are read last; the stand-in has none.
  // The developer's open stuck episodes (t198) are read after the branches, in the two reads the stuck report is made of.
  // The fast builds that ended ready (t210) are read before the usage warnings (t727).
  assert.deepEqual(r.seen, ["GET /api/projects/demo/standing", "GET /api/projects/demo/baseline-head", "GET /api/projects/demo", "GET /api/projects/demo/branches", "GET /api/projects/demo/stuck", "GET /api/projects/demo/stuck/episodes", "GET /api/projects/demo/mode", "GET /api/usage"]);
  assert.match(r.output, /\n  Developer branches: not read/);
});

test("status --project with an agent token reads the baseline's head through a route the allowlist admits", async (t) => {
  const r = await run(t, () => null, undefined, { ATELIER_TOKEN: "atl_agent-token", ATELIER_ACTOR: "codex/gpt-6-astra" });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /\nCheckout: in step\. main @ [0-9a-f]{8} holds the baseline's head [0-9a-f]{8}\.(?:\n|$)/);
  // An agent is not asked for the developer's branches, which are the developer's alone (t641).
  // The usage warnings (t727) are still read; a refusal leaves the text as it was.
  assert.deepEqual(r.seen, ["GET /api/config", "GET /api/projects/demo/standing", "GET /api/projects/demo/baseline-head", "GET /api/projects/demo", "GET /api/projects/demo/mode", "GET /api/usage"]);
  assert.doesNotMatch(r.output, /Developer branches/);
});

test("status --project says the checkout is out of step when the baseline has moved on", async (t) => {
  const r = await run(t, ({ bare, dir }) => {
    const other = join(dir, "other");
    git(dir, "clone", "-q", bare, other);
    writeFileSync(join(other, "b.txt"), "two\n");
    git(other, "add", "."); git(other, "commit", "-q", "-m", "two");
    git(other, "push", "-q", "origin", "main");
  });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /\nCheckout: out of step\. main @ [0-9a-f]{8} does not hold the baseline's head [0-9a-f]{8}; reconcile/);
});

test("the registered branch is compared, not whatever is checked out", async (t) => {
  // The baseline moves on; the checkout has it on a feature branch, but main is behind.
  const r = await run(t, ({ checkout, bare, dir }) => {
    const other = join(dir, "other");
    git(dir, "clone", "-q", bare, other);
    writeFileSync(join(other, "b.txt"), "two\n");
    git(other, "add", "."); git(other, "commit", "-q", "-m", "two");
    git(other, "push", "-q", "origin", "main");
    git(checkout, "fetch", "-q", bare, "main");
    git(checkout, "checkout", "-q", "-b", "feature", "FETCH_HEAD");
  });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /\nCheckout: out of step\. main @ [0-9a-f]{8} does not hold the baseline's head/);
});

// As cli/fresh.mjs builds a baseline: the same tree under a different commit
// (here a later committer date), so the baseline's head is not the checkout's.
function rebuilt(bare, dir, name) {
  const work = join(dir, `rebuild-${name}`);
  git(dir, "clone", "-q", bare, work);
  execFileSync("git", ["commit", "-q", "--amend", "--no-edit", "--date", "2020-01-01T00:00:00Z"], {
    cwd: work, env: { ...process.env, GIT_COMMITTER_DATE: "2020-01-02T00:00:00Z", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x.test" },
  });
  git(work, "push", "-q", "--force", "origin", "main");
  return git(work, "rev-parse", "HEAD");
}

test("a project set up with --history-since is compared through its pairs", async (t) => {
  const seenHashes = {};
  const inStep = await run(t, ({ checkout, bare, dir }) => {
    const head = git(checkout, "rev-parse", "HEAD");
    const baselineHead = rebuilt(bare, dir, "a");
    assert.notEqual(baselineHead, head, "the baseline's commit differs from the checkout's");
    assert.equal(git(checkout, "rev-parse", "HEAD^{tree}"), git(bare, "rev-parse", "main^{tree}"), "but names the same tree");
    writeFileSync(join(checkout, ".git", "atelier-baseline-map.json"), JSON.stringify({ demo: { [baselineHead]: head } }));
    Object.assign(seenHashes, { head, baselineHead });
    return { project: { fresh: true } };
  });
  assert.match(inStep.output, /\nCheckout: in step\. main @ [0-9a-f]{8} is the commit the baseline's head [0-9a-f]{8} matches\.(?:\n|$)/);
  assert.ok(inStep.output.includes(`main @ ${seenHashes.head.slice(0, 8)} is the commit the baseline's head ${seenHashes.baselineHead.slice(0, 8)} matches`));
  // The checkout has moved past the commit the baseline's head is paired with.
  const behind = await run(t, ({ checkout, bare, dir }) => {
    const paired = git(checkout, "rev-parse", "HEAD");
    const baselineHead = rebuilt(bare, dir, "b");
    writeFileSync(join(checkout, ".git", "atelier-baseline-map.json"), JSON.stringify({ demo: { [baselineHead]: paired } }));
    writeFileSync(join(checkout, "c.txt"), "three\n");
    git(checkout, "add", "."); git(checkout, "commit", "-q", "-m", "three");
    return { project: { fresh: true } };
  });
  assert.match(behind.output, /\nCheckout: out of step\. main has commits the baseline lacks; run atelier sync --project demo\.(?:\n|$)/);
  // The checkout is the baseline's own commit, which is not a project commit: the pair names another.
  const wrong = await run(t, ({ checkout, bare, dir }) => {
    const baselineHead = rebuilt(bare, dir, "c");
    git(checkout, "fetch", "-q", bare, "main");
    git(checkout, "reset", "-q", "--hard", baselineHead);
    writeFileSync(join(checkout, ".git", "atelier-baseline-map.json"), JSON.stringify({ demo: { [baselineHead]: "f".repeat(40) } }));
    return { project: { fresh: true } };
  });
  assert.match(wrong.output, /Checkout: out of step\. main @ [0-9a-f]{8} is not the commit the baseline's head [0-9a-f]{8} matches \(ffffffff\)/);
  const unpaired = await run(t, () => ({ project: { fresh: true } }));
  assert.match(unpaired.output, /Checkout: out of step\. The baseline's head [0-9a-f]{8} has no pair in this checkout/);
});

test("a project with no checkout on this machine is still reported", async (t) => {
  const r = await run(t, ({ dir }) => ({ project: { path: join(dir, "missing") } }));
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /\nCheckout: none is registered on this machine for demo/);
});

test("each check is one line with its class and the paths it applies to, flattened", () => {
  const out = formatStanding(standing({ checks: [
    { command: "npm ci && npm test", class: "read-only", text: "read-only, a known build or test command", paths: null },
    { command: "xcodebuild build", class: "read-only", text: "read-only, from ControlPlane: capability app-build is local-read-only", paths: ["App/**", "project.yml"] },
    { command: "./check.sh\nforged", class: "undeclared", text: "undeclared: still run", paths: null },
  ] })).split("\n");
  const at = out.indexOf("Checks:");
  assert.ok(at > 0);
  assert.deepEqual(out.slice(at + 1), [
    "  npm ci && npm test  read-only, a known build or test command",
    "  xcodebuild build  read-only, from ControlPlane: capability app-build is local-read-only; applies only when the change touches App/**, project.yml",
    "  ./check.sh forged  undeclared: still run",
  ]);
});


test("status includes local runners and task processes in text and project JSON without arguments", async (t) => {
  const setup = ({ dir }) => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const ps = "100 1 01:00 /usr/bin/node /x/cli/atelier.mjs runner --name home:test --config PRIVATE\n101 100 00:30 codex exec SECRET PROMPT\n";
    const lsof = `p101\nccodex\nn${dir}/cache/work/demo/t7\n`;
    for (const [name, output] of [["ps", ps], ["lsof", lsof]]) {
      const expected = name === "ps" ? ["-axo", "pid=,ppid=,etime=,args="] : ["-a", "-d", "cwd", "-Fpcn"];
      const real = name === "ps" ? "/bin/ps" : "/usr/sbin/lsof";
      writeFileSync(join(bin, name), `#!${process.execPath}
const args = process.argv.slice(2);
if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(expected))}) process.stdout.write(${JSON.stringify(output)});
else process.exit(require("node:child_process").spawnSync(${JSON.stringify(real)}, args, { stdio: "inherit" }).status ?? 1);
`, { mode: 0o755 });
    }
    return { env: { PATH: `${bin}:${process.env.PATH}` } };
  };
  const text = await run(t, setup);
  assert.equal(text.status, 0, text.output);
  assert.match(text.output, /runner home:test  pid 100  up 1m  working on t7/);
  assert.match(text.output, /demo\/t7  codex pid 101 up 30s/);
  const json = await run(t, setup, ["status", "--project", "demo", "--json"]);
  assert.equal(json.status, 0, json.output);
  const processes = JSON.parse(json.output).processes;
  assert.deepEqual(processes.runners, [{ pid: 100, ppid: 1, name: "home:test", age: "1m", tasks: ["t7"] }]);
  assert.deepEqual(processes.agents, [{ pid: 101, command: "codex", age: "30s", project: "demo", id: "t7" }]);
  for (const output of [text.output, json.output]) assert.doesNotMatch(output, /PRIVATE|SECRET|--config|codex exec/);
});

// t60: accepted work behind main is flagged with both revisions and the command that shows whether they collide.
test("accepted work that does not contain the recorded main is flagged, unknown ancestry says so, and current work is not listed", () => {
  const A = "a".repeat(40), M = "b".repeat(40);
  const out = formatStanding(standing({ accepted: [
    { id: "t7", title: "Behind", acceptedHead: A, main: M, state: "behind" },
    { id: "t8", title: "Unread", acceptedHead: A, main: M, state: "unknown" },
    { id: "t9", title: "No main", acceptedHead: A, main: null, state: "unknown" },
    { id: "t10", title: "Current", acceptedHead: A, main: M, state: "current" },
  ] }), "PAVI").split("\n");
  assert.ok(out.includes("Accepted, not merged, and not known to hold main:"), out.join("\n"));
  assert.ok(out.includes("  t7  behind main  accepted at aaaaaaaa, which does not contain main as last recorded (bbbbbbbb); behind is not a conflict; next: atelier check t7 --merged --project demo"), out.join("\n"));
  assert.ok(out.includes("  t8  unknown  accepted at aaaaaaaa; its history could not be read against main as last recorded (bbbbbbbb); next: atelier check t8 --merged --project demo"));
  assert.ok(out.includes("  t9  unknown  accepted at aaaaaaaa; the server has recorded no main head to compare with; next: atelier check t9 --merged --project demo"));
  assert.ok(!out.some((l) => l.includes("t10")), "current work is not flagged");
  assert.ok(!formatStanding(standing(), "PAVI").includes("not known to hold main"), "a standing with no accepted work reads as before");
  assert.ok(!formatStanding(standing({ accepted: [{ id: "t10", title: "Current", acceptedHead: A, main: M, state: "current" }] }), "PAVI").includes("not known to hold main"));
});
