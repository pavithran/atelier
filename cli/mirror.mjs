// `atelier publish REMOTE` (t433): publishes the registered branch to a public
// mirror the project's publication policy declares, after a privacy check of
// every commit the mirror does not yet hold. Nothing here talks to Atelier's
// server; it reads the owner's checkout and the mirror, and refuses before any
// push when anything is wrong. It never pushes force, tags, notes or any ref
// but the one branch, and it names where a finding is (commit, path, line, the
// rule) and never the matched text.
//
// The policy is `.atelier/publication.json` in the registered checkout:
//   { "mirrors": { "REMOTE": { "destination": "URL", "email": "ADDRESS" } },
//     "privatePaths": ["GLOB", ...], "privatePatterns": ["REGEX", ...] }
// REMOTE is a remote of the checkout; its URL must equal `destination` when
// the push is made. `email` is the one address every new commit's author and
// committer must carry. `privatePaths` are globs a published path may not
// match (a glob without `/` matches a name at any depth; `*` stays inside a
// folder, `**` crosses folders). `privatePatterns` are extra regular
// expressions no published line may match. The built-in rules are the secret
// rules of the push scan (src/secret-scan.ts: provider keys, private key
// blocks, bearer tokens, `.env`-style secret assignments) and the private
// addresses in PRIVATE_ADDRESS below.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scanLine } from "../src/secret-scan.ts";

export const POLICY_PATH = ".atelier/publication.json";
const SCAN_BYTES = 8 * 1024 * 1024;

// Private addresses: RFC 1918 and carrier-grade NAT IPv4, link-local IPv4,
// IPv6 unique-local and link-local, and hostnames in a private suffix.
// Loopback is not private to anyone and is left alone.
const OCTET = "(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)";
export const PRIVATE_ADDRESS = [
  ["private-ipv4", new RegExp(`(?<![\\d.])(?:10\\.${OCTET}\\.${OCTET}\\.${OCTET}|192\\.168\\.${OCTET}\\.${OCTET}|172\\.(?:1[6-9]|2\\d|3[01])\\.${OCTET}\\.${OCTET}|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.${OCTET}\\.${OCTET}|169\\.254\\.${OCTET}\\.${OCTET})(?![\\d])`)],
  ["private-ipv6", /(?<![0-9a-f:])(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]*:[0-9a-f]+(?![0-9a-f:])/i],
  ["private-hostname", /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:internal|local|lan|corp|intranet|home\.arpa)\b/i],
];

const fail = (why) => ({ ok: false, why });

// The policy, or why it cannot be used. Strict: anything unexpected is invalid.
export function readPolicy(dir) {
  let text;
  try { text = readFileSync(join(dir, POLICY_PATH), "utf8"); }
  catch (error) { return fail(`no publication policy: ${POLICY_PATH} cannot be read in ${dir} (${error.code ?? error.message})`); }
  let policy;
  try { policy = JSON.parse(text); } catch { return fail(`${POLICY_PATH} is not valid JSON`); }
  const bad = (m) => fail(`${POLICY_PATH} is invalid: ${m}`);
  const obj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!obj(policy)) return bad("it must be an object");
  for (const key of Object.keys(policy)) if (!["mirrors", "privatePaths", "privatePatterns"].includes(key)) return bad(`unknown field ${JSON.stringify(key)}`);
  if (!obj(policy.mirrors) || !Object.keys(policy.mirrors).length) return bad("mirrors must name at least one remote");
  for (const [name, m] of Object.entries(policy.mirrors)) {
    if (!obj(m)) return bad(`mirror ${name} must be an object`);
    for (const key of Object.keys(m)) if (!["destination", "email"].includes(key)) return bad(`mirror ${name} has unknown field ${JSON.stringify(key)}`);
    if (typeof m.destination !== "string" || !m.destination.trim()) return bad(`mirror ${name} needs a destination URL`);
    if (typeof m.email !== "string" || !/^[^\s@<>]+@[^\s@<>]+$/.test(m.email)) return bad(`mirror ${name} needs the public email address commits carry`);
  }
  const list = (key) => policy[key] === undefined ? [] : Array.isArray(policy[key]) && policy[key].every((s) => typeof s === "string" && s) ? policy[key] : null;
  const paths = list("privatePaths"), patterns = list("privatePatterns");
  if (!paths) return bad("privatePaths must be a list of globs");
  if (!patterns) return bad("privatePatterns must be a list of regular expressions");
  const regexes = [];
  for (const [i, source] of patterns.entries()) {
    try { regexes.push(new RegExp(source)); } catch { return bad(`privatePatterns entry ${i + 1} is not a valid regular expression`); }
  }
  return { ok: true, mirrors: policy.mirrors, paths: paths.map(globMatcher), patterns: regexes };
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

// Publishes. `git(args, opts)` is atelier's runner; `say` prints. It returns
// { ok } and never exits itself, so the caller chooses the status.
export function publishMirror({ git, dir, branch, remote, say }) {
  const refuse = (...lines) => { for (const l of lines) say(l); return { ok: false }; };
  const raw = (args, opts = {}) => git(args, { cwd: dir, allowFail: true, ...opts });
  const out = (args) => { const r = raw(args); return r.status === 0 ? r.stdout.trim() : null; };

  // 1. The policy, before anything else.
  const policy = readPolicy(dir);
  if (!policy.ok) return refuse(`Not published: ${policy.why}.`);
  const mirror = policy.mirrors[remote];
  if (!mirror) return refuse(`Not published: ${remote} is not a mirror ${POLICY_PATH} declares (it declares ${Object.keys(policy.mirrors).join(", ")}).`);
  const urlNow = () => out(["remote", "get-url", remote]);
  const url = urlNow();
  if (!url) return refuse(`Not published: ${dir} has no remote called ${remote}.`);
  if (!sameUrl(url, mirror.destination)) return refuse(`Not published: remote ${remote} points at a different place than the policy's destination for it; it was not pushed to. Point the remote at the declared destination, or change the policy.`);

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
    const wrong = [ae !== mirror.email ? "author" : null, ce !== mirror.email ? "committer" : null].filter(Boolean);
    if (wrong.length) findings.push(`${c.slice(0, 12)}: ${wrong.join(" and ")} email is not ${mirror.email}`);
  }

  // Each blob at a path is read once, in the first commit that carries it. A
  // blob a later commit deleted is still read: the commit that added it is
  // published whole.
  const seen = new Set();
  for (const c of commits) {
    const tree = raw(["diff-tree", "-r", "-z", "--no-renames", "--root", "--no-commit-id", "-c", c]);
    if (tree.status !== 0) { refusals.push(`${c.slice(0, 12)}: the commit's changes cannot be read (${firstLine(tree.stderr)})`); continue; }
    const parts = tree.stdout.split("\0");
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const header = parts[i], path = parts[i + 1];
      const parents = header.match(/^:+/)?.[0].length;
      if (!parents) { refusals.push(`${c.slice(0, 12)}: the commit's changes cannot be read`); break; }
      const f = header.slice(parents).split(" ");
      const mode = f[parents], sha = f[2 * parents + 1];
      if (/^0+$/.test(mode)) continue; // a deletion adds nothing; the commit that added the path is scanned
      const at = `${c.slice(0, 12)} ${path}`;
      if (policy.paths.some((m) => m(path))) findings.push(`${at}: the path matches a private path glob`);
      if (mode === "160000") { refusals.push(`${at}: a submodule, whose content is in another repository`); continue; }
      const key = `${sha}\0${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const blob = raw(["cat-file", "blob", sha]);
      if (blob.status !== 0) { refusals.push(`${at}: unreadable (${firstLine(blob.stderr) || "object missing"})`); continue; }
      if (blob.stdout.length > SCAN_BYTES) { refusals.push(`${at}: ${blob.stdout.length} characters, over the ${SCAN_BYTES} the scan reads`); continue; }
      if (blob.stdout.includes("\0")) { refusals.push(`${at}: binary content`); continue; }
      blob.stdout.split(/\r?\n/).forEach((text, n) => {
        const rules = [];
        if (scanLine(text)) rules.push("secret");
        for (const [name, rx] of PRIVATE_ADDRESS) if (rx.test(text)) rules.push(name);
        if (policy.patterns.some((rx) => rx.test(text))) rules.push("private-pattern");
        if (rules.length) findings.push(`${at}:${n + 1}: ${rules.join(", ")}`);
      });
    }
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
  if (urlNow() !== url) return refuse("Not published: the remote's URL changed during the check; it was not pushed to.");
  const pushed = raw(["-c", "push.followTags=false", "push", "--quiet", "--no-follow-tags", "--recurse-submodules=no", mirror.destination, `${tip}:${ref}`], { ownerRemote: true });
  if (pushed.status !== 0) return refuse(`Not published: the mirror refused the push (it may have moved since it was fetched): ${firstLine(pushed.stderr)}`);
  say(`Mirror ${remote} now at ${tip.slice(0, 8)}: ${commits.length} commit${commits.length === 1 ? "" : "s"} checked and pushed to ${branch}.`);
  return { ok: true };
}
