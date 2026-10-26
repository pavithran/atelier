// The secret scan a push runs: it reads the lines each of the task's commits
// adds and reports the commit, file and line of each that holds a key
// pattern, never the value itself.
// The patterns come from Pullboard's pre-commit scan, narrowed to what a task
// can accidentally push: cloud and model-provider API keys, private key
// blocks, bearer tokens, and `.env`-style assignments of long secrets.
//
// The scanner is pure and returns only `{ file, line, fingerprint }`, so
// nothing that matches is ever stored or printed; the Ledger keeps the flag,
// not the key.

import { changedEntries, diffLines, isBinary, pairReader, splitLines, strictReader, type Leaf, type Reader } from "./diff.ts";

// What one matched line is reported as: the file it was added to, the 1-based
// line number in the new file, and a fingerprint of the line (below). The
// matched text is never kept. `commit` names the commit that added the line
// when the scan read a history (scanCommit); a scan of two trees alone
// (scanTrees) leaves it out.
export interface SecretHit {
  file: string;
  line: number;
  fingerprint: string;
  commit?: string;
}

// A path whose head side the scan could not read as text (a binary blob, a
// submodule, or a blob over SCAN_BYTES), with why, and the hash of the object at the head as its
// fingerprint: a clearance of it holds while that object is unchanged, and a
// changed object at the path blocks again. The reason names the kind of
// object, never any of its content.
export interface UnscannedFile {
  file: string;
  fingerprint: string;
  reason: string;
  commit?: string;
}

// The fingerprint of a flagged line: the SHA-256, as hex, of the line's text
// with its leading and trailing whitespace removed. The owner's clearance of
// a flag is recorded against the file and this fingerprint (clearSecret in
// src/ledger.ts), so a later push that keeps the identical line in the same
// file, at the same line number or another, finds the clearance and is not
// blocked again, while a line that changed in any other way, or the same
// line in another file, is a new finding and blocks. The fingerprint is a
// one-way digest, so the flag and the clearance never hold the value; a
// reader who already has a candidate key could confirm it against the
// digest, which is the trade made for a clearance that survives a push.
export async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.trim()));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── patterns ───────────────────────────────────────────────────────────────

// A PEM or OpenSSH private key block, whatever the algorithm ("RSA", "EC",
// "OPENSSH", "DSA", "PGP" or none, encrypted or not).
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

// A bearer token: an Authorization header or a bare `bearer <token>`, the
// token long enough that a short word is not taken for one.
const BEARER = /(?:authorization\s*[:=]\s*)?bearer\s+[A-Za-z0-9._~+/=-]{16,}/i;

// Cloud and model-provider API keys, matched by the provider's fixed prefix
// and a long body of the charset the provider uses, so a short lookalike or a
// mention of a key's name does not match. One `sk-` pattern covers OpenAI
// ("sk-", "sk-proj-") and Anthropic ("sk-ant-") and every other `sk-` provider.
const KEY_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{35}/,               // Google Cloud API key
  /(?:AKIA|ASIA)[0-9A-Z]{16}/,           // AWS access key id
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}/, // GitHub classic token
  /github_pat_[A-Za-z0-9_]{22,}/,        // GitHub fine-grained token
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/,     // OpenAI, Anthropic and other sk- keys
  /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/, // Stripe key
  /xox[baprs]-[A-Za-z0-9-]{10,}/,        // Slack token
  // Atelier's own token, as tokenFromBytes (src/tokens.ts) mints it: "atl_"
  // and the hex of at least 32 random bytes, lowercase, standing alone, so a
  // name such as atl_config never matches (t594).
  /(?<![A-Za-z0-9_])atl_(?:[0-9a-f]{2}){32,}(?![A-Za-z0-9_])/,
];

// A variable name segment that marks a `.env`-style assignment as a secret.
// Compared lower-cased, so OPENAI_API_KEY, ApiKey and api_key all match.
const SECRET_SEGMENTS = new Set([
  "key", "secret", "token", "password", "passwd", "pass",
  "credential", "credentials", "auth", "apikey", "privatekey",
]);

// A long, token-shaped value: at least this many base64-ish characters, with
// no space, colon or other structure, is far more likely a secret than a
// config value such as a URL, a version or a colour.
const LONG_VALUE = 40;

// The shortest value a `.env`-style assignment reports, so a placeholder such
// as `API_KEY=your_key_here` is not taken for a secret.
const SHORT_SECRET = 24;

// A `.env`-style assignment: `NAME=value` on its own line, in every form a
// .env parser reads: an optional `export ` prefix, spaces around the `=`, the
// value bare or in single, double or back quotes, base64 padding (one or two
// trailing `=`), and a trailing `# comment`. The value must be token-shaped,
// so `URL=https://…` (a colon), `COLOR=#fff` (too short, a hash) and
// `PORT=8080` (too short) never match.
// A value shorter than LONG_VALUE counts only when the name is itself a
// secret name, and any value counts once it is at least SHORT_SECRET, so
// `OPENAI_API_KEY=sk-…` matches and `API_KEY=your_key_here` does not.
const ASSIGNMENT = new RegExp(`^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(["'\`]?)(~?[A-Za-z0-9+/_-]{${SHORT_SECRET},}={0,2})\\2\\s*(?:#.*)?$`);

// A name ending in one of these holds a place on disk, not a secret, when its
// value is an absolute or home-relative path: `CHROME_PATH=/Users/me/.../bin`
// is long and token-shaped but not a key (t554). The value must also start
// with a path root, so a long token assigned to a `_PATH` name still matches.
const LOCATION_SEGMENTS = new Set(["path", "dir", "directory", "file", "home", "root"]);

function secretAssignment(text: string): boolean {
  const m = ASSIGNMENT.exec(text);
  if (!m) return false;
  const value = m[3];
  const segments = m[1].split("_");
  if (LOCATION_SEGMENTS.has(segments[segments.length - 1].toLowerCase()) && /^(?:\/|~\/)/.test(value)) return false;
  if (value.length >= LONG_VALUE) return true;
  return segments.some((segment) => SECRET_SEGMENTS.has(segment.toLowerCase()));
}

// Whether one added line holds a key pattern. It reports only whether, so no
// value is read out of the line.
export function scanLine(text: string): boolean {
  if (PRIVATE_KEY.test(text)) return true;
  if (BEARER.test(text)) return true;
  if (KEY_PATTERNS.some((re) => re.test(text))) return true;
  return secretAssignment(text);
}

// ── the scan's input ───────────────────────────────────────────────────────
//
// The scan reads the trees itself and is fail closed by construction: it
// enumerates every path whose entry differs between the base tree and the
// head tree (changedEntries in src/diff.ts: added, modified, renamed,
// type-changed, mode-changed) and, for each with a head side, reads the
// head-side object by its hash and decides what it is from the content
// alone. It never takes the display diff's word for a file: the display
// diff reads a file as binary, a submodule or too large to show, and shows
// nothing for it, which is right for a reader and wrong for a scan, where
// nothing shown is a key not found. Four rounds each closed one such case
// (t332); this design has no such case to close, because every head-side
// object is either scanned as text or recorded as a blocking unscanned flag.
//
// - A head-side regular file or symlink whose content is text is scanned: its
//   added lines against the base side when the base side is text of a
//   readable size, and otherwise (no base side, a binary, a submodule, an
//   oversized base, a base of another type) its whole text as added.
// - A head side that is an ordinary image or font (MEDIA_SIGNATURES) is
//   scanned as raw bytes, all of it as added, and blocks only if a key
//   pattern is in it (t554).
// - A head side that is not text (any other binary content, a submodule, which is a
//   commit in another repository, a blob over SCAN_BYTES) is recorded unscanned with the reason and the
//   object's hash, so the owner clears it by content, like a hit.
// - A deleted path has no head side and needs no scan. A path whose head
//   object is the base object (a mode-only change) adds no content.
// - A missing object throws (strictReader), and the scan stays pending.

// The largest blob the scan decodes as text. Larger ones are recorded
// unscanned rather than read into a Worker's memory.
export const SCAN_BYTES = 8 * 1024 * 1024;

const SUBMODULE = "160000";
const decoder = new TextDecoder();

// The head-side object as the scan read it: text lines, or why not. `media`
// marks an ordinary image or font, whose bytes were read as Latin-1 text so
// that a key pasted into it is still found (t554).
type Side = { lines: string[]; media?: true } | { reason: string };

// The complete signatures of the ordinary binaries a task commits: PNG, JPEG, GIF, WebP
// and WOFF/WOFF2 fonts. A file that starts with one is scanned for key
// patterns as raw bytes instead of blocking as unreadable; any other binary
// still blocks, as does a file that merely claims the name of an image.
const MEDIA_SIGNATURES: number[][] = [
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  [0xff, 0xd8, 0xff],
  [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],       // GIF87a
  [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],       // GIF89a
  [0x77, 0x4f, 0x46, 0x46],
  [0x77, 0x4f, 0x46, 0x32],
];
function isMedia(b: Uint8Array): boolean {
  if (MEDIA_SIGNATURES.some((sig) => sig.every((v, i) => b[i] === v))) return true;
  // WebP: "RIFF", a size, then "WEBP".
  return [0x52, 0x49, 0x46, 0x46].every((v, i) => b[i] === v) && [0x57, 0x45, 0x42, 0x50].every((v, i) => b[8 + i] === v);
}

async function readSide(r: Reader, leaf: Leaf): Promise<Side> {
  if (leaf.mode === SUBMODULE) return { reason: "a submodule, whose content is in another repository" };
  const bytes = await r.blob(leaf.hash);
  // The reader is strict (scanTrees), so a missing blob threw already; the
  // guard keeps the type honest without reading a hole as empty.
  if (!bytes) throw new Error(`secret scan: blob ${leaf.hash.slice(0, 8)} is missing from the repositories`);
  if (bytes.length > SCAN_BYTES) return { reason: `${bytes.length} bytes, over the ${SCAN_BYTES} the scan reads` };
  if (isBinary(bytes)) {
    if (isMedia(bytes)) return { lines: splitLines(new TextDecoder("latin1").decode(bytes)), media: true };
    return { reason: "binary content" };
  }
  return { lines: splitLines(decoder.decode(bytes)) };
}

// The added lines of one changed path, each with its 1-based line number in
// the head-side file, or the reason the path could not be scanned.
async function addedLines(r: Reader, base: Leaf | null, head: Leaf): Promise<{ added: [number, string][] } | { reason: string }> {
  const after = await readSide(r, head);
  if ("reason" in after) return after;
  // Only a base side that is itself readable text is diffed against; any
  // other base side (absent, binary, a submodule, oversized) makes every
  // head line an added one.
  const before = base ? await readSide(r, base) : null;
  if (!before || "reason" in before || before.media || after.media) return { added: after.lines.map((text, i) => [i + 1, text]) };
  const ops = diffLines(before.lines, after.lines);
  // A diff too costly to compute is not a file too large to read (t469): the
  // scan only needs the lines the head added, so it takes every head line
  // whose text the base side does not hold. One pass over each side, no
  // chunk boundary a key could straddle. A line the base also holds is
  // already on main, so skipping it hides nothing the push adds.
  if (!ops) {
    const known = new Set(before.lines);
    return { added: after.lines.flatMap((text, i): [number, string][] => (known.has(text) ? [] : [[i + 1, text]])) };
  }
  const added: [number, string][] = [];
  let line = 1;
  for (const op of ops) {
    if (op.op === "-") continue; // a removed line is not in the head-side file
    if (op.op === "+") added.push([line, op.text]);
    line++;
  }
  return { added };
}

// The whole result of scanning a push: every added line that held a key
// pattern, as file, line and fingerprint (a line is reported once however
// many patterns match it), and every path whose head side could not be read
// as text, with the reason. The caller records both as blocking flags, so a
// push the scan could not fully read is never passed silently. An object the
// trees name and the reader cannot supply throws, so the scan never answers
// from a hole.
export interface PushScan {
  hits: SecretHit[];
  unscanned: UnscannedFile[];
}

export async function scanTrees(reader: Reader, baseTree: string, headTree: string): Promise<PushScan> {
  const r = strictReader(reader);
  const scan: PushScan = { hits: [], unscanned: [] };
  if (baseTree === headTree) return scan;
  for (const [base, head] of await changedEntries(r, baseTree, headTree, Infinity)) {
    if (!head) continue; // a deleted path has nothing added
    // A mode-only change keeps the object main already holds; nothing is
    // added, whatever the object is.
    if (base && base.hash === head.hash) continue;
    const result = await addedLines(r, base, head);
    if ("reason" in result) { scan.unscanned.push({ file: head.path, fingerprint: head.hash, reason: result.reason }); continue; }
    for (const [line, text] of result.added) {
      if (scanLine(text)) scan.hits.push({ file: head.path, line, fingerprint: await fingerprint(text) });
    }
  }
  return scan;
}

// ── the task's history ─────────────────────────────────────────────────────
//
// The gate scans every commit the task adds, as scripts/privacy-scan.mjs does
// before the push to GitHub, so a key one commit added and a later one
// removed is still found: the push to GitHub sends every commit, and the
// removed key is in one of them (t295). A scan of the head's tree against
// main's alone missed it.
//
// The task's commits are those the head reaches and main does not: the walk
// follows every parent from the head and stops at any commit main's history
// holds. Each is scanned against its parent, and a root commit against the
// empty tree. A merge is scanned against each parent, and a finding counts
// only when every side adds it, as a line Git's combined diff shows: a merge
// of main into the task adds main's lines on one side and the task's on the
// other, and both are already scanned where they were first added.

// The most commits of main's history read to know where the task's begin,
// and the most commits of the task's own the scan reads. A task over the
// second throws, and the scan stays pending.
const MAIN_COMMITS = 1000;
const TASK_COMMITS = 1000;
const LOG_PAGE = 100;

// The empty tree, the base a root commit is scanned against. No repository
// need hold it: the reader answers it as empty.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
function withEmptyTree(r: Reader): Reader {
  return { tree: async (h) => (h === EMPTY_TREE ? [] : r.tree(h)), blob: (h) => r.blob(h) };
}

type Commit = Pick<ArtifactsCommitMetadata, "hash" | "treeHash" | "parents">;

// The commits the head reaches that are not in `onMain`, newest first. Every
// commit is read from the fork by its id; one the fork cannot show throws.
async function taskCommits(fork: ArtifactsRepo, head: Commit, onMain: Set<string>): Promise<Commit[]> {
  const read = new Map<string, Commit>([[head.hash, head]]);
  const found = new Map<string, Commit>();
  const next = [head.hash];
  while (next.length) {
    const hash = next.shift()!;
    if (onMain.has(hash) || found.has(hash)) continue;
    if (found.size >= TASK_COMMITS) throw new Error(`secret scan: the task adds more than ${TASK_COMMITS} commits, more than the scan reads`);
    if (!read.has(hash)) for (const c of await fork.log({ ref: hash, limit: LOG_PAGE })) read.set(c.hash, c);
    const commit = read.get(hash);
    if (!commit) throw new Error(`secret scan: the fork did not show commit ${hash.slice(0, 8)}`);
    found.set(hash, commit);
    next.push(...(commit.parents ?? []));
  }
  return [...found.values()];
}

// What one commit adds: its scan against its parent, or against each parent
// of a merge with only the findings every side shares (by file and
// fingerprint), each named with the commit.
async function scanAdded(r: Reader, commit: Commit, trees: Map<string, string>): Promise<PushScan> {
  const parents = commit.parents?.length ? commit.parents : [null];
  const sides: PushScan[] = [];
  for (const parent of parents) {
    if (parent !== null && !trees.has(parent)) throw new Error(`secret scan: the tree of commit ${parent.slice(0, 8)} is not known`);
    sides.push(await scanTrees(r, parent === null ? EMPTY_TREE : trees.get(parent)!, commit.treeHash));
  }
  const key = (f: { file: string; fingerprint: string }) => `${f.file}\0${f.fingerprint}`;
  const shared = (list: (s: PushScan) => { file: string; fingerprint: string }[]) => {
    const others = sides.slice(1).map((s) => new Set(list(s).map(key)));
    return (f: { file: string; fingerprint: string }) => others.every((o) => o.has(key(f)));
  };
  const hit = shared((s) => s.hits), unread = shared((s) => s.unscanned);
  return {
    hits: sides[0].hits.filter(hit).map((h) => ({ ...h, commit: commit.hash })),
    unscanned: sides[0].unscanned.filter(unread).map((u) => ({ ...u, commit: commit.hash })),
  };
}

// The scan of the commit a push recorded and every commit of the task behind
// it, against the repository the item is measured against (main's history as
// it is now, see againstMain in src/diff.ts), oldest commit first.
// `forkedFrom`, the commit the item's fork started at, also ends the walk,
// so a task that forked from a commit older than the main history read is
// not taken to add main's older commits. The scan is bound to `head`, the
// commit the Ledger recorded, never to the fork's live head: the fork may
// have moved on since the head was recorded, and a scan of the newer head
// would be applied to the older one's record. The commit is read by its id, and the scan runs only when the
// commit read is that one; a fork that cannot show it (a reader that answers
// with the live head, a commit not reachable) throws, so the scan stays
// pending and is retried rather than clearing or recording anything for the
// wrong head. The head's objects are read from the fork first and from the
// baseline second (pairReader), and any object neither holds throws.
export async function scanCommit(artifacts: Artifacts, baselineRepo: string, workspaceRepo: string, head: string, forkedFrom: string | null = null): Promise<PushScan & { head: string; base: string }> {
  using fork = await artifacts.get(workspaceRepo);
  using baseline = await artifacts.get(baselineRepo);
  const [[commit], history] = await Promise.all([fork.log({ ref: head, limit: 1 }), baseline.log({ limit: MAIN_COMMITS })]);
  if (!commit || commit.hash !== head) throw new Error(`secret scan: ${workspaceRepo} did not show the recorded head ${head.slice(0, 8)}${commit ? ` (read ${commit.hash.slice(0, 8)})` : ""}`);
  const main = history[0];
  if (!main) throw new Error(`secret scan: ${baselineRepo} has no commits to scan against`);
  const onMain = new Set(history.map((c) => c.hash));
  if (forkedFrom) onMain.add(forkedFrom);
  const commits = await taskCommits(fork, commit, onMain);
  // A parent's tree is read from its commit: the task's own from the walk,
  // main's from main's history, any other from the fork by its id.
  const trees = new Map<string, string>([...history, ...commits].map((c) => [c.hash, c.treeHash]));
  for (const c of commits) {
    for (const p of c.parents ?? []) {
      if (trees.has(p)) continue;
      const parent = await fork.readCommit(p);
      if (!parent) throw new Error(`secret scan: ${workspaceRepo} did not show commit ${p.slice(0, 8)}`);
      trees.set(p, parent.treeHash);
    }
  }
  const r = withEmptyTree(pairReader(fork, baseline));
  const scan: PushScan = { hits: [], unscanned: [] };
  for (const c of commits.reverse()) {
    const added = await scanAdded(r, c, trees);
    scan.hits.push(...added.hits);
    scan.unscanned.push(...added.unscanned);
  }
  return { ...scan, head: commit.hash, base: main.hash };
}
