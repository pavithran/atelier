import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
// @ts-expect-error the runner is plain JavaScript without declarations
import { runReview } from "../cli/runner.mjs";

// t591, end to end (codex/gpt-6-astra's second review, finding 4): a task
// landed in fast mode is recorded through the landed-fast route with its
// receipt, which asks the post-merge review of the merge commit; a runner's
// review job, driven through the real routes (review-claim, baseline-token,
// review) with git and the reviewer's harness stood in, finds the merge
// missing from the claim's clone, reads it from the baseline, and its
// verdict is recorded on the ledger at the merge commit. Every credential is
// a dummy; Artifacts is a local fake that records the repositories it mints
// tokens for.

const OWNER = "fast-review-owner", AT = "2026-10-13T12:00:00.000Z";
const OPUS = "claude-code/opus-5.5", ASTRA = "codex/gpt-6-astra";
const BASE = "b".repeat(40), PARENT = "a".repeat(40), C1 = "c".repeat(40), M1 = "d".repeat(40);
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});

it("a landed-fast receipt's post-merge review is claimed, read from the baseline and recorded at the merge commit", async () => {
  const name = "fast-review-e2e";
  const index: any = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  const L: any = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const record = { name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: [] }, createdAt: AT };
  await L.setProject(record, "owner");
  await index.registerProject(record);
  await index.putModel(entry("gpt-6-astra", "codex"));
  await index.putModel(entry("opus-5.5", "claude-code"));
  const item = await L.newItem("Built fast", ["src/**"], "owner", { accept: ["Keeps data"] });
  await L.confirmFastMode("owner", "access");
  await L.setMode("owner", "fast", "forks fail");

  const minted: string[] = [];
  const artifacts = { get: async (repo: string) => ({
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    createToken: async (_scope: string, ttl: number) => { minted.push(repo); return { id: `tok-${minted.length}`, plaintext: `read-${repo}`, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }; },
    revokeToken: async () => true,
    [Symbol.dispose]() {},
  }) } as unknown as Artifacts;
  const bindings = { ...env, ATELIER_TOKEN: OWNER, ARTIFACTS: artifacts } as typeof env;
  const request = (method: string, path: string, token: string, actor: string, body?: unknown, headers: Record<string, string> = {}) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": actor, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), bindings);

  // atelier fast land's receipt, with the post-merge review asked of Astra.
  const landed = await request("POST", `/projects/${name}/items/${item.id}/landed-fast`, OWNER, "owner",
    { commit: C1, mergeCommit: M1, builder: OPUS, tests: { command: "npm test", sha256: "f".repeat(64) }, reviewer: ASTRA });
  expect(landed.status, await landed.clone().text()).toBe(200);
  expect((await landed.json() as { review: unknown }).review).toMatchObject({ requested: true, head: M1, reviewer: ASTRA });

  // The reviewer's own agent token, as a runner config names it.
  const issued = await request("POST", "/tokens", OWNER, "owner", { actor: ASTRA, projects: [name] });
  expect(issued.status).toBe(201);
  const agentToken = (await issued.json() as { token: string }).token;

  // The CLI calls the review job makes, sent to the routes the atelier
  // command sends them to.
  const flag = (argv: string[], f: string) => argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined;
  const calls: string[][] = [];
  const cli = async (argv: string[], _cwd: unknown, options: { token: string }) => {
    calls.push(argv);
    const verb = argv[0], id = argv[1];
    const item = (route: string, body: unknown, headers?: Record<string, string>) => request("POST", `/projects/${name}/items/${id}/${route}`, options.token, ASTRA, body, headers);
    let res: Response;
    if (verb === "review-claim") res = await item("review-claim", {}, { "x-atelier-runner": flag(argv, "--runner")! });
    else if (verb === "baseline-token") res = await request("POST", `/projects/${name}/baseline-token`, options.token, ASTRA, {});
    else if (verb === "review") res = await item("review", { approve: argv.includes("--approve"), note: flag(argv, "--note"), head: flag(argv, "--head"), criteria: flag(argv, "--criteria"), request: Number(flag(argv, "--request")) });
    else if (verb === "review-release" || verb === "review-renew") res = await item(verb, { note: flag(argv, "--note") ?? "", request: Number(flag(argv, "--request")) });
    else throw new Error(`unexpected call ${verb}`);
    const text = await res.text();
    if (!res.ok) throw new Error(`${verb}: ${res.status} ${text}`);
    return text;
  };
  // Git and the harness stood in: the claim's clone lacks the merge until
  // the baseline is fetched; the merge's first parent is PARENT.
  const git: { cloned?: string; fetched: string[]; held: boolean; diff?: [string, string] } = { fetched: [], held: false };
  const io = {
    cli, log: () => {}, stopped: () => false, env: {}, ownerTokens: () => [], readSecret: () => agentToken,
    workspacePath: () => "/work/t1",
    clone: async (remote: string) => { git.cloned = remote; },
    hasCommit: async () => git.held,
    fetch: async (_dir: string, remote: string, _token: string, ref: string) => { git.fetched.push(`${remote} ${ref}`); if (remote.includes("--baseline")) git.held = true; },
    checkout: async (_dir: string, head: string) => { if (!git.held || head !== M1) throw new Error(`fatal: unable to read tree (${head})`); },
    revParse: async (_dir: string, spec: string) => spec === `${M1}^@` ? `${PARENT}\n${C1}` : spec === "FETCH_HEAD" ? M1 : "",
    show: async () => { throw new Error("no override"); },
    diff: async (_dir: string, from: string, to: string) => { git.diff = [from, to]; return "diff --git a/src/a.ts b/src/a.ts\n+export const a = 1;\n"; },
    brief: async () => ({ file: "/work/brief.txt" }), removeBrief: async () => {},
    writeDiff: async () => ({ file: "/work/diff.txt" }), removeDiff: () => {},
    verdictPath: () => "/work/verdict.txt",
    readVerdict: () => "VERDICT: APPROVE\nSUMMARY: The merge adds the task's change and nothing else.\nCRITERION 1: met — Read the diff against the merge's first parent.",
    harness: async () => ({ code: 0, timedOut: false }),
    dataHome: async () => null, removeDataHome: async () => {},
  };
  const config = { agents: [{ agent: "codex", models: ["gpt-6-astra"], command: ["codex", "{brief_file}", "{diff_file}", "{verdict_file}"] }], tokens: { "gpt-6-astra": "agent.astra" } };
  const assignment = { project: name, item: { id: item.id, dispatch: { job: "review" } }, agent: "codex", model: "gpt-6-astra", actor: ASTRA };
  // The queue offers the review at the merge commit.
  const queued = await request("POST", "/queue", OWNER, "owner", { runner: "home:studio", agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["review"] });
  const offered = await queued.json() as { item: { id: string; head: string } }[];
  expect(offered.find((t) => t.item.id === item.id)?.item.head).toBe(M1);

  const state = await runReview(assignment, config, "home:studio", io);
  expect(state, JSON.stringify(state)).toMatchObject({ phase: "reviewed", verdict: "approve" });
  // The claim named the merge and the baseline; the clone lacked the merge
  // and the baseline was read for it; the diff is from its first parent.
  expect(git.cloned).toBe(`https://git.test/${name}--baseline.git`);
  expect(calls.map((c) => c[0])).toEqual(["review-claim", "baseline-token", "review"]);
  expect(git.fetched[0]).toBe(`https://git.test/${name}--baseline.git main`);
  expect(git.diff).toEqual([PARENT, M1]);

  // The verdict is on the ledger, at the merge commit, as the post-merge review.
  const reviews = await L.reviewsFor(item.id);
  expect(reviews).toHaveLength(1);
  expect(reviews[0]).toMatchObject({ by: ASTRA, head: M1, approve: true, postMerge: true });
  expect((await L.fastLandings())[0]).toMatchObject({ item: item.id, receipt: { mergeCommit: M1 }, review: { state: "approved", by: ASTRA } });
});
