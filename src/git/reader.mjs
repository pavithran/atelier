import { gitCommand } from "./command.mjs";
// A reader over one bare repository (Atelier 2.0, task 4; design section
// 4.2): the calls src/diff.ts and the modules beside it make (info, log,
// readCommit, readTree, readBlob, readFile), answered from Git itself.
// Objects come through one `git cat-file --batch` process, started on the
// first read and killed on dispose; the history comes from `git rev-list`.
import { execFile, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LOG_DEFAULT = 50;
const LOG_MAX = 1000;
const TYPES = { html: "text/html", css: "text/css", js: "text/javascript", json: "application/json", md: "text/markdown", txt: "text/plain", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" };

const NUMERIC = { NOT_FOUND: 10000, INVALID_INPUT: 10001, INTERNAL_ERROR: 10002 };

// An error with a `code` the callers test.
export function repoError(code, message) {
  return Object.assign(new Error(message), { name: "RepoError", code, numericCode: NUMERIC[code] ?? 0 });
}

function checkHash(hash) {
  if (typeof hash !== "string" || !HASH.test(hash)) throw repoError("INVALID_INPUT", `not an object id: ${String(hash).slice(0, 80)}`);
}

// One `git cat-file --batch` process. Requests are answered in order, so they
// are queued; a missing object answers null.
// The most a single object read buffers; a larger one fails with
// MEMORY_LIMIT.
export const OBJECT_MAX = 64 * 1024 * 1024;
const HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) (blob|tree|commit|tag) (\d+)$/;

class Batch {
  #proc;
  #buf = Buffer.alloc(0);
  #wake = null;
  #end = null;
  #chain = Promise.resolve();

  constructor(dir, env) {
    this.#proc = spawn(gitCommand(), ["cat-file", "--batch"], { cwd: dir, env, stdio: ["pipe", "pipe", "ignore"] });
    this.#proc.stdout.on("data", (d) => { this.#buf = this.#buf.length ? Buffer.concat([this.#buf, d]) : d; this.#settle(); });
    const ended = (err) => { this.#end ??= err ?? new Error("git cat-file ended"); this.#settle(); };
    this.#proc.on("error", ended);
    this.#proc.on("close", () => ended());
    this.#proc.stdin.on("error", () => {});
  }

  #settle() {
    const w = this.#wake;
    this.#wake = null;
    if (w) w();
  }

  async #more() {
    if (this.#end) throw this.#end;
    await new Promise((ok) => { this.#wake = ok; });
    if (this.#end && !this.#buf.length) throw this.#end;
  }

  async #line() {
    for (;;) {
      const i = this.#buf.indexOf(10);
      if (i >= 0) {
        const line = this.#buf.toString("utf8", 0, i);
        this.#buf = this.#buf.subarray(i + 1);
        return line;
      }
      await this.#more();
    }
  }

  // Reads past n bytes, keeping none.
  async #skip(n) {
    let left = n;
    while (left > 0) {
      if (!this.#buf.length) await this.#more();
      const take = Math.min(left, this.#buf.length);
      this.#buf = this.#buf.subarray(take);
      left -= take;
    }
  }

  // n bytes, gathered as chunks and joined once.
  async #bytes(n) {
    const chunks = [];
    let have = 0;
    while (have < n) {
      if (!this.#buf.length) await this.#more();
      const take = this.#buf.subarray(0, n - have);
      chunks.push(take);
      have += take.length;
      this.#buf = this.#buf.subarray(take.length);
    }
    return Buffer.concat(chunks, n);
  }

  // { type, bytes } for an object or an expression `REV:PATH`, null if missing.
  read(spec) {
    const run = async () => {
      if (this.#end) throw this.#end;
      this.#proc.stdin.write(`${spec}\n`);
      // A missing object answers "SPEC missing" (or "ambiguous"), and SPEC
      // may hold spaces; only a well-formed header is followed by a body.
      const line = await this.#line();
      const m = HEADER.exec(line);
      if (!m) {
        if (line.endsWith(" missing") || line.endsWith(" ambiguous")) return null;
        throw repoError("INTERNAL_ERROR", `git cat-file answered ${line.slice(0, 80)}`);
      }
      const size = Number(m[3]);
      if (size > OBJECT_MAX) {
        await this.#skip(size + 1);
        throw repoError("MEMORY_LIMIT", `object ${m[1].slice(0, 12)} is ${size} bytes, over the ${OBJECT_MAX} read limit`);
      }
      const bytes = await this.#bytes(size + 1);
      return { type: m[2], oid: m[1], bytes: bytes.subarray(0, size) };
    };
    const next = this.#chain.then(run, run);
    this.#chain = next.catch(() => {});
    return next;
  }

  kill() {
    this.#end ??= new Error("the repository reader was disposed");
    this.#proc.stdin.end();
    this.#proc.kill();
    this.#settle();
  }
}

const ident = (s) => {
  const m = /^(.*) <([^<>]*)> (-?\d+) [+-]\d{4}$/.exec(s ?? "");
  return m ? { name: m[1], email: m[2], at: Number(m[3]) } : { name: "", email: "", at: 0 };
};

export function parseCommit(hash, bytes) {
  const text = bytes.toString("utf8");
  const cut = text.indexOf("\n\n");
  const lines = (cut < 0 ? text : text.slice(0, cut)).split("\n");
  let message = cut < 0 ? "" : text.slice(cut + 2);
  if (message.endsWith("\n")) message = message.slice(0, -1);
  let treeHash = "", author, committer;
  const parents = [];
  for (const line of lines) {
    if (line.startsWith(" ")) continue;
    const sp = line.indexOf(" ");
    const key = line.slice(0, sp), value = line.slice(sp + 1);
    if (key === "tree") treeHash = value;
    else if (key === "parent") parents.push(value);
    else if (key === "author") author ??= ident(value);
    else if (key === "committer") committer ??= ident(value);
  }
  author ??= ident(), committer ??= ident();
  return {
    hash, treeHash, message,
    author: { name: author.name, email: author.email },
    committer: { name: committer.name, email: committer.email },
    parents, authoredAt: author.at, committedAt: committer.at,
  };
}

function entryType(mode) {
  if (mode === "40000") return "tree";
  if (mode === "120000") return "symlink";
  if (mode === "160000") return "gitlink";
  return parseInt(mode, 8) & 0o111 ? "exec" : "blob";
}

export function parseTree(bytes, width) {
  const out = [];
  for (let at = 0; at < bytes.length;) {
    const sp = bytes.indexOf(32, at), nul = bytes.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + width >= bytes.length) throw repoError("INTERNAL_ERROR", "not a valid tree");
    const mode = bytes.toString("latin1", at, sp);
    out.push({ name: bytes.toString("utf8", sp + 1, nul), mode, hash: bytes.toString("hex", nul + 1, nul + 1 + width), type: entryType(mode) });
    at = nul + 1 + width;
  }
  return out;
}

function typeOf(path) {
  return TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
}

function revList(dir, args) {
  return new Promise((ok, fail) => {
    execFile(gitCommand(), ["rev-list", ...args], { cwd: dir, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (!err) return ok(stdout.split("\n").filter(Boolean));
      // A ref that does not resolve is an empty history.
      if (err.code === 128) return ok([]);
      fail(repoError("INTERNAL_ERROR", `git rev-list failed: ${String(err.message).slice(0, 200)}`));
    });
  });
}

// `dir`: the bare repository. `onDispose`: called once, when the reader is
// disposed, so its owner stops tracking it.
// env: the environment its Git runs with; the pre-receive hook passes its
// own, which names the push's quarantined objects.
// head: the ref a log with no ref reads, HEAD unless named; a task's
// workspace (src/git/local-repos.mjs) names refs/heads/t/N.
export function openReader(dir, { name = basename(dir, ".git"), onDispose, env, head: headRef = "HEAD" } = {}) {
  let batch = null, disposed = false;
  const objects = () => {
    if (disposed) throw repoError("INTERNAL_ERROR", "the repository reader was disposed");
    return batch ??= new Batch(dir, env);
  };
  const width = (oid) => oid.length / 2;

  async function readCommit(hash) {
    checkHash(hash);
    const o = await objects().read(hash);
    if (!o) return null;
    if (o.type !== "commit") throw repoError("INTERNAL_ERROR", "not a valid commit");
    return parseCommit(o.oid, o.bytes);
  }

  return {
    async info() {
      const [head, made] = await Promise.all([readFile(`${dir}/HEAD`, "utf8").catch(() => ""), stat(dir).catch(() => null)]);
      if (!made) throw repoError("NOT_FOUND", `repository not found: ${name}`);
      return {
        id: name, name, description: null,
        defaultBranch: /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1] ?? "main",
        createdAt: made.birthtime.toISOString(), updatedAt: made.mtime.toISOString(), lastPushAt: null,
        source: null, readOnly: false, remote: `file://${dir}`,
      };
    },

    async log({ ref, limit = LOG_DEFAULT, offset = 0 } = {}) {
      const max = Math.min(LOG_MAX, Math.max(0, Math.floor(limit)));
      const skip = Math.max(0, Math.floor(offset));
      const start = ref ?? headRef;
      if (!max || /^-|[\0\n]/.test(start)) return [];
      const hashes = await revList(dir, ["--first-parent", `--skip=${skip}`, `--max-count=${max}`, "--end-of-options", start, "--"]);
      const out = [];
      for (const h of hashes) out.push(await readCommit(h));
      return out.filter(Boolean);
    },

    readCommit,

    async verifyRegeneration(oldHead, main, newHead) {
      for (const hash of [oldHead, main, newHead]) checkHash(hash);
      const { verifyRegeneration } = await import("./regeneration.mjs");
      return verifyRegeneration(dir, oldHead, main, newHead);
    },

    async readTree(hash) {
      checkHash(hash);
      const o = await objects().read(hash);
      if (!o) return null;
      if (o.type !== "tree") throw repoError("INTERNAL_ERROR", "not a valid tree");
      return parseTree(o.bytes, width(o.oid));
    },

    async readBlob(hash) {
      checkHash(hash);
      const o = await objects().read(hash);
      return o?.type === "blob" ? new Blob([o.bytes]) : null;
    },

    async readFile({ ref, path } = {}) {
      if (!ref || !path) throw repoError("INVALID_INPUT", "ref and path are required");
      if (/^-|[\0\n]/.test(ref) || /[\0\n]/.test(path)) return null;
      const o = await objects().read(`${ref}:${path}`);
      return o?.type === "blob" ? new Blob([o.bytes], { type: typeOf(path) }) : null;
    },

    [Symbol.dispose]() {
      if (disposed) return;
      disposed = true;
      batch?.kill();
      onDispose?.();
    },
  };
}
