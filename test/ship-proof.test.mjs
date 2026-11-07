import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeShip, runRequest, ship } from "../cli/ship.mjs";

// t519: the two proofs the audit found false. A dry run that prints a
// refusal exits non-zero, and verify-delivery passes only when the version
// answer names the shipped commit.

const head = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";

// ── ship --dry-run ──────────────────────────────────────────────────────────

function shipDir(t, doc) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-ship-dry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs/atelier"), { recursive: true });
  if (doc) writeFileSync(join(dir, "docs/atelier/ship.json"), JSON.stringify(doc));
  return dir;
}

// A dry run of ship in `dir`, with the git answers a clean checkout gives
// unless `git` overrides them. `ended` holds what fail() was given.
async function dry(dir, { git, baselineHead = head, paired = () => head, push = false, inProgress = () => [] } = {}) {
  const lines = [], ended = [];
  const stand = (args) => args[0] === "branch" ? "main" : args[0] === "rev-parse" ? head : "";
  await ship({
    name: "p", cwd: dir, branch: "main", git: git ?? stand, request: async () => ({ approvals: [] }),
    print: (l) => lines.push(l), fail: (m) => { ended.push(m); throw new Error(m); },
    inProgress, baselineHead, paired, dryRun: true, push,
  }).catch((error) => { if (!ended.includes(error.message)) throw error; });
  return { out: lines.join("\n"), ended };
}

const OTHER = { schema_version: 1, kind: "atelier.ship", class: "other" };

test("a dry run that prints a refusal ends through fail(), whatever the refusal", async (t) => {
  const cases = {
    "no ship file": [shipDir(t, null), {}, /Refused: this project has no ship file/],
    "a ship file problem": [shipDir(t, { ...OTHER, class: "bogus" }), {}, /Refused: .*needs "class"/],
    "another branch": [shipDir(t, OTHER), { git: (a) => a[0] === "branch" ? "side" : a[0] === "rev-parse" ? head : "" }, /Refused: side is checked out/],
    "an operation in progress": [shipDir(t, OTHER), { inProgress: () => ["a merge"] }, /Refused: a merge is in progress/],
    "uncommitted changes": [shipDir(t, OTHER), { git: (a) => a[0] === "branch" ? "main" : a[0] === "status" ? " M x" : head }, /Refused: the checkout has uncommitted changes/],
    "a head the baseline does not hold": [shipDir(t, OTHER), { paired: () => "f".repeat(40) }, /Refused: HEAD abcdefab is not the baseline's head/],
    "--push with no push step": [shipDir(t, { ...OTHER, push: false }), { push: true }, /Refused: --push was given/],
  };
  for (const [why, [dir, options, shown]] of Object.entries(cases)) {
    const r = await dry(dir, options);
    assert.match(r.out, shown, why);
    assert.equal(r.ended.length, 1, `${why}: fail() ends the command`);
    assert.match(r.ended[0], /dry run found \d+ refusals?/, why);
    assert.ok(r.out.indexOf("Refused:") >= 0 && r.out.includes("Dry run: nothing was run"), `${why}: the plan and the refusal are still printed first`);
  }
});

test("a dry run with no refusal returns normally, and a missing approval alone is no refusal", async (t) => {
  const clean = await dry(shipDir(t, OTHER));
  assert.deepEqual(clean.ended, []);
  assert.doesNotMatch(clean.out, /Refused/);
  assert.match(clean.out, /Dry run: nothing was run, approved or recorded\./);
  // The command that approves what is missing is the dry run's answer, not a refusal.
  const web = await dry(shipDir(t, { schema_version: 1, kind: "atelier.ship", class: "web", deploy: { run: ["./d"] }, "verify-deploy": { run: ["./v"] } }));
  assert.deepEqual(web.ended, []);
  assert.match(web.out, /Missing approvals;/);
});

// ── verify-delivery ─────────────────────────────────────────────────────────

// A version route that serves what `served` says, and a sign-in page behind a redirect.
async function version(t, served) {
  const server = createServer((req, res) => {
    if (req.url === "/old") { res.writeHead(302, { location: "/signin" }); return res.end(); }
    if (req.url === "/signin") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>sign in</html>"); }
    if (req.url === "/signed-in-version") { res.writeHead(302, { location: "/version" }); return res.end(); }
    res.writeHead(served.status ?? 200, { "content-type": served.type ?? "application/json", ...(served.headers ?? {}) });
    res.end(served.body === undefined ? JSON.stringify({ commit: served.commit }) : served.body);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const request = (t, url, more = {}) => {
  const dir = shipDir(t, { schema_version: 1, kind: "atelier.ship", class: "web", deploy: { run: ["./d"] }, "verify-deploy": { request: url, status: 200, ...more } });
  const plan = composeShip(dir);
  assert.deepEqual(plan.problems, []);
  return plan.steps.find((s) => s.step === "verify-delivery").runs[0];
};

test("a verify request with no expected text passes only on the version answer naming the shipped commit", async (t) => {
  const served = { commit: head };
  const base = await version(t, served);
  const run = request(t, `${base}/version`);
  const ok = await runRequest(run, head);
  assert.equal(ok.passed, true, ok.output);
  assert.match(ok.output, new RegExp(`names the shipped commit ${head}`));
  // Another commit: an old build still serving.
  served.commit = "0".repeat(40);
  const other = await runRequest(run, head);
  assert.equal(other.passed, false);
  assert.match(other.output, new RegExp(`names ${"0".repeat(40)}, not the shipped commit ${head}`));
  // No commit at all, or a commit that is not a full hash.
  for (const [what, body] of Object.entries({
    "an empty object": "{}", "a null commit": JSON.stringify({ commit: null }), "a number": JSON.stringify({ commit: 12345 }),
    "a short hash": JSON.stringify({ commit: head.slice(0, 8) }), "upper case": JSON.stringify({ commit: head.toUpperCase() }),
    "a hash with text round it": JSON.stringify({ commit: `v1 ${head}` }), "not hex": JSON.stringify({ commit: "g".repeat(40) }),
    "text, not JSON": `commit ${head}`, "an array": JSON.stringify([head]), "a nested commit": JSON.stringify({ build: { commit: head } }),
  })) {
    served.body = body;
    const r = await runRequest(run, head);
    assert.equal(r.passed, false, `${what} must not pass: ${r.output}`);
    assert.match(r.output, /does not name a commit|names a malformed commit|is not JSON/, what);
  }
  // The answer is not 200.
  served.body = undefined; served.commit = head; served.status = 503;
  assert.equal((await runRequest(run, head)).passed, false, "the right commit under a 503");
});

test("a redirect to a sign-in page fails verify-delivery, by default and when followed", async (t) => {
  const base = await version(t, { commit: head });
  // The default forbids redirects: the sign-in page is never asked.
  const run = request(t, `${base}/old`);
  const refused = await runRequest(run, head);
  assert.equal(refused.passed, false);
  assert.match(refused.output, /answered 302 pointing at .*\/signin; redirects are forbidden here/);
  // Followed on purpose, the sign-in page's 200 names no commit, so it fails too.
  const followed = await runRequest(request(t, `${base}/old`, { redirect: "follow" }), head);
  assert.equal(followed.passed, false);
  assert.match(followed.output, /does not name a commit|is not JSON/);
  // A redirect that lands on the real version route passes only when followed on purpose.
  assert.equal((await runRequest(request(t, `${base}/signed-in-version`), head)).passed, false);
  assert.equal((await runRequest(request(t, `${base}/signed-in-version`, { redirect: "follow" }), head)).passed, true);
  // A redirect checked by hand is no proof of a version: alone, it leaves the ship file refused.
  const dir = shipDir(t, { schema_version: 1, kind: "atelier.ship", class: "web", deploy: { run: ["./d"] }, "verify-deploy": { request: `${base}/old`, status: 302, redirect: "manual" } });
  assert.match(composeShip(dir).problems.join("\n"), /verifies the deploy with redirect checks alone, and none names the shipped commit/);
});

test("an expected text must itself name the commit, or the ship file is refused", (t) => {
  const problems = (verify) => composeShip(shipDir(t, { schema_version: 1, kind: "atelier.ship", class: "web", deploy: { run: ["./d"] }, "verify-deploy": verify })).problems.join("\n");
  assert.equal(problems({ request: "https://x.test/version", expect: "{commit}" }), "");
  assert.equal(problems({ request: "https://x.test/version", expect: "build {short}", header: "x-build" }), "");
  assert.match(problems({ request: "https://x.test/version", expect: "ok" }), /"expect" must hold \{commit\} or \{short\}/);
  assert.match(problems({ request: "https://x.test/version", expect: "ok", header: "x-build" }), /"expect" must hold \{commit\} or \{short\}/);
});

test("a request run with no commit to compare keeps the plain check the Access example uses", async (t) => {
  const base = await version(t, { commit: head });
  const plain = await runRequest({ request: `${base}/version`, status: 200, redirect: undefined, timeoutMs: 5000 });
  assert.equal(plain.passed, true, "no commit given, so only the status is checked");
});
