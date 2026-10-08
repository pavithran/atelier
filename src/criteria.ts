// The acceptance criteria a review is bound to. A task's criteria (Item.accept)
// and, for a part of a plan, the approved part's acceptance list are what a
// reviewer judges the change against, so a verdict stands only for the
// criteria it was given: the review claim captures their hash from the same
// lists its brief carries, the review names that hash when it is recorded,
// and the gate counts a review only while its head and its hash are the
// task's own (standingReview in src/rules.ts).
//
// The hash is SHA-256 over the stored lists, in order, as JSON, so the text,
// the order and where one entry ends and the next begins all change it. A
// missing list and an empty one hash alike: a task with no criteria field and
// one with `accept: []` ask the same thing. A part's binding names both lists,
// so it never equals an ordinary task's. It is computed synchronously, since
// the Ledger's methods are, and Workers' crypto.subtle is not.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// The hex SHA-256 of a text's UTF-8 bytes.
export function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text);
  const bits = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

// The binding of a task's criteria, and of a part's approved acceptance list
// beside them when it is a part. `partAccept` is null or absent for an
// ordinary task.
export function criteriaHash(accept?: readonly string[] | null, partAccept?: readonly string[] | null): string {
  const task = [...(accept ?? [])];
  return sha256Hex(JSON.stringify(partAccept ? ["atelier-criteria/1", task, [...partAccept]] : ["atelier-criteria/1", task]));
}

// The binding of a task with no criteria, and of one whose list is empty.
export const NO_CRITERIA = criteriaHash([]);

// An item's binding, from its stored lists.
export function criteriaOf(item: { accept?: readonly string[] | null; partAccept?: readonly string[] | null }): string {
  return criteriaHash(item.accept, item.partAccept);
}

// Whether two stored lists are the same criteria: the same entries in the
// same order. A missing list is the empty one.
export function sameCriteria(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const x = a ?? [], y = b ?? [];
  return x.length === y.length && x.every((c, i) => c === y[i]);
}

// A binding as a review names it: 64 hex digits.
export const validBinding = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
