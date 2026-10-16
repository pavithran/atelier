// A baseline served over HTTP as Artifacts serves one, for tests whose
// credentials matter (clone, pull): f.root holds the bare repositories, and
// f.http = { valid: Set of tokens, sent: [] } records every request's tokens.
import { spawn } from "node:child_process";

// git http-backend behind a check of the Authorization header, as Artifacts
// serves a baseline: a request is served only when every Authorization
// header it carries holds a token in `valid`, and at least one does.
export function serveGit(req, res, f) {
  const url = new URL(req.url, "http://localhost");
  const tokens = (req.headersDistinct.authorization ?? []).map((h) => h.replace(/^Bearer /, ""));
  f.http.sent.push(tokens);
  if (!tokens.length || tokens.some((token) => !f.http.valid.has(token))) { res.writeHead(401); res.end(); return; }
  const child = spawn("git", ["http-backend"], { env: {
    PATH: process.env.PATH, HOME: f.root, GIT_CONFIG_NOSYSTEM: "1", GIT_PROJECT_ROOT: f.root, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "owner", REMOTE_ADDR: "127.0.0.1",
    REQUEST_METHOD: req.method, PATH_INFO: decodeURIComponent(url.pathname.slice("/git".length)), QUERY_STRING: url.search.slice(1),
    CONTENT_TYPE: req.headers["content-type"] ?? "", GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
    ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
    ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
  } });
  req.pipe(child.stdin);
  let head = Buffer.alloc(0), started = false;
  child.stdout.on("data", (chunk) => {
    if (started) { res.write(chunk); return; }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) return;
    started = true;
    let status = 200;
    const headers = {};
    for (const line of head.subarray(0, end).toString().split("\r\n")) {
      const at = line.indexOf(":"), name = line.slice(0, at), value = line.slice(at + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10); else headers[name] = value;
    }
    res.writeHead(status, headers);
    res.write(head.subarray(end + 4));
  });
  child.stdout.on("end", () => res.end());
}
