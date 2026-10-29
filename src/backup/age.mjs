// The age v1 file format (https://age-encryption.org/v1), X25519 recipients
// only, with Node's own crypto, so the Studio runs nothing beyond the
// root-owned node it already has, and a backup opens with the standard
// `age` tool as well as with cli/restore.mjs.
//
// - Keys: bech32, "age1..." for a recipient (the X25519 public key) and
//   "AGE-SECRET-KEY-1..." for an identity (the X25519 private scalar), in the
//   key file format age-keygen writes.
// - Header: "age-encryption.org/v1", one "-> X25519" stanza per recipient
//   wrapping a random 16-byte file key (HKDF-SHA256 over the X25519 shared
//   secret, salt = ephemeral share || recipient, info
//   "age-encryption.org/v1/X25519"; ChaCha20-Poly1305 with a zero nonce),
//   then "---" and an HMAC-SHA256 of the header under HKDF(file key, "",
//   "header").
// - Payload: a 16-byte nonce, the payload key HKDF(file key, nonce,
//   "payload"), and STREAM: ChaCha20-Poly1305 over 64 KiB chunks, each nonce
//   an 11-byte big-endian counter and a last-chunk flag.
import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";

const VERSION = "age-encryption.org/v1";
const CHUNK = 64 * 1024;
const TAG = 16;
const ZERO_NONCE = Buffer.alloc(12);

// ---- bech32 (BIP 173) --------------------------------------------------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
const hrpExpand = (hrp) => [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
function convert(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & ((1 << to) - 1)); }
  }
  if (pad && bits) out.push((acc << (to - bits)) & ((1 << to) - 1));
  else if (!pad && (bits >= from || ((acc << (to - bits)) & ((1 << to) - 1)))) throw new Error("bad bech32 padding");
  return out;
}
export function bech32Encode(hrp, bytes) {
  const data = convert(bytes, 8, 5, true);
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const check = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...check].map((d) => CHARSET[d]).join("")}`;
}
// Answers { hrp, bytes } in lower case, or throws. Mixed case is refused.
export function bech32Decode(s) {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Error("bech32 in mixed case");
  const lower = s.toLowerCase();
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) throw new Error("not bech32");
  const hrp = lower.slice(0, sep);
  const data = [...lower.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
  if (data.some((d) => d < 0)) throw new Error("not bech32");
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error("bad bech32 checksum");
  return { hrp, bytes: Buffer.from(convert(data.slice(0, -6), 5, 8, false)) };
}

// ---- Keys ----------------------------------------------------------------

const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const privateFromScalar = (scalar) => createPrivateKey({ key: Buffer.concat([PKCS8_X25519, scalar]), format: "der", type: "pkcs8" });
const publicFromRaw = (raw) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" });
const rawPublic = (key) => Buffer.from(key.export({ format: "jwk" }).x, "base64url");

// The raw 32-byte X25519 public key of an "age1..." recipient.
export function parseRecipient(text) {
  let d;
  try { d = bech32Decode(String(text).trim()); } catch { throw new Error("the backup public key is not an age recipient (age1...)"); }
  if (d.hrp !== "age" || d.bytes.length !== 32 || String(text).trim() !== String(text).trim().toLowerCase()) throw new Error("the backup public key is not an age recipient (age1...)");
  return d.bytes;
}

// An identity from an age key file: the AGE-SECRET-KEY-1 line, # lines and
// blank lines ignored. Answers { privateKey, publicRaw, recipient }.
export function parseIdentity(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length !== 1) throw new Error("the key file must hold one AGE-SECRET-KEY-1... line");
  let d;
  try { d = bech32Decode(lines[0]); } catch { throw new Error("the key file's key is not an age identity (AGE-SECRET-KEY-1...)"); }
  if (d.hrp !== "age-secret-key-" || d.bytes.length !== 32 || lines[0] !== lines[0].toUpperCase()) throw new Error("the key file's key is not an age identity (AGE-SECRET-KEY-1...)");
  const privateKey = privateFromScalar(d.bytes);
  const publicRaw = rawPublic(createPublicKey(privateKey));
  return { privateKey, publicRaw, recipient: bech32Encode("age", publicRaw) };
}

// A new identity, as age-keygen writes it, and its recipient.
export function generateIdentity(now = new Date()) {
  const scalar = randomBytes(32);
  const id = parseIdentity(bech32Encode("age-secret-key-", scalar).toUpperCase());
  const secret = bech32Encode("age-secret-key-", scalar).toUpperCase();
  scalar.fill(0);
  return { recipient: id.recipient, keyFile: `# created: ${now.toISOString().replace(/\.\d{3}Z$/, "Z")}\n# public key: ${id.recipient}\n${secret}\n` };
}

// ---- Primitives -----------------------------------------------------------

const b64 = (buf) => buf.toString("base64").replace(/=+$/, "");
function unb64(s) {
  if (!/^[A-Za-z0-9+/]*$/.test(s)) throw new Error("bad base64");
  const buf = Buffer.from(s, "base64");
  if (b64(buf) !== s) throw new Error("non-canonical base64");
  return buf;
}
const hkdf = (ikm, salt, info) => Buffer.from(hkdfSync("sha256", ikm, salt, info, 32));
function seal(key, nonce, plain) {
  const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG });
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
function unseal(key, nonce, sealed) {
  if (sealed.length < TAG) throw new Error("short ciphertext");
  const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG });
  d.setAuthTag(sealed.subarray(sealed.length - TAG));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
}
function streamNonce(counter, last) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(counter), 3);
  n[11] = last ? 1 : 0;
  return n;
}
const X25519_INFO = "age-encryption.org/v1/X25519";
function shared(privateKey, publicRaw) {
  const s = diffieHellman({ privateKey, publicKey: publicFromRaw(publicRaw) });
  if (s.every((b) => b === 0)) throw new Error("the X25519 share gives an all-zero secret");
  return s;
}
// A stanza body: base64 wrapped at 64 columns, the last line shorter than 64
// (empty when the length is a multiple of 64).
function wrapBody(buf) {
  const s = b64(buf);
  const lines = [];
  for (let i = 0; i <= s.length; i += 64) lines.push(s.slice(i, i + 64));
  if (lines.at(-1).length === 64) lines.push("");
  return lines.join("\n");
}

// ---- Encrypt and decrypt ---------------------------------------------------

// Encrypts the file at `input` to `output` (created, mode 600) for the age
// recipient "age1...".
export async function encryptFile(input, output, recipientText) {
  const recipient = parseRecipient(recipientText);
  const fileKey = randomBytes(16);
  const eph = randomBytes(32);
  const ephKey = privateFromScalar(eph);
  const share = rawPublic(createPublicKey(ephKey));
  const wrapKey = hkdf(shared(ephKey, recipient), Buffer.concat([share, recipient]), X25519_INFO);
  const body = seal(wrapKey, ZERO_NONCE, fileKey);
  const headerNoMac = `${VERSION}\n-> X25519 ${b64(share)}\n${wrapBody(body)}\n---`;
  const mac = createHmac("sha256", hkdf(fileKey, Buffer.alloc(0), "header")).update(headerNoMac).digest();
  const nonce = randomBytes(16);
  const payloadKey = hkdf(fileKey, nonce, "payload");
  const src = await open(input, "r");
  const dst = await open(output, "wx", 0o600);
  try {
    await dst.write(Buffer.from(`${headerNoMac} ${b64(mac)}\n`, "ascii"));
    await dst.write(nonce);
    const { size } = await src.stat();
    let counter = 0, pos = 0;
    for (;;) {
      const len = Math.min(CHUNK, size - pos);
      const buf = Buffer.alloc(len);
      if (len && (await src.read(buf, 0, len, pos)).bytesRead !== len) throw new Error("the archive changed while it was encrypted");
      pos += len;
      const last = pos >= size;
      await dst.write(seal(payloadKey, streamNonce(counter++, last), buf));
      if (last) break;
    }
    await dst.sync();
  } finally {
    await src.close(); await dst.close();
    for (const b of [fileKey, eph, wrapKey, payloadKey]) b.fill(0);
  }
}

// Reads and checks the header: answers { fileKey, end } where `end` is the
// offset of the payload nonce.
function openHeader(head) {
  const text = head.toString("latin1");
  const lines = [];
  let at = 0;
  for (;;) {
    const nl = text.indexOf("\n", at);
    if (nl < 0) throw new Error("the file is not an age file, or its header is cut short");
    const line = text.slice(at, nl);
    if (line.startsWith("---")) {
      // "--- " and the MAC: 32 bytes, base64 without padding (43 characters).
      if (!/^--- [A-Za-z0-9+/]{43}$/.test(line)) throw new Error("the age header's MAC line is malformed");
      return { lines, macLine: line, macStart: at, end: nl + 1 };
    }
    lines.push(line);
    at = nl + 1;
    if (lines.length > 1000) throw new Error("the age header is too long");
  }
}

export async function decryptFile(input, output, identityText) {
  const identity = typeof identityText === "string" ? parseIdentity(identityText) : identityText;
  const src = await open(input, "r");
  let dst;
  try {
    const { size } = await src.stat();
    const head = Buffer.alloc(Math.min(size, 64 * 1024));
    await src.read(head, 0, head.length, 0);
    if (!head.subarray(0, VERSION.length + 1).equals(Buffer.from(`${VERSION}\n`))) throw new Error("the file is not an age v1 file");
    const { lines, macLine, macStart, end } = openHeader(head);
    if (lines[0] !== VERSION) throw new Error("the file is not an age v1 file");
    // The stanzas: each "-> TYPE ARGS" and its body lines, the last shorter
    // than 64 columns.
    // Every stanza is checked against the spec's grammar, unknown types
    // included, before any recipient is tried: arguments of one or more
    // VCHARs (0x21 to 0x7E) separated by single spaces, a body of canonical
    // base64 without padding in lines of 64 characters ending with a
    // shorter one.
    const stanzas = [];
    if (lines.length < 2) throw new Error("the age header holds no recipient stanza");
    for (let i = 1; i < lines.length;) {
      if (!lines[i].startsWith("-> ")) throw new Error("the age header is malformed");
      const args = lines[i].slice(3).split(" ");
      if (args.some((a) => !/^[\x21-\x7e]+$/.test(a))) throw new Error("a stanza argument of the age header is not VCHARs separated by single spaces");
      const body = [];
      for (i++; ; i++) {
        if (i >= lines.length) throw new Error("the age header is malformed");
        if (!/^[A-Za-z0-9+/]*$/.test(lines[i]) || lines[i].length > 64) throw new Error("a stanza body line of the age header is not base64 of at most 64 columns");
        body.push(lines[i]);
        if (lines[i].length < 64) { i++; break; }
      }
      stanzas.push({ args, body: unb64(body.join("")) });
    }
    let fileKey = null;
    for (const s of stanzas) {
      if (s.args[0] !== "X25519") continue;
      if (s.args.length !== 2 || s.body.length !== 32 || s.args[1].length !== 43) throw new Error("an X25519 stanza is malformed");
      const share = unb64(s.args[1]);
      if (share.length !== 32) throw new Error("an X25519 stanza is malformed");
      const wrapKey = hkdf(shared(identity.privateKey, share), Buffer.concat([share, identity.publicRaw]), X25519_INFO);
      try { fileKey = unseal(wrapKey, ZERO_NONCE, s.body); break; } catch { /* another recipient's */ }
    }
    if (!fileKey) throw new Error("the backup was not encrypted to this key");
    const mac = unb64(macLine.slice(4));
    const want = createHmac("sha256", hkdf(fileKey, Buffer.alloc(0), "header")).update(head.subarray(0, macStart + 3)).digest();
    if (mac.length !== 32 || !timingSafeEqual(mac, want)) throw new Error("the age header's MAC does not match: the header was changed");
    if (size < end + 16 + TAG) throw new Error("the backup is cut short");
    const nonce = Buffer.alloc(16);
    await src.read(nonce, 0, 16, end);
    const payloadKey = hkdf(fileKey, nonce, "payload");
    dst = await open(output, "wx", 0o600);
    let pos = end + 16, counter = 0;
    for (;;) {
      const len = Math.min(CHUNK + TAG, size - pos);
      const buf = Buffer.alloc(len);
      await src.read(buf, 0, len, pos);
      pos += len;
      const last = pos === size;
      if (last && len === TAG && counter > 0) throw new Error("the backup ends in an empty chunk, which age does not write");
      let plain;
      try { plain = unseal(payloadKey, streamNonce(counter++, last), buf); } catch {
        throw new Error(`the backup does not open at chunk ${counter}: it was changed or cut short`);
      }
      await dst.write(plain);
      if (last) break;
    }
  } finally { await src.close(); await dst?.close(); }
}
