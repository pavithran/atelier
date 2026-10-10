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
  using repo = await runtime.artifacts.get(item.fork);
  const info = await repo.info();
  const upstream = await repo.createToken("write", 60);
  try {
    // Do not forward caller-controlled URLs, cookies, headers or redirects.
    const target = new URL(`${info.remote.replace(/\/$/, "")}/${match[3]}`);
    target.search = url.search;
    const headers = new Headers({ authorization: `Bearer ${upstream.plaintext}` });
    for (const key of ["content-type", "content-encoding", "git-protocol"]) { const value = req.headers.get(key); if (value) headers.set(key, value); }
    const response = await fetch(target, { method: req.method, headers, body: req.method === "POST" ? await req.arrayBuffer() : undefined, redirect: "manual" });
    const result = new Headers({ "cache-control": "no-store" });
    result.set("content-type", response.headers.get("content-type") ?? "application/octet-stream");
    return new Response(await response.arrayBuffer(), { status: response.status, headers: result });
  } finally { await repo.revokeToken(upstream.id); }
}

