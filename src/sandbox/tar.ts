// A minimal POSIX tar writer. The check runner streams an item's tree from
// Artifacts into `tar -x` inside the container, so the container needs neither
// git nor a token: the Worker reads the repository and the container only
// unpacks bytes.

export interface TarEntry {
  path: string;
  mode: number;            // permission bits, e.g. 0o644 or 0o755
  kind: "file" | "symlink";
  data?: Uint8Array;       // file contents
  target?: string;         // symlink target
}

const BLOCK = 512;
const enc = new TextEncoder();

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function put(h: Uint8Array, offset: number, width: number, s: string) {
  const b = enc.encode(s);
  h.set(b.subarray(0, width), offset);
}

function header(name: string, size: number, mode: number, type: string, linkname = "", prefix = ""): Uint8Array {
  const h = new Uint8Array(BLOCK);
  put(h, 0, 100, name);
  put(h, 100, 8, octal(mode & 0o7777, 8));
  put(h, 108, 8, octal(0, 8));
  put(h, 116, 8, octal(0, 8));
  put(h, 124, 12, octal(size, 12));
  put(h, 136, 12, octal(0, 12));
  h.fill(0x20, 148, 156); // checksum is computed with its own field as spaces
  put(h, 156, 1, type);
  put(h, 157, 100, linkname);
  put(h, 257, 6, "ustar\0");
  put(h, 263, 2, "00");
  put(h, 345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  put(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

function padding(size: number): Uint8Array {
  const rest = size % BLOCK;
  return new Uint8Array(rest ? BLOCK - rest : 0);
}

// A pax record is "<len> <key>=<value>\n", where <len> counts its own digits.
function paxRecord(key: string, value: string): Uint8Array {
  const body = enc.encode(` ${key}=${value}\n`).length;
  let len = body + 1;
  while (String(len).length + body !== len) len = String(len).length + body;
  return enc.encode(`${len} ${key}=${value}\n`);
}

// Fit a path into ustar's 100-byte name and 155-byte prefix, split at a slash.
function splitPath(path: string): { name: string; prefix: string } | null {
  if (enc.encode(path).length <= 100) return { name: path, prefix: "" };
  for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i), name = path.slice(i + 1);
    if (enc.encode(prefix).length <= 155 && enc.encode(name).length <= 100 && name) return { name, prefix };
  }
  return null;
}

export function safePath(path: string): boolean {
  return !!path && !path.startsWith("/") && !path.split("/").some((p) => p === ".." || p === "." || p === "");
}

// The bytes of one entry: an optional pax header for long names, the ustar
// header, the data and its padding.
export function entryBytes(e: TarEntry): Uint8Array[] {
  if (!safePath(e.path)) throw new Error(`unsafe path in tree: ${e.path}`);
  const out: Uint8Array[] = [];
  const split = splitPath(e.path);
  const longLink = e.kind === "symlink" && enc.encode(e.target ?? "").length > 100;
  if (!split || longLink) {
    const records = [...(split ? [] : [paxRecord("path", e.path)]), ...(longLink ? [paxRecord("linkpath", e.target!)] : [])];
    const size = records.reduce((n, r) => n + r.length, 0);
    out.push(header("PaxHeader", size, 0o644, "x"), ...records, padding(size));
  }
  const { name, prefix } = split ?? { name: e.path.slice(-100), prefix: "" };
  if (e.kind === "symlink") {
    out.push(header(name, 0, e.mode, "2", longLink ? "" : e.target ?? "", prefix));
  } else {
    const data = e.data ?? new Uint8Array();
    out.push(header(name, data.length, e.mode, "0", "", prefix), data, padding(data.length));
  }
  return out;
}

export const END_OF_ARCHIVE = new Uint8Array(BLOCK * 2);
