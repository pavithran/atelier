// The LARGE binding on the Node server (Atelier 2.0, task 4): the R2 calls
// src/large.ts makes (put and get of a text under a key), kept as files under
// DIR, mode 600. A key's segments are encoded, so no key names a file outside
// DIR.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const segment = (s) => encodeURIComponent(s).replace(/\./g, "%2E");

export class LocalLarge {
  #dir;

  constructor(dir) { this.#dir = dir; }

  #path(key) {
    const parts = String(key).split("/");
    if (parts.some((p) => !p)) throw new Error(`not a stored key: ${String(key).slice(0, 80)}`);
    return join(this.#dir, ...parts.map(segment));
  }

  // Writes beside the file and renames over it, so a reader sees all or none.
  async put(key, value) {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, path);
    return { key, size: bytes.length };
  }

  async get(key) {
    const path = this.#path(key);
    let bytes;
    try { bytes = await readFile(path); } catch (err) { if (err.code === "ENOENT") return null; throw err; }
    return { key, size: bytes.length, text: async () => bytes.toString("utf8"), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  }
}
