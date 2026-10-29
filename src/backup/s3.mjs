// An S3 API client for the nightly backups (Atelier 2.0, task 12): put, get,
// list and delete of objects in one bucket, path-style, each request signed
// with AWS Signature Version 4 by Node's own crypto, so no dependency is
// needed. Cloudflare R2 speaks this API at https://ACCOUNT.r2.cloudflarestorage.com
// with the region "auto".
//
// No credential leaves this module except in the Authorization header of a
// request to the endpoint it was given. Errors name the method, the key and
// the S3 error code, never a header or a signature.
import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// RFC 3986 encoding as SigV4 wants it: every byte but the unreserved ones.
export function uriEncode(s, keepSlash = false) {
  let out = "";
  for (const byte of Buffer.from(String(s), "utf8")) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const sha256hex = (data) => createHash("sha256").update(data).digest("hex");

// The headers that sign one request: { authorization, "x-amz-date",
// "x-amz-content-sha256" }. `host` is the endpoint's host[:port]; `path` the
// request path exactly as sent, already encoded: S3 signs it as it is, with
// no normalisation, so a key holding "." or ".." segments stays that key.
// `query` is a plain object; `payloadHash` the hex SHA-256 of the body.
export function signV4({ method, host, path, query = {}, payloadHash = EMPTY_SHA256, accessKeyId, secretAccessKey, region = "auto", service = "s3", now = new Date() }) {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const canonicalQuery = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join("&");
  const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonical = [method, path, canonicalQuery,
    Object.keys(headers).sort().map((k) => `${k}:${headers[k]}\n`).join(""), signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };
}

// The values of every <TAG>...</TAG> in an XML text, unescaped.
function tags(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  for (let m; (m = re.exec(xml));) out.push(m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"));
  return out;
}

export class S3Client {
  #accessKeyId;
  #secretAccessKey;

  // endpoint: https://HOST (http only for a loopback address, as a test's
  // stub is); bucket: the bucket's name.
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey, region = "auto" }) {
    let u;
    try { u = new URL(endpoint); } catch { throw new Error("the R2 endpoint is not a URL"); }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) throw new Error("the R2 endpoint must be https");
    if (u.pathname !== "/" || u.search) throw new Error("the R2 endpoint is a bare origin, https://ACCOUNT.r2.cloudflarestorage.com");
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? "")) throw new Error("the R2 bucket name is not a bucket name");
    if (!accessKeyId || !secretAccessKey) throw new Error("the R2 access key id and secret are both needed");
    this.origin = u.origin;
    this.host = u.host;
    this.hostname = u.hostname.replace(/^\[|\]$/g, "");
    this.port = u.port || undefined;
    this.protocol = u.protocol;
    this.bucket = bucket;
    this.region = region;
    this.#accessKeyId = accessKeyId;
    this.#secretAccessKey = secretAccessKey;
  }

  // The request path: the bucket, then the key byte for byte, every byte
  // but the unreserved ones and "/" percent-encoded. It is never passed
  // through a URL parser, which would resolve "." and ".." segments.
  #path(key) { return `/${this.bucket}${key === undefined ? "" : `/${uriEncode(key, true)}`}`; }

  // One signed request. body: a file path to stream (with its hash given) or
  // nothing. Resolves to { status, headers, res } with the response unread
  // when `stream`, else { status, headers, text }.
  #send(method, key, { query = {}, file, payloadHash, stream = false } = {}) {
    if (key !== undefined && (typeof key !== "string" || !key)) throw new Error("an object key is a non-empty string");
    const path = this.#path(key);
    const signed = signV4({ method, host: this.host, path, query, payloadHash: payloadHash ?? EMPTY_SHA256, accessKeyId: this.#accessKeyId, secretAccessKey: this.#secretAccessKey, region: this.region });
    const qs = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join("&");
    const headers = { ...signed };
    if (file) headers["content-length"] = String(statSync(file).size);
    else if (method === "PUT") headers["content-length"] = "0";
    const request = this.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = request({ method, hostname: this.hostname, port: this.port, path: `${path}${qs ? `?${qs}` : ""}`, headers, timeout: 600_000 }, (res) => {
        if (stream && res.statusCode === 200) return resolve({ status: res.statusCode, headers: res.headers, res });
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error(`${method} timed out`)));
      req.on("error", (err) => reject(new Error(`${method} ${key ?? this.bucket} failed: ${err.message}`)));
      if (file) createReadStream(file).on("error", (e) => req.destroy(e)).pipe(req);
      else req.end();
    });
  }

  #fail(method, key, r) {
    const code = tags(r.text ?? "", "Code")[0];
    return new Error(`${method} ${key ?? this.bucket} answered ${r.status}${code ? ` ${code}` : ""}`);
  }

  // Uploads a file whose hex SHA-256 is `sha256`.
  async put(key, file, sha256) {
    const r = await this.#send("PUT", key, { file, payloadHash: sha256 });
    if (r.status !== 200) throw this.#fail("PUT", key, r);
  }

  // Downloads an object to a file.
  async get(key, file) {
    const r = await this.#send("GET", key, { stream: true });
    if (r.status !== 200) throw this.#fail("GET", key, r);
    await pipeline(r.res, createWriteStream(file, { mode: 0o600, flags: "wx" }));
  }

  // Every object under a prefix: [{ key, lastModified: Date, size }].
  async list(prefix) {
    const out = [];
    let token;
    for (;;) {
      const query = { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) };
      const r = await this.#send("GET", undefined, { query });
      if (r.status !== 200) throw this.#fail("LIST", prefix, r);
      for (const block of tags(r.text, "Contents")) {
        out.push({ key: tags(block, "Key")[0], lastModified: new Date(tags(block, "LastModified")[0]), size: Number(tags(block, "Size")[0]) });
      }
      if (tags(r.text, "IsTruncated")[0] !== "true") return out;
      token = tags(r.text, "NextContinuationToken")[0];
      if (!token) throw new Error(`LIST ${prefix} was truncated with no continuation token`);
    }
  }

  async delete(key) {
    const r = await this.#send("DELETE", key);
    if (r.status !== 204 && r.status !== 200) throw this.#fail("DELETE", key, r);
  }
}
