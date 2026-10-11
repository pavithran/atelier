import { runnerDenied, sha256, tokenActive, type AgentToken } from "./tokens.ts";

export interface RunnerGitGrant { parent: string; actor: string; id: string; generation: number }
export interface RunnerGitRuntime {
  ledger(project: string): {
    runnerGit(hash: string): Promise<RunnerGitGrant | null>;
    assertRunnerJob(token: AgentToken, id: string, actor: string): Promise<unknown>;
    item(id: string): Promise<{ fork: string | null }>;
  };
  token(hash: string): Promise<AgentToken | null>;
  artifacts: Pick<Artifacts, "get">;
  // Keeps the upstream token's revocation alive once the response has gone (ExecutionContext.waitUntil).
  waitUntil?: (promise: Promise<unknown>) => void;
}
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

// Runner Git credentials are opaque references, not Artifacts credentials.
// Every smart-HTTP request rechecks the parent and the current claim. Only
// the Worker ever sees the short-lived upstream write credential.
export async function runnerGitRequest(req: Request, url: URL, runtime: RunnerGitRuntime): Promise<Response> {
  const match = /^\/git\/runner\/([^/]+)\/(t[0-9]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!match || !(req.method === "GET" && match[3] === "info/refs" || req.method === "POST" && match[3] !== "info/refs")) return json({ error: "not_found" }, 404);
  let secret = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (/^Basic /i.test(secret)) {
    try { secret = atob(secret.slice(6)).split(":").slice(1).join(":"); } catch { secret = ""; }
  }
  const L = runtime.ledger(decodeURIComponent(match[1]));
  const grant = await L.runnerGit(await sha256(secret));
  if (!grant) return json({ error: "unauthorised" }, 401);
  const token = await runtime.token(grant.parent);
  if (!token || !token.runner || !tokenActive(token, Date.now())) return json({ error: "unauthorised" }, 401);
  if (grant.id !== match[2]) throw runnerDenied(token);
  await L.assertRunnerJob(token, grant.id, grant.actor);
  const item = await L.item(grant.id);
  if (!item.fork) throw runnerDenied(token);
  // Packs pass through as streams (t528: buffering them failed fresh clones
  // once the pack passed ~100 MB), so the upstream token outlives this call:
  // it is revoked, and the repo handle disposed, only once the response body
  // has ended, failed or been cancelled, or at once if there is none.
  const repo = await runtime.artifacts.get(item.fork);
  let upstream: { id: string; plaintext: string };
  let info: { remote: string };
  try {
    info = await repo.info();
    upstream = await repo.createToken("write", 60);
  } catch (error) { repo[Symbol.dispose](); throw error; }
  let released: Promise<void> | undefined;
  const release = () => released ??= (async () => {
    try { await repo.revokeToken(upstream.id); } finally { repo[Symbol.dispose](); }
  })();
  let response: Response;
  try {
    // Do not forward caller-controlled URLs, cookies, headers or redirects.
    const target = new URL(`${info.remote.replace(/\/$/, "")}/${match[3]}`);
    target.search = url.search;
    const headers = new Headers({ authorization: `Bearer ${upstream.plaintext}` });
    for (const key of ["content-type", "content-encoding", "git-protocol"]) { const value = req.headers.get(key); if (value) headers.set(key, value); }
    response = await fetch(target, { method: req.method, headers, body: req.method === "POST" ? req.body : undefined, redirect: "manual" });
  } catch (error) { await release(); throw error; }
  const result = new Headers({ "cache-control": "no-store" });
  result.set("content-type", response.headers.get("content-type") ?? "application/octet-stream");
  if (!response.body) {
    await release();
    return new Response(null, { status: response.status, headers: result });
  }
  // After the response has gone, a failed revocation can only be logged; the token expires in 60 seconds regardless.
  const settle = () => {
    const done = release().catch((error) => console.error("runner git revoke", error));
    runtime.waitUntil?.(done);
    return done;
  };
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch (error) { await settle(); controller.error(error); return; }
      if (chunk.done) { await settle(); controller.close(); } else controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch { /* the upstream is gone either way */ }
      await settle();
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, headers: result });
}
