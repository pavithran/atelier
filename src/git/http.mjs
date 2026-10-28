// Git over HTTP from the Node server (Atelier 2.0, task 2; design section
// 4.3): /git/PROJECT.git/{info/refs,git-upload-pack,git-receive-pack},
// served by `git http-backend` run as the server's user. The credential is
// checked before Git sees a byte: a request without a live grant for this
// project is answered 401 at info/refs, before any pack is read, and a
// read grant asking to push is answered 403. The backend and the hook get a
// minimal environment: the grant's id and binding, never its token. A push
// also gets the paths of the policy the server wrote for its hook and of the
// report the hook writes back (src/git/policy.mjs), which the server records
// once the push ends.
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { openScan } from "./policy.mjs";

const ROUTE = /^\/git\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
export const GIT_PREFIX = "/git/";

// The token a Git client sent: the password of Basic auth (or its user name
// when the password is empty), or a Bearer token.
export function tokenOf(header) {
  if (!header) return null;
  const [scheme, value = ""] = header.split(" ");
  if (/^bearer$/i.test(scheme)) return value.trim() || null;
  if (!/^basic$/i.test(scheme)) return null;
  const text = Buffer.from(value, "base64").toString("utf8");
  const colon = text.indexOf(":");
  const pass = colon < 0 ? "" : text.slice(colon + 1);
  return pass || (colon < 0 ? text : text.slice(0, colon)) || null;
}

// The environment `git http-backend`, `git receive-pack` and the hook run
// with. Nothing from the server's own environment passes but PATH. `scan`
// is the push's ATELIER_POLICY and ATELIER_REPORT.
export function backendEnv({ reposDir, key, rest, method, query, contentType, encoding, protocol, grant, scan = {} }) {
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
    HOME: reposDir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_PROJECT_ROOT: reposDir,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: `/${key}.git/${rest}`,
    REQUEST_METHOD: method,
    QUERY_STRING: query,
    REMOTE_USER: grant.actor,
    ATELIER_GRANT: grant.id,
    ATELIER_PROJECT: grant.project,
    ATELIER_KIND: grant.kind,
    ATELIER_TASK: grant.task ?? "",
    ATELIER_ACTOR: grant.actor,
    ATELIER_BRANCH: grant.branch,
    ATELIER_ACCEPTED: grant.accepted ?? "",
    ...scan,
  };
  if (contentType) env.CONTENT_TYPE = contentType;
  if (encoding) env.HTTP_CONTENT_ENCODING = encoding;
  if (protocol) env.GIT_PROTOCOL = protocol;
  return env;
}

function deny(res, status, text) {
  const headers = { "content-type": "text/plain; charset=utf-8" };
  if (status === 401) headers["www-authenticate"] = 'Basic realm="atelier"';
  res.writeHead(status, headers);
  res.end(`${text}\n`);
}

// Answers a Git request when the path is a Git route and returns true;
// returns false for any other path. `authorize(token, project)` resolves to
// the grant ({ id, project, key, kind, task, actor, branch, accepted }) or
// null; `ensure(grant)` makes the repository if it is missing and answers
// its key. `scans`, for a push: `dir`, where each push's policy and report
// are written, `policy(grant)`, the policy, and `record(grant, report)`,
// called with the hook's report before the answer ends.
export async function gitRequest(req, res, { reposDir, authorize, ensure, scans }) {
  const url = new URL(req.url ?? "/", "http://git.local");
  const m = ROUTE.exec(url.pathname);
  if (!m) return false;
  const [, raw, rest] = m;
  let project;
  try { project = decodeURIComponent(raw); } catch { req.resume(); deny(res, 404, "atelier: no such repository"); return true; }
  const service = rest === "info/refs" ? url.searchParams.get("service") : rest;
  if (service !== "git-upload-pack" && service !== "git-receive-pack") { deny(res, 403, "atelier: only the smart Git protocol is served"); return true; }
  const grant = await authorize(tokenOf(req.headers.authorization), project);
  if (!grant) { req.resume(); deny(res, 401, `atelier: no live Git credential for ${project}`); return true; }
  if (service === "git-receive-pack" && grant.kind === "read") { req.resume(); deny(res, 403, "atelier: this credential reads only"); return true; }
  const key = await ensure(grant);
  const scan = rest === "git-receive-pack" && scans ? openScan(scans.dir, await scans.policy(grant)) : null;
  const child = spawn("git", ["http-backend"], {
    env: backendEnv({ reposDir, key, rest, method: req.method, query: url.search.slice(1), contentType: req.headers["content-type"], encoding: req.headers["content-encoding"], protocol: req.headers["git-protocol"], grant, scan: scan?.env }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  req.pipe(child.stdin);
  // A client gone mid-request takes its backend with it.
  res.on("close", () => { if (child.exitCode === null && !res.writableFinished) child.kill("SIGTERM"); });
  child.stdin.on("error", () => {});
  let errors = "";
  child.stderr.on("data", (d) => { if (errors.length < 4096) errors += d; });
  let head = Buffer.alloc(0);
  let started = false;
  await new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      if (started) { res.write(chunk); return; }
      head = Buffer.concat([head, chunk]);
      let end = head.indexOf("\r\n\r\n"), skip = 4;
      if (end < 0) { end = head.indexOf("\n\n"); skip = 2; }
      if (end < 0) return;
      let status = 200;
      const headers = {};
      for (const line of head.subarray(0, end).toString("latin1").split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const name = line.slice(0, i).trim(), value = line.slice(i + 1).trim();
        if (/^status$/i.test(name)) status = Number.parseInt(value, 10) || 500;
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      started = true;
      const body = head.subarray(end + skip);
      if (body.length) res.write(body);
    });
    child.on("close", async (code) => {
      if (scan) {
        const report = scan.report();
        scan.close();
        if (report) await scans.record(grant, report).catch((error) => console.error(`the secret scan of a push to ${project} (${grant.kind} ${grant.task ?? ""}) was not recorded: ${error.message}`));
      }
      if (!started) deny(res, 500, "atelier: the Git backend gave no answer");
      else res.end();
      if (code !== 0 && errors) console.error(`git ${service} for ${project} (${grant.kind} ${grant.task ?? ""}) ended ${code}: ${errors.trim().slice(0, 500)}`);
      resolve();
    });
  });
  return true;
}
