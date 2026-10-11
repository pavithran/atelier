// `atelier publish REMOTE` (t433): publishes the registered branch to a public
// mirror the project's publication policy declares, after a privacy check of
// every commit the mirror does not yet hold. Nothing here talks to Atelier's
// server; it reads the owner's checkout and the mirror, and refuses before any
// push when anything is wrong. It never pushes force, tags, notes or any ref
// but the one branch, and it names where a finding is (commit, path, line, the
// rule) and never the matched text.
//
// Policy comes from the registered project's commitIdentity (t451):
// publicMirrors declares remote names; publicMirrorDestinations pins URLs;
// email is the project's GitHub no-reply address. privateEmails are matched
// case-insensitively in content too. privatePaths are globs (* within a
// folder, ** across folders); privatePatterns are extra regular expressions.
// Built-in secret rules are src/secret-scan.ts (provider keys, private key
// blocks, bearer tokens and secret assignments), plus PRIVATE_ADDRESS below.
// Both publish REMOTE and wrap --push use this check.
//
// Git LFS: the push to a mirror uploads the project's LFS objects (gitEnv's
// ownerRemote), so a pointer file a commit adds or changes publishes the
// object it names, and the pointer alone proves nothing about that object.
// The object is read from the checkout's LFS storage and scanned as a file of
// its own (its lines, under every rule), and the commit is refused when it is
// not there, does not match the pointer, is binary or is over the scan size.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { settleCommitIdentity, sameEmail } from "../src/commit-identity.ts";
import { scanLine } from "../src/secret-scan.ts";

const SCAN_BYTES = 8 * 1024 * 1024;
const LFS_POINTER_BYTES = 1024; // the spec's upper bound on a pointer file

// Private addresses: RFC 1918 and carrier-grade NAT IPv4, link-local IPv4,
// IPv6 unique-local and link-local, and hostnames in a private suffix.
// Loopback is not private to anyone and is left alone. An IPv6 address is a
// private first group followed by at least two more colons, so a compressed
// ending (`fe80::`, `fd12:3456::`) is an address as much as `fd12:3456::1`;
// `fe80:1` alone is no address and is not one.
const OCTET = "(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)";
export const PRIVATE_ADDRESS = [
  ["private-ipv4", new RegExp(`(?<![\\d.])(?:10\\.${OCTET}\\.${OCTET}\\.${OCTET}|192\\.168\\.${OCTET}\\.${OCTET}|172\\.(?:1[6-9]|2\\d|3[01])\\.${OCTET}\\.${OCTET}|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.${OCTET}\\.${OCTET}|169\\.254\\.${OCTET}\\.${OCTET})(?![\\d])`)],
  ["private-ipv6", /(?<![0-9a-f:])(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]*:[0-9a-f]*(?![0-9a-f:])/i],
  ["private-hostname", /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:internal|local|lan|corp|intranet|home\.arpa)\b/i],
];

const fail = (why) => ({ ok: false, why });

// Validate the registered policy again before contacting any destination.
export function readPolicy(policy) {
  const bad = (why) => fail(`publication policy is invalid: ${why}`);
  if (!policy || typeof policy !== "object") return bad("missing commitIdentity");
  try {
    policy = settleCommitIdentity({ commitName: policy.name, commitEmail: policy.email,
      agentEmails: policy.agentEmails, privateEmails: policy.privateEmails,
      publicMirrors: policy.publicMirrors, publicMirrorDestinations: policy.publicMirrorDestinations,
      privatePaths: policy.privatePaths, privatePatterns: policy.privatePatterns }, undefined);
  } catch { return bad("check commitIdentity, publicMirrors, publicMirrorDestinations and privacy rules"); }
  if (!policy || !Array.isArray(policy.publicMirrors) || !policy.publicMirrors.length) return bad("publicMirrors must name a remote");
  const mirrors = Object.create(null);
  for (const name of policy.publicMirrors) {
    const destination = policy.publicMirrorDestinations?.[name];
    if (!destination) return bad(`publicMirrorDestinations needs a destination for ${name}`);
    mirrors[name] = { destination, email: policy.email };
  }
  return { ok: true, email: policy.email, mirrors, paths: (policy.privatePaths ?? []).map(globMatcher),
    patterns: (policy.privatePatterns ?? []).map((s) => new RegExp(s)), privateEmails: policy.privateEmails ?? [] };
}

// A path glob as a test: `**` crosses folders, `*` and `?` stay in one; a glob
// without `/` matches the name at any depth; a trailing `/` takes the folder.
export function globMatcher(glob) {
  let g = glob.replace(/^\.\//, "");
  const anywhere = !g.includes("/");
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const rx = new RegExp(`^${anywhere ? "(?:.*/)?" : ""}${re}$`);
  return (path) => rx.test(path);
}

const sameUrl = (a, b) => a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");
const firstLine = (text) => (text || "").trim().split("\n")[0];

// wrap pushes every checkout remote. Once the policy declares any public
// mirror, no remote is trusted by its URL: matching URLs misses aliases
// (file://, a missing .git, ssh forms), so every remote's outgoing commits
// get the public check before anything is pushed, failing closed. Each push
// URL is fetched, scanned for what it lacks and pushed by that URL itself,
// so pushurl fanout and a remote re-pointed mid-check are covered alike.
export function publishCheckoutRemote({ git, dir, branch, remote, say, identity }) {
  if (!identity?.publicMirrors?.length) {
    const result = git(["-c", `remote.${remote}.mirror=false`, "push", "--no-force", "--no-follow-tags", remote, `refs/heads/${branch}:refs/heads/${branch}`], { cwd: dir, allowFail: true, ownerRemote: true });
    return { ok: result.status === 0 };
  }
  const policy = readPolicy(identity);
  if (!policy.ok) { say(`Not published: ${policy.why}.`); return { ok: false }; }
  if (policy.mirrors[remote]) return publishMirror({ git, dir, branch, remote, say, identity });
  const urls = git(["remote", "get-url", "--push", "--all", remote], { cwd: dir, allowFail: true });
  const destinations = urls.status === 0 ? urls.stdout.split("\n").filter(Boolean) : [];
  if (!destinations.length) { say(`Not published: cannot read push destinations for ${remote}.`); return { ok: false }; }
  for (const destination of destinations) {
    if (!checkAndPush({ git, dir, branch, remote, say, policy, destination }).ok) return { ok: false };
  }
  return { ok: true };
}

// The paths one commit changes, with each one's new mode, blob and size (null
// when the object is missing): the file list `git log --name-only` would give,
// read in raw form so the mode and the blob come with it. A merge lists what
// differs from every parent, as its patch does. `raw` is a git runner that
// returns the result (cwd set, failure allowed).
export function changedFiles(raw, commit) {
  const names = raw(["log", "-1", "--format=", "--name-only", "-z", "--root", "-c", "--no-renames", commit]);
  if (names.status !== 0) return fail("git log --name-only failed");
  const tree = raw(["diff-tree", "-r", "-z", "--no-renames", "--root", "--no-commit-id", "-c", commit]);
  if (tree.status !== 0) return { ok: false, why: firstLine(tree.stderr) || "git diff-tree failed" };
  const parts = tree.stdout.split("\0"), list = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const header = parts[i], path = parts[i + 1];
    const parents = header.match(/^:+/)?.[0].length;
    if (!parents) return { ok: false, why: "unexpected diff-tree output" };
    const f = header.slice(parents).split(" ");
    const mode = f[parents], sha = f[2 * parents + 1];
    if (!mode || !sha) return { ok: false, why: "unexpected diff-tree output" };
    list.push({ path, mode, sha, size: null });
  }
  const named = new Set(names.stdout.split("\0").filter(Boolean));
  if (named.size !== list.length || list.some((file) => !named.has(file.path))) return fail("git log --name-only and diff-tree disagree about the paths");
  const blobs = list.filter((f) => !/^0+$/.test(f.mode) && f.mode !== "160000");
  if (blobs.length) {
    const sizes = raw(["cat-file", "--batch-check=%(objectname) %(objectsize)"], { input: blobs.map((f) => `${f.sha}\n`).join("") });
    if (sizes.status !== 0) return { ok: false, why: firstLine(sizes.stderr) || "git cat-file failed" };
    const known = new Map();
    for (const line of sizes.stdout.split("\n")) {
      const [sha, size] = line.split(" ");
      if (sha && /^\d+$/.test(size ?? "")) known.set(sha, Number(size));
    }
    for (const f of blobs) f.size = known.has(f.sha) ? known.get(f.sha) : null;
  }
  return { ok: true, list };
}

// A path as git prints it in a patch header: quoted C-style when it holds a
// quote, a control character or (under core.quotepath) a non-ASCII byte.
// It returns the path and what follows the quoted string, or null when the
// text is not one; unquoted text is the path itself, whole.
export function unquotePath(text) {
  if (!text.startsWith('"')) return { path: text, rest: "" };
  const bytes = [], escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, '"': 34 };
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"') return { path: Buffer.from(bytes).toString("utf8"), rest: text.slice(i + 1) };
    if (c !== "\\") { bytes.push(...Buffer.from(c, "utf8")); continue; }
    const next = text[++i];
    if (/[0-7]/.test(next ?? "")) {
      const oct = text.slice(i, i + 3).match(/^[0-7]{1,3}/)[0];
      bytes.push(parseInt(oct, 8)); i += oct.length - 1;
    } else if (next in escapes) bytes.push(escapes[next]);
    else return null;
  }
  return null;
}

// The path a `diff --git a/P b/P` or `diff --combined P` header names. With
// renames off both sides of a git header are the same path, so its length
// gives the split even when the path holds a space.
export function headerPath(line) {
  if (line.startsWith("diff --git ")) {
    const rest = line.slice("diff --git ".length);
    if (rest.startsWith('"')) {
      const q = unquotePath(rest);
      return q && q.path.startsWith("a/") && q.rest.startsWith(" ") ? q.path.slice(2) : null;
    }
    const n = (rest.length - 5) / 2;
    if (!Number.isInteger(n) || n < 0 || rest.slice(0, 2) !== "a/" || rest.slice(n + 2, n + 5) !== " b/" || rest.slice(2, n + 2) !== rest.slice(n + 5)) return null;
    return rest.slice(2, n + 2);
  }
  for (const prefix of ["diff --combined ", "diff --cc "]) if (line.startsWith(prefix)) {
    const q = unquotePath(line.slice(prefix.length));
    return q && q.rest === "" ? q.path : null;
  }
  return null;
}

// One commit's patch, as `git log -p` shows it (a merge as a combined diff),
// read file by file: for each path, whether git could only call it binary, and
// each line the commit adds with its line number in the commit's version of
// the file. A line a parent already held is not an added line; one the merge
// alone holds is.
export function commitPatch(raw, commit) {
  const shown = raw(["-c", "core.quotepath=true", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.srcPrefix=a/", "-c", "diff.dstPrefix=b/", "-c", "diff.suppressBlankEmpty=false",
    "log", "-1", "--format=", "-p", "-c", "-r", "--root", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "-U0", commit]);
  if (shown.status !== 0) return { ok: false, why: firstLine(shown.stderr) || "git log -p failed" };
  const files = new Map();
  let file = null, columns = 0, line = 0, inHunk = false;
  for (const text of shown.stdout.split("\n")) {
    if (text.startsWith("diff ")) {
      const path = headerPath(text);
      if (path === null) return { ok: false, why: `unreadable patch header: ${text.slice(0, 40)}` };
      file = files.get(path) ?? { path, binary: false, added: [] };
      files.set(path, file);
      inHunk = false;
      continue;
    }
    if (!file) { if (text === "") continue; return { ok: false, why: "patch text before any file header" }; }
    if (!inHunk) {
      if (/^Binary files /.test(text) || /^GIT binary patch/.test(text)) { file.binary = true; continue; }
      const hunk = text.match(/^(@+) (?:-\d+(?:,\d+)? )+\+(\d+)(?:,\d+)? @+/);
      if (hunk) { columns = hunk[1].length - 1; line = Number(hunk[2]); inHunk = true; }
      continue;
    }
    const hunk = text.match(/^(@+) (?:-\d+(?:,\d+)? )+\+(\d+)(?:,\d+)? @+/);
    if (hunk) { columns = hunk[1].length - 1; line = Number(hunk[2]); continue; }
    if (text.startsWith("\\")) continue; // "\ No newline at end of file"
    const prefix = text.slice(0, columns), body = text.slice(columns);
    if (prefix.includes("-")) continue; // in a parent, not in the commit
    if (prefix.includes("+")) file.added.push({ line, text: body });
    line++;
  }
  return { ok: true, files: [...files.values()] };
}

// A Git LFS pointer, or null when the text is not one: the spec's `version`
// line first, then `oid sha256:HEX` and `size N`, one key per line.
const LFS_VERSIONS = ["https://git-lfs.github.com/spec/v1", "https://hawser.github.com/spec/v1", "http://git-media.io/v/2"];
export function lfsPointer(text) {
  if ((!Buffer.isBuffer(text) && typeof text !== "string") || Buffer.byteLength(text) > LFS_POINTER_BYTES) return null;
  // Measure the original bytes: invalid UTF-8 in a replaced extension can
  // expand on decoding and make a valid, uploadable pointer look oversized.
  if (Buffer.isBuffer(text)) text = text.toString("utf8");
  // Go's bytes.TrimSpace, ScanLines (including CRLF) and ignored empty
  // lines, matching git-lfs/lfs/pointer.go. Extensions can precede version.
  const lines = text.replace(/^[\s\u0085]+|[\s\u0085]+$/g, "").split(/\r?\n/).filter((line) => line !== "");
  const keys = ["version", "oid", "size"], values = {}, extensions = new Map();
  let index = 0;
  for (const line of lines) {
    const space = line.indexOf(" ");
    if (space < 0 || index >= keys.length) return null;
    const key = line.slice(0, space), value = line.slice(space + 1);
    if (key === keys[index]) { values[key] = value; index++; continue; }
    if (!/^ext-\d-\w/.test(key)) return null;
    extensions.set(key, value);
  }
  // git-lfs collects extensions by key before validating their values:
  // a later occurrence replaces even an invalid earlier value. Rejecting
  // that earlier value here would mistake an uploadable pointer for text.
  if ([...extensions.values()].some((value) => !/^sha256:[0-9a-f]{64}$/.test(value))) return null;
  const priorities = [...extensions.keys()].map((key) => key.split("-")[1]);
  if (new Set(priorities).size !== priorities.length || !LFS_VERSIONS.includes(values.version)) return null;
  const oid = values.oid?.match(/^sha256:([0-9a-f]{64})$/)?.[1];
  if (!oid || !/^[+-]?\d+$/.test(values.size ?? "") || Number(values.size) < 0) return null;
  // Oversized integers are still treated as pointers: lfsObject refuses them.
  return { oid, size: Number(values.size) };
}

// Where the checkout keeps its LFS objects: lfs.storage when set (relative to
// the git directory), else `lfs` in the common git directory, as git-lfs does.
function lfsStorage(raw, dir) {
  const common = raw(["rev-parse", "--git-common-dir"]);
  if (common.status !== 0) return null;
  const gitDir = resolve(dir, common.stdout.trim());
  const configured = raw(["config", "--get", "lfs.storage"]);
  const storage = configured.status === 0 && configured.stdout.trim() ? configured.stdout.trim() : "lfs";
  return isAbsolute(storage) ? storage : resolve(gitDir, storage);
}

// The LFS object a pointer names, read from the checkout's storage and checked
// against the pointer: { ok, lines } with each line of the object, or { ok:
// false, why } when the object is not there, is not what the pointer says,
// is binary (a NUL in its first 8000 bytes, as git decides) or too large.
export function lfsObject(storage, { oid, size }) {
  if (!storage) return fail("the checkout's LFS storage cannot be located");
  const file = join(storage, "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
  let stat;
  try { stat = statSync(file); } catch (error) { return fail(`LFS object ${oid.slice(0, 12)} is not in the checkout's LFS storage (${error.code ?? error.message})`); }
  if (!stat.isFile()) return fail(`LFS object ${oid.slice(0, 12)} is not a file in the checkout's LFS storage`);
  if (stat.size !== size) return fail(`LFS object ${oid.slice(0, 12)} is ${stat.size} bytes, not the ${size} its pointer says`);
  if (stat.size > SCAN_BYTES) return fail(`LFS object ${oid.slice(0, 12)} is ${stat.size} bytes, over the ${SCAN_BYTES} the scan reads`);
  let bytes;
  try { bytes = readFileSync(file); } catch (error) { return fail(`LFS object ${oid.slice(0, 12)} cannot be read (${error.code ?? error.message})`); }
  if (createHash("sha256").update(bytes).digest("hex") !== oid) return fail(`LFS object ${oid.slice(0, 12)} does not match its pointer's oid`);
  if (bytes.subarray(0, 8000).includes(0)) return fail(`LFS object ${oid.slice(0, 12)} is binary content`);
  let decoded;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return fail(`LFS object ${oid.slice(0, 12)} is not UTF-8 text`); }
  const lines = decoded.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return { ok: true, lines };
}

// Publishes. `git(args, opts)` is atelier's runner; `say` prints. It returns
// { ok } and never exits itself, so the caller chooses the status.
export function publishMirror({ git, dir, branch, remote, say, identity }) {
  const refuse = (...lines) => { for (const l of lines) say(l); return { ok: false }; };
  const raw = (args, opts = {}) => git(args, { cwd: dir, allowFail: true, ...opts });
  const out = (args) => { const r = raw(args); return r.status === 0 ? r.stdout.trim() : null; };

  // 1. The policy, before anything else.
  const policy = readPolicy(identity);
  if (!policy.ok) return refuse(`Not published: ${policy.why}.`);
  const mirror = policy.mirrors[remote];
  if (!mirror) return refuse(`Not published: ${remote} is not a mirror commitIdentity.publicMirrors declares (it declares ${Object.keys(policy.mirrors).join(", ")}).`);
  const urlNow = () => out(["remote", "get-url", "--push", "--all", remote]);
  const url = urlNow();
  if (!url) return refuse(`Not published: ${dir} has no remote called ${remote}.`);
  if (!sameUrl(url, mirror.destination)) return refuse(`Not published: remote ${remote} points at a different place than the policy's destination for it; it was not pushed to. Point the remote at the declared destination, or change the policy.`);

  return checkAndPush({ git, dir, branch, remote, say, policy, destination: mirror.destination, urlNow, url });
}

// Steps 2 to 5 for one destination: fetch what it holds of the branch, refuse
// divergence, check every commit it lacks, and push the scanned tip there.
// `urlNow` and `url` let a declared mirror refuse a remote re-pointed during
// the check; a destination given as a URL is pushed to by that URL.
function checkAndPush({ git, dir, branch, remote, say, policy, destination, urlNow, url }) {
  const refuse = (...lines) => { for (const l of lines) say(l); return { ok: false }; };
  const raw = (args, opts = {}) => git(args, { cwd: dir, allowFail: true, ...opts });
  const out = (args) => { const r = raw(args); return r.status === 0 ? r.stdout.trim() : null; };
  const mirror = { destination, email: policy.email };
  const ref = `refs/heads/${branch}`;
  const tip = out(["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!tip) return refuse(`Not published: the registered branch ${branch} does not exist in ${dir}.`);

  // 2. The mirror's head, fetched before anything is scanned.
  const listed = raw(["ls-remote", "--refs", mirror.destination, ref]);
  if (listed.status !== 0) return refuse(`Not published: the mirror cannot be read: ${firstLine(listed.stderr) || "git ls-remote failed"}`);
  const advertised = listed.stdout.trim().split("\n").filter(Boolean).map((l) => l.split(/\s+/)[0]);
  let head = null;
  if (advertised.length) {
    const fetched = raw(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", mirror.destination, ref]);
    if (fetched.status !== 0) return refuse(`Not published: the mirror's ${branch} could not be fetched: ${firstLine(fetched.stderr)}`);
    head = advertised[0];
    if (raw(["cat-file", "-e", `${head}^{commit}`]).status !== 0) return refuse(`Not published: the mirror's ${branch} (${head.slice(0, 8)}) is not in the checkout after the fetch.`);
  }

  // 3. Divergence.
  if (head === tip) {
    say(`Mirror ${remote} already holds ${tip.slice(0, 8)}; nothing to publish.`);
    return { ok: true };
  }
  if (head && raw(["merge-base", "--is-ancestor", head, tip]).status !== 0) {
    const ahead = raw(["merge-base", "--is-ancestor", tip, head]).status === 0;
    return refuse(`Not published: the mirror's ${branch} (${head.slice(0, 8)}) ${ahead ? "is ahead of" : "has diverged from"} ${branch} (${tip.slice(0, 8)}). It is never force-pushed; reconcile the two by hand.`);
  }

  // 4. Every newly reachable commit, merged ancestry included: all history
  // when the mirror is empty.
  const listing = raw(["rev-list", "--topo-order", "--reverse", tip, ...(head ? [`^${head}`] : [])]);
  if (listing.status !== 0) return refuse(`Not published: the outgoing history cannot be listed: ${firstLine(listing.stderr)}`);
  const commits = listing.stdout.split("\n").filter(Boolean);
  const findings = [], refusals = [];

  for (const c of commits) {
    const who = raw(["log", "-1", "--format=%ae%x00%ce", c]);
    const [ae, ce] = who.stdout.replace(/\n$/, "").split("\0");
    const wrong = [!sameEmail(ae ?? "", mirror.email) ? "author" : null, !sameEmail(ce ?? "", mirror.email) ? "committer" : null].filter(Boolean);
    if (wrong.length) findings.push(`${c.slice(0, 12)}: ${wrong.join(" and ")} email is not ${mirror.email}`);
  }

  // Each commit is read on its own, as `git log -p --name-only` over the
  // range would show it, never as the net difference between the mirror and
  // the branch: a push publishes every commit, so a line added in one commit
  // and deleted in a later one is published and is scanned where it was
  // added. The file list names every path the commit changes (a private-path
  // glob is checked against it, and a submodule, a missing or an oversized
  // blob is refused from it); the patch gives the lines the commit adds, with
  // their line numbers in the commit. A merge is read as a combined diff:
  // what it holds that no parent held, and the parents are read as commits
  // of their own, published or outgoing.
  const rulesFor = (text) => {
    const rules = [];
    if (scanLine(text)) rules.push("secret");
    if (policy.privateEmails.some((email) => text.toLowerCase().includes(email.toLowerCase()))) rules.push("private-email");
    for (const [name, rx] of PRIVATE_ADDRESS) if (rx.test(text)) rules.push(name);
    if (policy.patterns.some((rx) => rx.test(text))) rules.push("private-pattern");
    return rules;
  };
  let storage;
  for (const c of commits) {
    const files = changedFiles(raw, c);
    if (!files.ok) { refusals.push(`${c.slice(0, 12)}: the commit's file list cannot be read (${files.why})`); continue; }
    const scan = new Map(); // path -> blob
    for (const { path, mode, sha, size } of files.list) {
      if (/^0+$/.test(mode)) continue; // a deletion adds nothing; the commit that added the path is scanned
      const at = `${c.slice(0, 12)} ${path}`;
      if (policy.paths.some((m) => m(path))) findings.push(`${at}: the path matches a private path glob`);
      if (mode === "160000") { refusals.push(`${at}: a submodule, whose content is in another repository`); continue; }
      if (size === null) { refusals.push(`${at}: unreadable (object ${sha.slice(0, 12)} is missing or corrupt)`); continue; }
      if (size > SCAN_BYTES) { refusals.push(`${at}: ${size} bytes, over the ${SCAN_BYTES} the scan reads`); continue; }
      scan.set(path, { sha, size });
    }
    if (!scan.size) continue;
    const patch = commitPatch(raw, c);
    if (!patch.ok) { refusals.push(`${c.slice(0, 12)}: the commit's patch cannot be read (${patch.why})`); continue; }
    for (const file of patch.files) {
      if (!scan.has(file.path)) continue;
      const blob = scan.get(file.path);
      scan.delete(file.path);
      const at = `${c.slice(0, 12)} ${file.path}`;
      if (file.added.some(({ text }) => text.includes("\ufffd"))) { refusals.push(`${at}: content cannot be decoded reliably as UTF-8`); continue; }
      if (file.binary) { refusals.push(`${at}: binary content`); continue; }
      for (const { line, text } of file.added) {
        const rules = rulesFor(text);
        if (rules.length) findings.push(`${at}:${line}: ${rules.join(", ")}`);
      }
      // An LFS pointer publishes the object it names: that object is read
      // from the checkout's LFS storage and scanned, or the commit is refused.
      // Every changed blob small enough to be a pointer is read whole and
      // parsed as one, whatever lines the commit added to it: a file that
      // held a version and an oid line but no size line was no pointer, and
      // the commit that adds only its size line makes it one, so the lines
      // the commit adds say nothing about whether the blob is a pointer now.
      if (blob.size > LFS_POINTER_BYTES) continue;
      const shown = raw(["cat-file", "blob", blob.sha], { bytes: true });
      if (shown.status !== 0) { refusals.push(`${at}: unreadable (${firstLine(shown.stderr) || "git cat-file failed"})`); continue; }
      const pointer = lfsPointer(shown.stdout);
      if (!pointer) continue; // a text file, not a pointer
      storage ??= lfsStorage(raw, dir);
      const object = lfsObject(storage, pointer);
      if (!object.ok) { refusals.push(`${at}: ${object.why}`); continue; }
      const where = `${at} (LFS object ${pointer.oid.slice(0, 12)})`;
      object.lines.forEach((text, i) => {
        const rules = rulesFor(text);
        if (rules.length) findings.push(`${where}:${i + 1}: ${rules.join(", ")}`);
      });
    }
    // A path the file list names whose patch did not come back is not
    // stepped over: nothing was read for it.
    for (const path of scan.keys()) refusals.push(`${c.slice(0, 12)} ${path}: no patch for the path in the commit's diff`);
  }

  const problems = findings.length + refusals.length;
  if (problems) {
    say(`Not published: ${problems} problem${problems === 1 ? "" : "s"} in the ${commits.length} commit${commits.length === 1 ? "" : "s"} ${remote} would receive. Nothing was pushed. Matched text is never shown; read the line in the commit.`);
    for (const f of findings) say(`  ${f}`);
    for (const r of refusals) say(`  cannot scan ${r}`);
    return { ok: false };
  }

  // 5. The push: the scanned commit, to the one branch, never forced and to
  // the declared destination itself. A remote re-pointed since the check is
  // refused here; a mirror that moved since the fetch is refused by git, which
  // rejects a push that is not a fast-forward.
  if (urlNow && urlNow() !== url) return refuse("Not published: the remote's URL changed during the check; it was not pushed to.");
  const pushed = raw(["-c", `remote.${remote}.mirror=false`, "-c", "push.followTags=false", "push", "--no-force", "--quiet", "--no-follow-tags", "--recurse-submodules=no", mirror.destination, `${tip}:${ref}`], { ownerRemote: true });
  if (pushed.status !== 0) return refuse(`Not published: the mirror refused the push (it may have moved since it was fetched): ${firstLine(pushed.stderr)}`);
  say(`Mirror ${remote} now at ${tip.slice(0, 8)}: ${commits.length} commit${commits.length === 1 ? "" : "s"} checked and pushed to ${branch}.`);
  return { ok: true };
}
