import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env, server } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import type { ReviewClaim, LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { PlanPart } from "../src/plans/schema.ts";
import type { Evidence, Item, ProjectPolicy } from "../src/rules.ts";

// The routes the developer names at an approval (G17: Atelier picks none): every part built by
// zcode/glm-5.3 and reviewed by codex/gpt-6-astra, another family.
const routesOf = async (L: { planView(id: string): Promise<{ plan?: { parts: { key: string }[] } | null }> }, id: string) =>
  Object.fromEntries(((await L.planView(id)).plan?.parts ?? []).map((p) => [p.key, { builder: "zcode/glm-5.3", reviewer: "codex/gpt-6-astra" }]));

// A part claimed again whose branch holds nothing beyond the commit it
// started from starts from the plan branch's head when the branch has moved
// since (docs/orchestrator.md, section 5): the claim route moves the branch
// t/N to that head (task 5, moveEmptyBranch) and the Ledger records the new
// base. A part with commits of its own keeps its branch, and a part whose
// plan has not moved is claimed on its branch as it stands. Claims go through
// the Worker, over the real branches of the Node server's bare repository.
// The 1.x cases of an Artifacts fork deleted and forked again, and of the
// transient failures of those calls, went with the forks.

const PART_A = "a".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const PLANNER = "claude-code/opus-5.5";
const INTEGRATOR = "atelier/integrator";
const TOKEN = "part-fork-token";
const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };

const AT = "2026-10-07T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")];

const part = (key: string): PlanPart => ({
  key, title: `Part ${key}`, kind: "build", taskKind: "feature", scope: [`src/${key}/**`], dependsOn: [],
  provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S",
});

const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
type L = ReturnType<typeof ledger>;

// The project's bare repository on the Node server, and commits made in it
// with Git plumbing, as pushes would leave them. `commit` answers the new
// sha; `point` sets a branch (null deletes it); `tip` reads one.
const author = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
function repoOf(name: string) {
  const dir = (server as unknown as { git: { repo(key: string, branch: string): string } }).git.repo(name, "main");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...author } }).trim();
  let n = 0;
  return {
    commit: (parent: string | null, message = `commit ${++n}`) => git("commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", ...(parent ? ["-p", parent] : []), "-m", message),
    point: (branch: string, sha: string | null) => { if (sha) git("update-ref", `refs/heads/${branch}`, sha); else git("update-ref", "-d", `refs/heads/${branch}`); },
    tip: (branch: string) => { try { return git("rev-parse", "--verify", "-q", `refs/heads/${branch}`); } catch { return null; } },
  };
}
type Repo = ReturnType<typeof repoOf>;

// A runner's claim of the item through the Worker, as the actor, with the
// Ledger binding that is given (a test's own, to fail a call).
function claim(name: string, id: string, actor: string, LEDGER = env.LEDGER) {
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${id}/claim`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "x-atelier-acting": actor, "x-atelier-runner": RUNNER.runner, "content-type": "application/json" }, body: "{}",
  }), { ...env, ATELIER_TOKEN: TOKEN, LEDGER } as typeof env);
}

// The Ledger binding with its next moveFork failing, as a transient error
// between the Worker and the Ledger would, after the branch was moved.
function failingMove() {
  // The stub guard retries a transient error, so it fails more often than it tries.
  let failures = 100;
  return {
    idFromName: (n: string) => env.LEDGER.idFromName(n),
    get: (id: DurableObjectId) => {
      const stub = env.LEDGER.get(id);
      return new Proxy(stub, {
        get(target, key) {
          if (key === "moveFork" && failures > 0) {
            failures--;
            return async () => { throw new Error("Network connection lost."); };
          }
          // A request naming the acting model (G18) calls every method through actingCall.
          if (key === "actingCall") {
            return (acting: string, method: string, args: unknown[]) => {
              if (method !== "moveFork" || failures <= 0) return (target as unknown as { actingCall: (...a: unknown[]) => unknown }).actingCall(acting, method, args);
              failures--;
              return Promise.reject(new Error("Network connection lost."));
            };
          }
          return Reflect.get(target, key);
        },
      });
    },
  } as unknown as typeof env.LEDGER;
}

const observed = (itemId: string, head: string, path: string): Evidence => ({
  itemId, claim: "npm test", grade: "observed", head, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: [path],
});
const actorOf = (item: Item) => `${item.dispatch!.agent}/${item.dispatch!.model}`;

// A plan branched at M0 with independent parts a and b. Part b is claimed
// through the Worker, so its branch is made from the plan's branch at M0, and
// released; part a is then integrated as MA, moving the plan's branch.
async function setup(name: string, bCommits: boolean) {
  const record = { name, repo: `${name}--baseline`, branch: "main", policy, createdAt: new Date().toISOString() };
  const L = ledger(name);
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const repo = repoOf(name);
  const M0 = repo.commit(null, "first");
  repo.point("main", M0);
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", PLANNER, []);
  const planBranch = `plan/${item.id.slice(1)}`;
  await L.claim(item.id, PLANNER, RUNNER);
  await L.setFork(item.id, `${name}/${planBranch}`, M0, PLANNER);
  repo.point(planBranch, M0);
  const post = await L.postPlan(item.id, PLANNER, { schema: "atelier.plan.v1", goal: "Ship the feature", parts: [part("a"), part("b")] });
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, PLANNER, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, POOL, [], await routesOf(L, item.id));
  const [a, b] = [parts[0].id, parts[1].id];
  const bBranch = `t/${b.slice(1)}`;
  const bFork = `${name}/${bBranch}`;

  const builderB = actorOf(await L.item(b));
  const first = await claim(name, b, builderB);
  expect(first.status, await first.clone().text()).toBe(200);
  expect(await L.item(b)).toMatchObject({ fork: bFork, base: M0, head: M0 });
  let PART_B = "";
  if (bCommits) {
    PART_B = repo.commit(M0, "part b");
    repo.point(bBranch, PART_B);
    await L.recordPush(b, builderB, PART_B, PART_B);
  }
  await L.release(b, builderB, bCommits ? "checks failed" : "no new commit");

  const builderA = actorOf(await L.item(a));
  await L.claim(a, builderA, RUNNER);
  await L.setFork(a, `${name}/t/${a.slice(1)}`, M0, builderA);
  await L.recordPush(a, builderA, PART_A, PART_A);
  await L.addEvidence(observed(a, PART_A, "src/a/x.ts"));
  await L.submit(a, builderA);
  const waiting = (await L.reviewWaiting()).filter((w) => w.id === a);
  const reviewer = `${waiting[0].dispatch!.agent}/${waiting[0].dispatch!.model}`;
  const reviewClaim1 = await L.claimReview(a, reviewer, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: reviewClaim1.request, itemId: a, criteria: await L.criteria(a), by: reviewer, head: PART_A, approve: true, note: "Good", at: new Date().toISOString() });
  await L.claim(item.id, INTEGRATOR, RUNNER, true);
  const MA = repo.commit(M0, "part a integrated");
  await L.integratePart(item.id, INTEGRATOR, "a", MA, true);
  await L.release(item.id, INTEGRATOR, "part integrated");
  repo.point(planBranch, MA);

  const again = await L.item(b);
  expect(again.state).toBe("open");
  expect(again.dispatch).not.toBeNull();
  return { L, b, bBranch, bFork, planBranch, repo, M0, MA, PART_B, builder: actorOf(again) };
}

const moves = async (L: L, id: string) => ((await L.events(id)) as unknown as LedgerEvent[]).filter((e) => e.kind === "fork.moved");

it("a part with no commits of its own, dispatched again after the plan's branch moved, starts from the branch's head", async () => {
  const name = "pf-moved";
  const { L, b, bBranch, bFork, repo, M0, MA, builder } = await setup(name, false);
  expect(repo.tip(bBranch)).toBe(M0);
  const res = await claim(name, b, builder);
  expect(res.status).toBe(200);
  expect(repo.tip(bBranch)).toBe(MA);
  expect(await L.item(b)).toMatchObject({ fork: bFork, base: MA, head: MA, owner: builder, state: "claimed" });
  expect(((await res.json()) as { item: Item }).item).toMatchObject({ base: MA, head: MA });
  expect((await moves(L, b)).map((e) => e.data)).toEqual([{ fork: bFork, from: M0, base: MA, acting: builder }]);
  // Claimed again with the branch where it is, the branch stays.
  expect((await claim(name, b, builder)).status).toBe(200);
  expect(repo.tip(bBranch)).toBe(MA);
  expect((await moves(L, b)).length).toBe(1);
});

it("a part with commits of its own keeps its branch and head when the plan's branch has moved", async () => {
  const name = "pf-own";
  const { L, b, bBranch, bFork, repo, M0, PART_B, builder } = await setup(name, true);
  expect((await claim(name, b, builder)).status).toBe(200);
  expect(repo.tip(bBranch)).toBe(PART_B);
  expect(await L.item(b)).toMatchObject({ fork: bFork, base: M0, head: PART_B });
  expect(await moves(L, b)).toEqual([]);
});

it("a part whose branch has a commit the Ledger has not recorded keeps it", async () => {
  const name = "pf-unrecorded";
  const { L, b, bBranch, repo, M0, builder } = await setup(name, false);
  const PART_B = repo.commit(M0, "unrecorded");
  repo.point(bBranch, PART_B);
  expect((await claim(name, b, builder)).status).toBe(200);
  expect(repo.tip(bBranch)).toBe(PART_B);
  expect(await L.item(b)).toMatchObject({ base: M0, head: M0 });
});

it("a part whose branch a failed move left missing is branched again at the plan's head", async () => {
  const name = "pf-missing";
  const { L, b, bBranch, bFork, repo, MA, builder } = await setup(name, false);
  repo.point(bBranch, null);
  expect((await claim(name, b, builder)).status).toBe(200);
  expect(repo.tip(bBranch)).toBe(MA);
  expect(await L.item(b)).toMatchObject({ fork: bFork, base: MA, head: MA });
});

it("a part first dispatched, and one claimed again while the plan's branch has not moved, is branched once at the plan's head", async () => {
  const name = "pf-first";
  const { L, b, bBranch, repo, MA, builder } = await setup(name, false);
  // Move b to MA, release it, and claim it again with the branch still at MA.
  expect((await claim(name, b, builder)).status).toBe(200);
  await L.release(b, builder, "no new commit");
  // G17: the named route has no alternate, so a second give-up blocks the plan until the developer retries the part.
  await L.retryPlan(b, "owner");
  const next = actorOf(await L.item(b));
  expect((await claim(name, b, next)).status).toBe(200);
  expect(repo.tip(bBranch)).toBe(MA);
  expect(await L.item(b)).toMatchObject({ base: MA, head: MA });
  expect((await moves(L, b)).length).toBe(1);
});

it("a move that moved the branch but failed to record the new base is finished by the next claim", async () => {
  const name = "pf-unrecorded-move";
  const { L, b, bBranch, bFork, repo, M0, MA, builder } = await setup(name, false);
  expect((await claim(name, b, builder, failingMove())).status).toBe(500);
  // The branch was moved to the plan's head; the Ledger still has M0.
  expect(repo.tip(bBranch)).toBe(MA);
  expect(await L.item(b)).toMatchObject({ base: M0, head: M0 });
  const next = actorOf(await L.item(b));
  expect((await claim(name, b, next)).status).toBe(200);
  expect(repo.tip(bBranch)).toBe(MA);
  expect(await L.item(b)).toMatchObject({ fork: bFork, base: MA, head: MA, owner: next, state: "claimed" });
  expect((await moves(L, b)).map((e) => e.data)).toEqual([{ fork: bFork, from: M0, base: MA, acting: builder }]);
});

// A push that lands on the part's branch after the claim has read it and
// before it moves it (the 1.x case of a fork pushed to while its delete
// waited, retired with the forks in task 7; review of task 7, round 1). The
// move is a conditional update-ref naming the head it read (moveBranch in
// src/git/branches.mjs), so it fails and the push stands, and the Ledger
// records no move. The race is played by a git on PATH that, at the move's
// own update-ref, first sets the branch to the pushed commit.
it("a push that lands on a part's branch between the claim's read and its move is kept, and no move is recorded", async () => {
  const name = "pf-push-race";
  const { L, b, bBranch, bFork, repo, M0, builder } = await setup(name, false);
  const PUSHED = repo.commit(M0, "pushed while the claim moved the branch");
  const bin = mkdtempSync(join(tmpdir(), "atelier-git-race-"));
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh
if [ "$1" = "update-ref" ] && [ "$3" = "atelier: move an empty branch" ] && [ ! -e "${bin}/raced" ]; then
  : > "${bin}/raced"
  "${real}" update-ref "$4" "${PUSHED}"
fi
exec "${real}" "$@"
`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  let res: Response;
  try { res = await claim(name, b, builder); } finally { process.env.PATH = path; }
  try {
    expect(execFileSync("sh", ["-c", `test -e "${bin}/raced" && echo raced || echo not`], { encoding: "utf8" }).trim(), "the move's update-ref ran").toBe("raced");
  } finally { rmSync(bin, { recursive: true, force: true }); }
  expect(res.status, await res.clone().text()).toBe(200);
  expect(repo.tip(bBranch)).toBe(PUSHED);
  expect(await L.item(b)).toMatchObject({ fork: bFork, base: M0, owner: builder, state: "claimed" });
  expect(await moves(L, b)).toEqual([]);
});

it("a branch left at an earlier head of the plan's branch is moved to its head", async () => {
  const name = "pf-unrecorded-behind";
  const { L, b, bBranch, planBranch, repo, MA, builder } = await setup(name, false);
  const MB = repo.commit(MA, "plan moves on");
  repo.point(bBranch, MA);
  repo.point(planBranch, MB);
  expect((await claim(name, b, builder)).status).toBe(200);
  expect(repo.tip(bBranch)).toBe(MB);
  expect(await L.item(b)).toMatchObject({ base: MB, head: MB });
});

// A task outside a plan is moved the same way from main (t462): one claimed
// and released with no commits is branchless, which the task refresh leaves
// for its next claim to start from main as main is then.
async function ordinary(name: string) {
  const record = { name, repo: `${name}--baseline`, branch: "main", policy, createdAt: new Date().toISOString() };
  const L = ledger(name);
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const repo = repoOf(name);
  const M0 = repo.commit(null, "first");
  repo.point("main", M0);
  const { id } = await L.newItem("Work", ["src/**"], "owner");
  expect((await claim(name, id, PLANNER)).status).toBe(200);
  const branch = `t/${id.slice(1)}`;
  const fork = `${name}/${branch}`;
  expect(await L.item(id)).toMatchObject({ fork, base: M0, head: M0 });
  return { L, id, branch, fork, repo, M0 };
}

it("a task claimed and released with no commits, claimed again after main moved, starts from main's head", async () => {
  const name = "pf-task-moved";
  const { L, id, branch, fork, repo, M0 } = await ordinary(name);
  await L.release(id, PLANNER, "no new commit");
  expect((await L.refreshQueue()).map((r) => r.item)).toEqual([]);
  const MA = repo.commit(M0, "main moves");
  repo.point("main", MA);
  await L.noteMainHead(MA);
  expect((await claim(name, id, PLANNER)).status).toBe(200);
  expect(repo.tip(branch)).toBe(MA);
  expect(await L.item(id)).toMatchObject({ fork, base: MA, head: MA, owner: PLANNER, state: "claimed" });
  expect((await moves(L, id)).map((e) => e.data)).toEqual([{ fork, from: M0, base: MA, acting: PLANNER }]);
});

it("a task with commits of its own keeps its branch when main has moved", async () => {
  const name = "pf-task-own";
  const { L, id, branch, repo, M0 } = await ordinary(name);
  const PART_B = repo.commit(M0, "own work");
  repo.point(branch, PART_B);
  await L.recordPush(id, PLANNER, PART_B, PART_B);
  await L.release(id, PLANNER, "stepping away");
  repo.point("main", repo.commit(M0, "main moves"));
  expect((await claim(name, id, PLANNER)).status).toBe(200);
  expect(repo.tip(branch)).toBe(PART_B);
  expect(await L.item(id)).toMatchObject({ base: M0, head: PART_B });
});
