// Public-key encryption of a backup archive (Atelier 2.0, task 12), with
// Node's own crypto, so the Studio runs nothing beyond the root-owned node
// it already has. The construction is age's, in its parts:
//
// - X25519: a fresh key pair per file; the shared secret is the ephemeral
//   private key with the recipient's public key, which only the holder of the
//   recipient's private key can compute again.
// - HKDF-SHA256 turns it into a 256-bit key, salted with both public keys and
//   bound to the whole header, so a changed header gives another key.
// - AES-256-GCM in 64 KiB chunks. Each chunk's nonce is its number and a
//   flag for the last chunk, so chunks cannot be reordered, dropped,
//   repeated or cut off at the end without a chunk failing to open.
//
// File: MAGIC, the ephemeral public key (32 bytes), the recipient's public
// key (32 bytes, to say "encrypted to another key" plainly), then the chunks,
// each its ciphertext and a 16-byte tag.
//
// Keys are PEM: `openssl genpkey -algorithm X25519 -out backup.key` and
// `openssl pkey -in backup.key -pubout -out backup.pub` make a pair, as does
// generateKeys() here. The private key may be a passphrase-encrypted PKCS#8.
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";

export const MAGIC = Buffer.from("ATELIER-BACKUP-X25519-1\n", "ascii");
const CHUNK = 64 * 1024;
const TAG = 16;
const HEADER = MAGIC.length + 64;

function rawPublic(key) {
  const jwk = key.export({ format: "jwk" });
  if (jwk.crv !== "X25519") throw new Error("the backup key is not an X25519 key");
  return Buffer.from(jwk.x, "base64url");
}
const fromRaw = (raw) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" });

export function publicKeyOf(pem) {
  let key;
  try { key = createPublicKey(pem); } catch { throw new Error("the backup public key is not a PEM public key"); }
  if (key.asymmetricKeyType !== "x25519") throw new Error("the backup public key is not an X25519 key");
  return key;
}

export function privateKeyOf(pem, passphrase) {
  let key;
  try { key = createPrivateKey(passphrase === undefined ? pem : { key: pem, passphrase }); } catch (e) {
    throw new Error(/ENCRYPTED PRIVATE KEY/.test(String(pem)) || /passphrase|decrypt|interrupted/i.test(e.message) ? "the private key needs its passphrase (--passphrase-file), or the one given is wrong" : "the private key is not a PEM private key");
  }
  if (key.asymmetricKeyType !== "x25519") throw new Error("the private key is not an X25519 key");
  return key;
}

export function generateKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { publicKey: publicKey.export({ type: "spki", format: "pem" }), privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

function fileKey(shared, header) {
  if (shared.every((b) => b === 0)) throw new Error("the key agreement gave an all-zero secret");
  return Buffer.from(hkdfSync("sha256", shared, header.subarray(MAGIC.length), header, 32));
}

function nonce(counter, last) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(counter), 3);
  n[11] = last ? 1 : 0;
  return n;
}

// Encrypts the file at `input` to `output` (created, mode 600) for the
// holder of the private key matching `publicKeyPem`.
export async function encryptFile(input, output, publicKeyPem) {
  const recipient = publicKeyOf(publicKeyPem);
  const eph = generateKeyPairSync("x25519");
  const header = Buffer.concat([MAGIC, rawPublic(eph.publicKey), rawPublic(recipient)]);
  const key = fileKey(diffieHellman({ privateKey: eph.privateKey, publicKey: recipient }), header);
  const src = await open(input, "r");
  const dst = await open(output, "wx", 0o600);
  try {
    await dst.write(header);
    const { size } = await src.stat();
    let counter = 0, pos = 0;
    do {
      const len = Math.min(CHUNK, size - pos);
      const buf = Buffer.alloc(len);
      if (len) {
        const { bytesRead } = await src.read(buf, 0, len, pos);
        if (bytesRead !== len) throw new Error("the archive changed while it was encrypted");
      }
      pos += len;
      const last = pos >= size;
      const c = createCipheriv("aes-256-gcm", key, nonce(counter++, last));
      await dst.write(Buffer.concat([c.update(buf), c.final(), c.getAuthTag()]));
      if (last) break;
    } while (true);
    await dst.sync();
  } finally { await src.close(); await dst.close(); key.fill(0); }
}

// Decrypts `input` to `output` (created, mode 600) with the private key.
// Throws, and leaves a partial output to the caller to remove, on any chunk
// that does not open.
export async function decryptFile(input, output, privateKey) {
  const src = await open(input, "r");
  let dst;
  try {
    const { size } = await src.stat();
    const header = Buffer.alloc(HEADER);
    if (size < HEADER + TAG || (await src.read(header, 0, HEADER, 0)).bytesRead !== HEADER || !header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error("the file is not an Atelier backup");
    }
    const mine = rawPublic(createPublicKey(privateKey));
    if (!timingSafeEqual(mine, header.subarray(MAGIC.length + 32))) throw new Error("the backup was encrypted to another key than this private key");
    const key = fileKey(diffieHellman({ privateKey, publicKey: fromRaw(header.subarray(MAGIC.length, MAGIC.length + 32)) }), header);
    dst = await open(output, "wx", 0o600);
    let pos = HEADER, counter = 0;
    try {
      for (;;) {
        const len = Math.min(CHUNK + TAG, size - pos);
        if (len < TAG) throw new Error("the backup is cut short");
        const buf = Buffer.alloc(len);
        await src.read(buf, 0, len, pos);
        pos += len;
        const last = pos === size;
        const d = createDecipheriv("aes-256-gcm", key, nonce(counter++, last));
        d.setAuthTag(buf.subarray(len - TAG));
        let plain;
        try { plain = Buffer.concat([d.update(buf.subarray(0, len - TAG)), d.final()]); } catch {
          throw new Error(`the backup does not open at chunk ${counter}: it was changed, cut short, or not made for this key`);
        }
        await dst.write(plain);
        if (last) break;
      }
    } finally { key.fill(0); }
  } finally { await src.close(); await dst?.close(); }
}
