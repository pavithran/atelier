// atelier land. Its forms, flags and help are declared in src/usage/commands/land.ts.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { redactGitArgs } from "../runner.mjs";
import { runLand } from "../land.mjs";
import { OWNER, apiToken, args, cfg, die, git, itemArg, project, recordTokenExpiry, redact, request, server, storeWorkspaceToken, workspacePath, workspaceTokens } from "../atelier.mjs";

// The project owner lands one task whole: the lease on the server, the
// merge of main into the task's workspace, the project's fixture
// regeneration, the checks, the independent review, then accept and merge
// (cli/land.mjs). Steps run as this CLI's own commands where they have one,
// and each is recorded on the ledger as a land.* event.
export default async function landCommand() {
  const name = project(), id = itemArg();
  const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac`);
  if (!p.path || !existsSync(p.path)) die(`land needs ${name}'s registered checkout; this machine records ${p.path ?? "no folder"}. Run atelier init in that checkout first`);
  const workspace = workspacePath(name, id);
  // A request that throws rather than dies, so a landing that already holds
  // the lease can release it before the command ends. Requests are made as
  // the owner, except the re-claim that refreshes the workspace's write
  // token, which names the task's holder (and its runner) instead (t275).
  const request = async (method, path, body, as = OWNER, extra = {}) => {
    let res, text;
    try {
      res = await fetch(server() + "/api" + path, {
        method,
        headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": as, "content-type": "application/json", ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      text = await res.text();
    } catch (error) { throw new Error(`server request failed: ${error.message}`); }
    let data;
    try { data = JSON.parse(text); } catch { data = { error: "bad_response", detail: text.slice(0, 300) }; }
    // The status rides on the error, so a landing can tell a refusal
    // (the server answered, and said no) from a failure to reach it.
    if (!res.ok) throw Object.assign(new Error(`${data.error ?? res.status}: ${data.detail ?? text.slice(0, 300)}`), { status: res.status });
    return data;
  };
  // A git runner that throws rather than dies, for the same reason. With
  // allowFail it answers with git's own result, as the die-ing runner does.
  const gitOrThrow = (a, o = {}) => {
    const r = git(a, { ...o, allowFail: true });
    if (o.allowFail) return r;
    if (r.status !== 0) throw new Error(`git ${redactGitArgs(a).join(" ")} failed:\n${(r.stderr || r.stdout || r.error?.message || "").trim()}`);
    return o.raw ? r.stdout : r.stdout.trim();
  };
  try {
    await runLand({
      args, name, id, p, request, git: gitOrThrow, die,
      print: (line) => console.log(line),
      workspacePath, atelier: fileURLToPath(new URL("../atelier.mjs", import.meta.url)), env: process.env,
      redact, secrets: () => [apiToken(), ...workspaceTokens(workspace)],
      // The token a landing's re-claim minted, kept as claimWorkspace keeps
      // one: the old header replaced before the fetch, the expiry recorded.
      adoptWorkspaceToken: (dir, w) => {
        storeWorkspaceToken(dir, w.remote, w.token);
        recordTokenExpiry(dir, w.expiresAt);
        gitOrThrow(["fetch", "--quiet", "origin"], { cwd: dir });
      },
    });
  } catch (error) { die(error.message); }
}
