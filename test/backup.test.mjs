// Atelier 2.0, task 12 (design section 4.9, R2 on PAVI's decision): the
// nightly backup and its restore, end to end. A real server runs and takes
// writes while cli/backup.mjs, a separate process as the LaunchDaemon runs
// it, backs it up to a local S3-compatible stub that checks every request's
// SigV4 signature with a verifier of its own (itself checked against curl's
// --aws-sigv4). cli/restore.mjs then fetches, decrypts and restores into
// fresh directories, and a server on them answers with the same projects,
// items, events and Git refs. Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { startServer } from "../src/runtime/server.mjs";
import { ensureRepo } from "../src/git/repos.mjs";
import { decryptFile, encryptFile, generateKeys, privateKeyOf } from "../src/backup/envelope.mjs";
import { refsOf } from "../src/backup/snapshot.mjs";
import { S3Client } from "../src/backup/s3.mjs";
import { prune } from "../src/backup/backup.mjs";
import { objectKey } from "../src/backup/config.mjs";

const run = promisify(execFile);
const OWNER = "atl_00112233445566778899aabbccddeeff";
const OVERRIDE = "override-secret-4f1c9e";
const ACCESS_KEY_ID = "AKIDBACKUPTEST0123";
const SECRET_ACCESS_KEY = "r2-secret-9b7e1f0c2d4a6b8e";
const BUCKET = "atelier-backups";
const DAY = 86_400_000;
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function scratch() {
  const d = mkdtempSync(join(tmpdir(), "atelier-backup-"));
  dirs.push(d);
  return d;
}

// ---- The S3 stub and its own SigV4 verifier ---------------------------

const strict = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Recomputes the signature of a request from what arrived on the wire.
// Answers null when it holds, or why it does not.
function sigv4Problem(req, body) {
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/.exec(req.headers.authorization ?? "");
  if (!m) return "no SigV4 authorization header";
  const [, keyId, day, region, service, signedHeaders, signature] = m;
  if (keyId !== ACCESS_KEY_ID) return "unknown access key";
  if (service !== "s3") return "not signed for s3";
  const amzDate = req.headers["x-amz-date"];
  if (!/^\d{8}T\d{6}Z$/.test(amzDate ?? "") || !amzDate.startsWith(day)) return "bad x-amz-date";
  const at = Date.parse(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
  if (Math.abs(Date.now() - at) > 15 * 60_000) return "x-amz-date too far from now";
  const signed = signedHeaders.split(";");
  if (!signed.includes("host") || !signed.includes("x-amz-date")) return "host and x-amz-date must be signed";
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const claimed = req.headers["x-amz-content-sha256"];
  if (claimed !== undefined && claimed !== "UNSIGNED-PAYLOAD" && claimed !== bodyHash) return "x-amz-content-sha256 is not the body's";
  const [path, rawQuery = ""] = req.url.split("?");
  const query = rawQuery ? rawQuery.split("&").map((p) => p.split("=").map((s) => decodeURIComponent(s ?? ""))) : [];
  const canonicalQuery = query.map(([k, v = ""]) => [strict(k), strict(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalHeaders = signed.map((h) => `${h}:${String(req.headers[h] ?? "").trim().replace(/\s+/g, " ")}\n`).join("");
  const canonical = [req.method, path, canonicalQuery, canonicalHeaders, signedHeaders, claimed ?? bodyHash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  let k = createHmac("sha256", `AWS4${SECRET_ACCESS_KEY}`).update(day).digest();
  for (const part of [region, service, "aws4_request"]) k = createHmac("sha256", k).update(part).digest();
  const expected = createHmac("sha256", k).update(toSign).digest("hex");
  return expected === signature ? null : "SignatureDoesNotMatch";
}

async function s3stub() {
  const objects = new Map();
  const log = [];
  const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const problem = sigv4Problem(req, body);
      const [path, rawQuery = ""] = req.url.split("?");
      const parts = path.split("/").slice(1);
      const bucket = parts[0];
      const key = decodeURIComponent(parts.slice(1).join("/"));
      log.push({ method: req.method, key, problem, headers: req.headers });
      if (problem) { res.writeHead(403, { "content-type": "application/xml" }); return res.end(`<Error><Code>${problem === "SignatureDoesNotMatch" ? problem : "AccessDenied"}</Code></Error>`); }
      if (bucket !== BUCKET) { res.writeHead(404); return res.end("<Error><Code>NoSuchBucket</Code></Error>"); }
      if (req.method === "PUT" && key) {
        if (Number(req.headers["content-length"]) !== body.length) { res.writeHead(400); return res.end(); }
        objects.set(key, { body, lastModified: new Date() });
        res.writeHead(200, { etag: '"x"' });
        return res.end();
      }
      if (req.method === "GET" && key) {
        const o = objects.get(key);
        if (!o) { res.writeHead(404); return res.end("<Error><Code>NoSuchKey</Code></Error>"); }
        res.writeHead(200, { "content-length": o.body.length });
        return res.end(o.body);
      }
      if (req.method === "DELETE" && key) { objects.delete(key); res.writeHead(204); return res.end(); }
      if (req.method === "GET" && !key) {
        const q = new URLSearchParams(rawQuery);
        const prefix = q.get("prefix") ?? "";
        const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        // Two to a page, so the client must follow continuation tokens.
        const start = q.get("continuation-token") ? Number(q.get("continuation-token")) : 0;
        const page = all.slice(start, start + 2);
        const more = start + 2 < all.length;
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}${page.map((k) => `<Contents><Key>${xml(k)}</Key><LastModified>${objects.get(k).lastModified.toISOString()}</LastModified><Size>${objects.get(k).body.length}</Size></Contents>`).join("")}</ListBucketResult>`);
      }
      res.writeHead(400);
      res.end();
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { objects, log, endpoint: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => { server.close(ok); server.closeAllConnections(); }) };
}

function secretsDir(root, endpoint, publicKey, overrides = {}) {
  const dir = join(root, "backup-secrets");
  mkdirSync(dir, { mode: 0o700 });
  const values = { R2_ENDPOINT: endpoint, R2_BUCKET: BUCKET, R2_ACCESS_KEY_ID: ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY, BACKUP_PUBLIC_KEY: publicKey, ...overrides };
  for (const [k, v] of Object.entries(values)) writeFileSync(join(dir, k), v, { mode: 0o600 });
  return dir;
}

// ---- The server under test ---------------------------------------------

const artifacts = {
  create: async () => ({ name: "demo" }),
  get: async (repo) => ({
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    createToken: async (scope) => ({ id: "tok1", plaintext: "art_dummy", scope, expiresAt: new Date(Date.now() + 3600e3).toISOString() }),
    revokeToken: async () => true,
    [Symbol.dispose]() {},
  }),
};

function api(server, method, path, body) {
  return fetch(`${server.url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function allEvents(server, key) {
  const out = [];
  let before = null;
  for (;;) {
    const page = await (await api(server, "GET", `/projects/${key}/events${before === null ? "" : `?before=${before}`}`)).json();
    out.push(...page.events);
    if (page.next === null || page.next === undefined) return out;
    before = page.next;
  }
}

function gitIn(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test("a backup of a server under writes restores into fresh directories with the same projects, items, events and refs; retention keeps its own prefix's last 30 days; no secret is logged", async () => {
  const root = scratch();
  const serverSecrets = join(root, "secrets");
  mkdirSync(serverSecrets, { mode: 0o700 });
  writeFileSync(join(serverSecrets, "ATELIER_TOKEN"), OWNER, { mode: 0o600 });
  writeFileSync(join(serverSecrets, "OVERRIDE_SECRET"), OVERRIDE, { mode: 0o600 });
  const hooks = join(root, "no-hooks");
  mkdirSync(hooks);
  const dataDir = join(root, "data"), reposDir = join(root, "repos");
  const server = await startServer({ env: "staging", dataDir, reposDir, hooksDir: hooks, host: "127.0.0.1", secretsDir: serverSecrets, bindings: { ARTIFACTS: artifacts } });
  const stub = await s3stub();
  const keys = generateKeys();
  const keyFile = join(root, "backup.key");
  writeFileSync(keyFile, keys.privateKey, { mode: 0o600 });
  const backupSecrets = secretsDir(root, stub.endpoint, keys.publicKey);
  let writing = true;
  let restored;
  try {
    // A project with items, a repository with two branches, a large object.
    assert.equal((await api(server, "PUT", "/projects/demo", {})).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await api(server, "POST", "/projects/demo/items", { title: `Before the backup ${i}` })).status, 201);
    const projectFile = readdirSync(join(dataDir, "ledgers")).find((n) => n.startsWith("project%3A"));
    const key = decodeURIComponent(projectFile.slice("project%3A".length, -".sqlite".length));
    const bare = ensureRepo({ reposDir, hooksDir: hooks, key, branch: "main" });
    const work = join(root, "work");
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", work]);
    writeFileSync(join(work, "a.txt"), "one\n");
    gitIn(work, "add", "a.txt");
    gitIn(work, "commit", "--quiet", "-m", "one");
    gitIn(work, "checkout", "--quiet", "-b", "t/1");
    writeFileSync(join(work, "b.txt"), "two\n");
    gitIn(work, "add", "b.txt");
    gitIn(work, "commit", "--quiet", "-m", "two");
    gitIn(work, "push", "--quiet", bare, "main", "t/1");
    await server.settings.LARGE.put("diffs/t1/review", "a large text kept beside the Ledger");

    // Retention's field: this environment's own old and recent backups, an
    // own-named object R2 says is recent, and others' objects, old too.
    const now = Date.now();
    const seeded = {
      ownOld: objectKey("atelier/staging/", "staging", new Date(now - 40 * DAY)),
      ownRecent: objectKey("atelier/staging/", "staging", new Date(now - 5 * DAY)),
      ownNameOldButModifiedRecently: objectKey("atelier/staging/", "staging", new Date(now - 45 * DAY)),
      otherEnv: objectKey("atelier/production/", "production", new Date(now - 40 * DAY)),
      otherNameSamePrefix: "atelier/staging/notes-from-pavi.txt",
      productionNameInStagingPrefix: objectKey("atelier/staging/", "production", new Date(now - 40 * DAY)),
      elsewhere: "someone-else/atelier-staging-20200101T000000Z.backup",
    };
    for (const [name, k] of Object.entries(seeded)) {
      stub.objects.set(k, { body: Buffer.from(name), lastModified: new Date(name === "ownRecent" || name === "ownNameOldButModifiedRecently" ? now - 5 * DAY : now - 40 * DAY) });
    }

    // Writes keep landing while the backup runs, in its own process.
    let written = 0;
    const writer = (async () => {
      while (writing) {
        const r = await api(server, "POST", "/projects/demo/items", { title: `During the backup ${written}` });
        assert.equal(r.status, 201);
        written++;
      }
    })();
    const backup = await run(process.execPath, ["cli/backup.mjs", "--env", "staging", "--data", dataDir, "--repos", reposDir, "--secrets", backupSecrets, "--work", root], { timeout: 120_000 });
    writing = false;
    await writer;
    assert.ok(written > 0, "writes landed while the backup ran");
    assert.match(backup.stdout, /backup of staging: data .*, repositories /);
    assert.match(backup.stdout, /uploaded \d+ encrypted bytes to atelier-backups\/atelier\/staging\/atelier-staging-\d{8}T\d{6}Z\.backup at 127\.0\.0\.1:\d+/);

    // Every request the backup made was signed, and the stub's verifier
    // agrees with curl's own SigV4 signer, so it is not merely agreeing
    // with the code under test.
    assert.ok(stub.log.length >= 3);
    assert.deepEqual(stub.log.filter((r) => r.problem), []);
    const curlFile = join(root, "curl-body");
    writeFileSync(curlFile, "signed by curl\n");
    await run("curl", ["-sS", "-f", "--aws-sigv4", "aws:amz:auto:s3", "--user", `${ACCESS_KEY_ID}:${SECRET_ACCESS_KEY}`, "-H", `x-amz-content-sha256: ${createHash("sha256").update("signed by curl\n").digest("hex")}`, "-T", curlFile, `${stub.endpoint}/${BUCKET}/curl/check`]);
    assert.equal(stub.objects.get("curl/check").body.toString(), "signed by curl\n");
    assert.equal(stub.log.at(-1).problem, null);
    stub.objects.delete("curl/check");
    // A request signed with another secret is refused, and the backup says
    // so without the secret.
    const wrong = new S3Client({ endpoint: stub.endpoint, bucket: BUCKET, accessKeyId: ACCESS_KEY_ID, secretAccessKey: "not-the-secret" });
    await assert.rejects(wrong.list("atelier/"), (e) => /answered 403 SignatureDoesNotMatch/.test(e.message) && !e.message.includes("not-the-secret"));

    // Retention (criterion 3): only this environment's own backup older than
    // 30 days, by name and by LastModified, was deleted.
    const left = [...stub.objects.keys()];
    assert.ok(!left.includes(seeded.ownOld), "the 40-day-old own backup was deleted");
    for (const name of ["ownRecent", "ownNameOldButModifiedRecently", "otherEnv", "otherNameSamePrefix", "productionNameInStagingPrefix", "elsewhere"]) assert.ok(left.includes(seeded[name]), `${name} was kept`);
    assert.ok(stub.log.filter((r) => r.method === "DELETE").every((r) => r.key === seeded.ownOld));
    assert.match(backup.stdout, /deleted 1 older backup under atelier\/staging\//);
    const uploaded = left.filter((k) => /^atelier\/staging\/atelier-staging-\d{8}T\d{6}Z\.backup$/.test(k) && k !== seeded.ownRecent && k !== seeded.ownNameOldButModifiedRecently);
    assert.equal(uploaded.length, 1);
    const sealed = stub.objects.get(uploaded[0]).body;

    // Criterion 2: what R2 holds is unreadable without the private key. It
    // is not an archive, holds none of the data in the clear, and another
    // key, or a changed byte, does not open it.
    const sealedFile = join(root, "sealed");
    writeFileSync(sealedFile, sealed);
    assert.throws(() => execFileSync("tar", ["-tzf", sealedFile], { stdio: "ignore" }));
    for (const plain of ["SQLite format 3", "manifest", "Before the backup", "a large text"]) assert.ok(!sealed.includes(Buffer.from(plain)), `"${plain}" is not in the clear`);
    const other = generateKeys();
    await assert.rejects(decryptFile(sealedFile, join(root, "nope1"), privateKeyOf(other.privateKey)), /encrypted to another key/);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 40] ^= 1;
    writeFileSync(join(root, "tampered"), tampered);
    await assert.rejects(decryptFile(join(root, "tampered"), join(root, "nope2"), privateKeyOf(keys.privateKey)), /does not open/);
    const cut = join(root, "cut");
    writeFileSync(cut, sealed.subarray(0, sealed.length - 100));
    await assert.rejects(decryptFile(cut, join(root, "nope3"), privateKeyOf(keys.privateKey)), /does not open|cut short/);
    const opened = join(root, "opened.tgz");
    await decryptFile(sealedFile, opened, privateKeyOf(keys.privateKey));
    const tarBytes = gunzipSync(readFileSync(opened));
    const manifestText = execFileSync("tar", ["-xzOf", opened, "manifest.json"], { encoding: "utf8" });
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.env, "staging");
    assert.ok(manifest.files.some((f) => f.path === `data/${"ledgers/" + projectFile}` && /^[0-9a-f]{64}$/.test(f.sha256) && f.size > 0));
    assert.ok(manifest.files.some((f) => f.path === "data/ledgers/__index.sqlite"));
    assert.ok(manifest.files.some((f) => f.kind === "large"));
    assert.deepEqual(manifest.repos.find((r) => r.key === key).refs, refsOf(bare));

    // Restore (criterion 1): fetched from the stub, decrypted with the key,
    // checked, restored into fresh directories, and a server started on it.
    const newData = join(root, "restored-data"), newRepos = join(root, "restored-repos");
    const restore = await run(process.execPath, ["cli/restore.mjs", "--env", "staging", "--secrets", backupSecrets, "--key", keyFile, "--data", newData, "--repos", newRepos, "--check", "--work", root], { timeout: 120_000 });
    assert.match(restore.stdout, /restoring into .*restored-data and .*restored-repos, fresh directories: removing both undoes this restore/);
    assert.match(restore.stdout, /the restored server answers \/api\/version/);
    assert.match(restore.stdout, new RegExp(`${key}: \\d+ items, \\d+ events, as the backup counted`));

    // Criterion 4: no secret value in any log or in the archive.
    const secretValues = [SECRET_ACCESS_KEY, ACCESS_KEY_ID, keys.privateKey.split("\n")[1], OWNER, OVERRIDE];
    for (const [what, text] of [["backup output", backup.stdout + backup.stderr], ["restore output", restore.stdout + restore.stderr], ["manifest", manifestText]]) {
      for (const s of secretValues) assert.ok(!text.includes(s), `${what} holds no secret value`);
    }
    for (const s of secretValues) assert.ok(!tarBytes.includes(Buffer.from(s)), "the archive holds no secret value");

    // A restore never writes over what exists.
    await assert.rejects(run(process.execPath, ["cli/restore.mjs", "--file", sealedFile, "--key", keyFile, "--data", newData, "--repos", join(root, "other-repos")]), /is not empty; a restore goes into a fresh directory/);

    // The restored server against the live one: the project, every restored
    // item and event the same as the source's at the backup's moment, and as
    // many as the manifest counted; the refs equal.
    restored = await startServer({ env: "staging", dataDir: newData, reposDir: newRepos, hooksDir: hooks, host: "127.0.0.1", secretsDir: serverSecrets, bindings: { ARTIFACTS: artifacts } });
    const [src, dst] = await Promise.all([api(server, "GET", "/projects/demo"), api(restored, "GET", "/projects/demo")].map(async (p) => (await p).json()));
    assert.deepEqual(dst.project, src.project);
    const want = manifest.projects[key];
    assert.equal(dst.items.length, want.items);
    assert.ok(want.items > 5 && want.items <= src.items.length, `the backup caught ${want.items} of ${src.items.length} items`);
    const srcItems = new Map(src.items.map((i) => [i.id, i]));
    for (const item of dst.items) assert.deepEqual({ id: item.id, title: item.title, state: item.state }, { id: srcItems.get(item.id).id, title: srcItems.get(item.id).title, state: srcItems.get(item.id).state });
    const [srcEvents, dstEvents] = await Promise.all([allEvents(server, "demo"), allEvents(restored, "demo")]);
    assert.equal(dstEvents.length, want.events);
    assert.equal(dstEvents[0].seq, want.lastSeq);
    assert.deepEqual(dstEvents, srcEvents.filter((e) => e.seq <= want.lastSeq));
    assert.deepEqual(refsOf(join(newRepos, `${key}.git`)), refsOf(bare));
    assert.equal(execFileSync("git", ["symbolic-ref", "HEAD"], { cwd: join(newRepos, `${key}.git`), encoding: "utf8" }).trim(), "refs/heads/main");
    assert.equal(await (await restored.settings.LARGE.get("diffs/t1/review")).text(), "a large text kept beside the Ledger");
  } finally {
    writing = false;
    await restored?.close();
    await server.close();
    await stub.close();
  }
});

test("prune deletes nothing outside its prefix, whatever the listing answers", async () => {
  const stub = await s3stub();
  try {
    const client = new S3Client({ endpoint: stub.endpoint, bucket: BUCKET, accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY });
    const old = new Date(Date.now() - 60 * DAY);
    const own = objectKey("atelier/staging/", "staging", old);
    const lookalike = `atelier/staging-old/${objectKey("", "staging", old)}`;
    for (const k of [own, lookalike]) stub.objects.set(k, { body: Buffer.from("x"), lastModified: old });
    // A listing that answers more than the prefix asked for.
    const listing = client.list.bind(client);
    client.list = async () => listing("atelier/");
    assert.deepEqual(await prune(client, { prefix: "atelier/staging/", env: "staging" }), [own]);
    assert.ok(stub.objects.has(lookalike));
  } finally { await stub.close(); }
});

test("the envelope opens with its key alone, for an empty file and one of exact chunk size", async () => {
  const root = scratch();
  const keys = generateKeys();
  for (const size of [0, 65536, 65536 * 2 + 7]) {
    const plain = join(root, `p${size}`), sealed = join(root, `s${size}`), back = join(root, `b${size}`);
    const bytes = Buffer.alloc(size, 7);
    writeFileSync(plain, bytes);
    await encryptFile(plain, sealed, keys.publicKey);
    await decryptFile(sealed, back, privateKeyOf(keys.privateKey));
    assert.deepEqual(readFileSync(back), bytes);
  }
  // Cut at a chunk boundary: the chunk now last was not sealed as last.
  const twoChunks = join(root, "two"), sealed = join(root, "two.sealed");
  writeFileSync(twoChunks, Buffer.alloc(65536 * 2, 1));
  await encryptFile(twoChunks, sealed, keys.publicKey);
  const whole = readFileSync(sealed);
  writeFileSync(join(root, "two.cut"), whole.subarray(0, whole.length - (65536 + 16)));
  await assert.rejects(decryptFile(join(root, "two.cut"), join(root, "two.back"), privateKeyOf(keys.privateKey)), /does not open at chunk 1/);
});
