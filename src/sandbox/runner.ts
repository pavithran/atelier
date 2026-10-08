// Runs a project's required checks in a Cloudflare container, so that an
// Observed result no longer depends on the machine of the agent being judged.
//
// The container never holds a credential and cannot reach the repository:
// the Worker reads the item's exact tree from Artifacts and streams it into
// `tar -x`. The container starts with the Internet off; the only host it can
// reach is the npm registry, through a pass-through gateway that allows GET and
// HEAD, and the reserved render host, answered by the Worker itself: the
// render check (src/render-check.ts) POSTs a page there to be rendered by
// Browser Run, with JavaScript off and every request but the pages' fonts
// blocked, a few times per run at most, and gets back only problems.
// Results are written to the Ledger by this code alone, marked "sandbox",
// which nothing posted to the public API can claim.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { againstMain, changedPaths, pairReader, repoReader, type Reader } from "../diff";
import { mergePatch, mergeTrees, type Patch } from "../preview/merge";
import { refusalOf, refusalText } from "../checks.ts";
import { checkApplies, type CheckPaths } from "../rules.ts";
import { MAX_RENDERS, renderGateway, RENDER_HOST } from "../render-check.ts";
import { capLarge, putLarge, LARGE_MAX, type LargeRef } from "../large.ts";
import { END_OF_ARCHIVE, entryBytes } from "./tar";
import { fetchPinned, GIT_DEB, installCommands, TOOLS_DIR } from "./tools";
import { writeTree } from "./tree";

// Cloudflare-managed: Node 24 on Debian Trixie slim, with no git; supplyGit
// (src/sandbox/tools.ts) adds Debian's own git package to each container.
const IMAGE = "cloudflare/debian-trixie";
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const WORKDIR = "/workspace";
// Each check step's limit: a full suite, Atelier's own among them, must be
// able to finish on the container this Durable Object starts.
const STEP_SECONDS = 1800;
const OUTPUT_TAIL = 4000;
export const EGRESS_HOSTS = ["registry.npmjs.org"];

// Passed to every exec(): variables given to start() reach only the entrypoint.
// The CA lets Node and npm trust the gateway that answers for the registry.
const ENV: Record<string, string> = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/root",
  CI: "1",
  NODE_EXTRA_CA_CERTS: CA,
  npm_config_cafile: CA,
  npm_config_update_notifier: "false",
};

export interface RunRequest {
  runId: string;
  project: string;
  itemId: string;
  baselineRepo: string;
  fork: string;
  head: string;            // the head the caller asked about; the run refuses any other
  checks: string[];
  checkPaths?: CheckPaths[];  // checks that apply only when the change touches these paths
  requestedBy: string;
  merged?: boolean;        // run on the merge of the head with main's head, not on the head alone
}

// A check whose paths the change does not touch is not run: its result is
// notApplicable, with no pass, exit code or output.
export interface CheckResult {
  claim: string;
  passed: boolean | null;
  exitCode: number | null;
  seconds: number;
  outputTail: string;
  // The whole output kept in R2 by reference (src/large.ts), when the output
  // is longer than the tail held inline.
  log?: LargeRef | null;
  notApplicable?: boolean;
}

export interface RunState {
  status: "queued" | "running" | "done" | "failed";
  request: RunRequest;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  changedPaths?: string[];
  git?: string;            // what supplyGit found: git's version line, or why the run has no git
  mainHead?: string;       // main's head the checks were measured against, and merged with for a merged run
  results?: CheckResult[];
  recorded?: boolean;      // whether the Ledger accepted the results
  error?: string;
}

// Pass-through egress: the npm registry only, reads only, nothing added. One
// reserved host is not passed through but answered here: the render gateway,
// which the sandbox's render check POSTs a rendered page to and which holds
// the browser, so the container never holds a credential of its own. The
// gateway is answered only for the run named in this entrypoint's props,
// which CheckRunner sets when it starts its own container, and draws on that
// run's render allowance (CheckRunner.takeRenders); without a run it refuses.
export async function routeEgress(env: Env, request: Request, runId?: string): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname === RENDER_HOST) {
    const runner = runId ? env.RUNNER.get(env.RUNNER.idFromName(runId)) : null;
    return renderGateway(env.BROWSER, request, runner ? { take: (n) => runner.takeRenders(n) } : null);
  }
  if (!EGRESS_HOSTS.includes(url.hostname) || (request.method !== "GET" && request.method !== "HEAD")) {
    return new Response(`Atelier's check sandbox may not reach ${request.method} ${url.hostname}`, { status: 403 });
  }
  return fetch(request);
}

export class Egress extends WorkerEntrypoint<Env, { runId?: string }> {
  async fetch(request: Request): Promise<Response> {
    return routeEgress(this.env, request, this.ctx.props.runId);
  }
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text;
}

export class CheckRunner extends DurableObject<Env> {
  // One Durable Object per run: start() records the request and arms an alarm,
  // so a check that takes minutes never depends on an open HTTP request.
  async start(request: RunRequest): Promise<RunState> {
    const existing = await this.ctx.storage.get<RunState>("state");
    if (existing) return existing;
    const state: RunState = { status: "queued", request, queuedAt: new Date().toISOString() };
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(Date.now());
    return state;
  }

  async state(): Promise<RunState | null> {
    return (await this.ctx.storage.get<RunState>("state")) ?? null;
  }

  // The render gateway's allowance for this run: n more renders are granted
  // only while the run is running and the run has used fewer than
  // MAX_RENDERS with them. Read and counted in one synchronous step, so two
  // requests at once cannot both take the last ones.
  async takeRenders(n: number): Promise<boolean> {
    if (!Number.isInteger(n) || n < 1) return false;
    const state = await this.ctx.storage.get<RunState>("state");
    if (state?.status !== "running") return false;
    return this.ctx.storage.transactionSync(() => {
      const used = this.ctx.storage.kv.get<number>("renders") ?? 0;
      if (used + n > MAX_RENDERS) return false;
      this.ctx.storage.kv.put("renders", used + n);
      return true;
    });
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<RunState>("state");
    if (!state || state.status === "done" || state.status === "failed") return;
    if (state.status === "running") {
      state.status = "failed";
      state.error = "The runner was interrupted or exceeded its deadline. Start a new check run.";
      state.finishedAt = new Date().toISOString();
      await this.ctx.storage.put("state",state);
      await this.ctx.container?.destroy().catch(()=>{});
      return;
    }
    state.status = "running";
    state.startedAt = new Date().toISOString();
    await this.ctx.storage.setAlarm(Date.now() + (state.request.checks.length * STEP_SECONDS + 120) * 1000);
    await this.ctx.storage.put("state", state);
    try {
      await this.run(state);
      state.status = "done";
    } catch (err) {
      state.status = "failed";
      state.error = String((err as Error)?.message ?? err).slice(0, 1000);
    } finally {
      state.finishedAt = new Date().toISOString();
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.put("state", state);
      const container = this.ctx.container;
      if (container?.running) await container.destroy().catch(() => {});
    }
  }

  private async run(state: RunState): Promise<void> {
    const req = state.request;
    // A check that is never read-only is not run here, however the run was asked for.
    for (const claim of req.checks) {
      const why = refusalOf(claim);
      if (why) throw new Error(`${refusalText(claim, why)}.`);
    }
    using fork = await this.env.ARTIFACTS.get(req.fork);
    using baseline = await this.env.ARTIFACTS.get(req.baselineRepo);
    // The paths are measured against main's head, not against a fork point
    // the workspace's history chooses (see againstMain in src/diff.ts), so
    // the list the gate reads holds every path the head differs from main on.
    const m = await againstMain(fork, baseline);
    if (!m) throw new Error("the workspace or the baseline has no commits");
    if (m.head !== req.head) throw new Error(`the workspace moved to ${m.head.slice(0, 8)} after ${req.head.slice(0, 8)} was requested`);
    state.changedPaths = await changedPaths(pairReader(fork, baseline), m.mainTree, m.headTree);
    state.mainHead = m.main;
    const applies = (claim: string) => checkApplies({ checkPaths: req.checkPaths }, claim, state.changedPaths ?? null) !== false;
    state.results = req.checks.filter((claim) => !applies(claim)).map((claim) => ({ claim, passed: null, exitCode: null, seconds: 0, outputTail: "", notApplicable: true }));
    await this.ctx.storage.put("state", state);
    // When no check applies, no container is started; the results record the
    // paths measured. A merged run needs no merge tree then either, since a
    // check that does not apply to the change is not needed on the merge.
    if (!req.checks.some(applies)) return this.record(state, m.head, fork);
    // The tree the container checks is the head's, whose objects are in the
    // fork. A merged run checks the would-be merge instead: the head's tree
    // with main's changes since the fork point laid over it, as the preview
    // reads the merge, so main's newer objects are read from the baseline.
    // Where the preview finds a conflict there is no tree to check.
    let reader: Reader = repoReader(fork);
    let patch: Map<string, Patch | null> | undefined;
    if (req.merged) {
      const trees = await mergeTrees(baseline, fork);
      if (!trees) throw new Error("no fork point: the workspace's history meets none of main's within the commits read");
      if (trees.main !== m.main || trees.head !== m.head) throw new Error("the workspace or main moved while the run started; start a new check run");
      reader = pairReader(fork, baseline);
      const merge = await mergePatch(repoReader(baseline), repoReader(fork), trees.baseTree, trees.mainTree, trees.headTree);
      if (merge.conflicts.length) throw new Error(`the merge with main at ${m.main.slice(0, 8)} stops on conflicts: ${merge.conflicts.map((c) => `${c.path} (${c.reason})`).join(", ")}; bring main into the workspace and resolve them`);
      patch = merge.patch;
    }

    const container = this.ctx.container;
    if (!container) throw new Error("no container is configured for CheckRunner");
    for (const host of [...EGRESS_HOSTS, RENDER_HOST]) await container.interceptOutboundHttps(host, this.ctx.exports.Egress({ props: { runId: req.runId } }));
    container.start({
      image: IMAGE,
      entrypoint: ["sleep", "infinity"],
      enableInternet: false,
      instance: "standard-1",
      env: ENV,
    });

    const mkdir = await (await container.exec(["mkdir", "-p", WORKDIR], { env: ENV })).output();
    if (mkdir.exitCode !== 0) throw new Error("could not create the workspace directory");
    // A run whose git could not be supplied still runs its checks, since many
    // need none; each check's output then begins by saying so.
    const git = await this.supplyGit(container);
    state.git = git.line;
    const gitNote = git.ok ? "" : `[atelier] this container has no git: ${git.line}\n`;
    const pipe = new IdentityTransformStream();
    const writer = pipe.writable.getWriter();
    const unpack = await container.exec(["tar", "-x", "-f", "-", "-C", WORKDIR], { stdin: pipe.readable, stdout: "ignore", stderr: "pipe", env: ENV });
    const written = (async () => {
      try {
        await writeTree(reader, m.headTree, (b) => writer.write(b), "", patch);
        await writer.write(END_OF_ARCHIVE);
        await writer.close();
      } catch (err) {
        await writer.abort(err);
        throw err;
      }
    })();
    const [unpacked] = await Promise.all([unpack.output(), written]);
    if (unpacked.exitCode !== 0) throw new Error(`tar failed: ${new TextDecoder().decode(unpacked.stderr).slice(0, 500)}`);

    for (const claim of req.checks.filter(applies)) {
      const t0 = Date.now();
      const proc = await container.exec(["timeout", "--kill-after=5", String(STEP_SECONDS), "sh", "-c", claim], { cwd: WORKDIR, stderr: "combined", env: ENV });
      const decoder = new TextDecoder();
      let output = "", whole = "";
      // The whole output is gathered beside the tail, capped (capLarge) so a
      // check that prints without end cannot outgrow the run: its last part is
      // kept, where a failure says what it is.
      const keep = (text: string) => {
        output = tail(output + text);
        whole += text;
        if (whole.length > 2 * LARGE_MAX) whole = capLarge(whole);
      };
      keep(gitNote);
      const read = async () => {
        const stream = proc.stdout?.getReader();
        if (!stream) return;
        try { while (true) { const chunk = await stream.read(); if (chunk.done) break; keep(decoder.decode(chunk.value, { stream: true })); } keep(decoder.decode()); }
        finally { stream.releaseLock(); }
      };
      const [exitCode] = await Promise.all([proc.exitCode, read()]);
      const timedOut = exitCode === 124 ? `\n[atelier] stopped after ${STEP_SECONDS}s` : "";
      // A log longer than the tail held inline is kept whole in R2, and the
      // evidence carries the reference beside the tail (t284).
      const log = whole.length > OUTPUT_TAIL ? await putLarge(this.env.LARGE, "logs", req.project, req.itemId, capLarge(whole + timedOut)) : null;
      state.results.push({
        claim,
        passed: exitCode === 0,
        exitCode,
        seconds: Math.round((Date.now() - t0) / 1000),
        outputTail: tail(output + timedOut),
        ...(log ? { log } : {}),
      });
      await this.ctx.storage.put("state", state);
    }
    await this.record(state, m.head, fork);
  }

  // Puts Debian's git package (GIT_DEB, pinned by size and sha256) into the
  // running container: the Worker fetches and verifies it, streams it in as
  // a one-file tar, and the container unpacks it offline with dpkg-deb. The
  // container reaches no new host and holds no credential. Answers git's
  // version line, or why there is no git.
  private async supplyGit(container: Container): Promise<{ ok: boolean; line: string }> {
    try {
      const deb = await fetchPinned(GIT_DEB, { fetch: (url) => fetch(url), bucket: this.env.LARGE });
      const tar = new Blob([...entryBytes({ path: `${TOOLS_DIR}/${GIT_DEB.name}.deb`, mode: 0o644, kind: "file", data: deb }), END_OF_ARCHIVE]);
      const put = await (await container.exec(["tar", "-x", "-f", "-", "-C", "/"], { stdin: tar.stream(), stdout: "ignore", stderr: "pipe", env: ENV })).output();
      if (put.exitCode !== 0) throw new Error(`tar failed: ${new TextDecoder().decode(put.stderr).slice(0, 300)}`);
      let last = "";
      for (const argv of installCommands(GIT_DEB)) {
        const out = await (await container.exec(argv, { stderr: "combined", env: ENV })).output();
        last = new TextDecoder().decode(out.stdout).trim();
        if (out.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${out.exitCode}: ${last.slice(0, 300)}`);
      }
      return { ok: true, line: last.slice(0, 200) };
    } catch (err) {
      return { ok: false, line: String((err as Error)?.message ?? err).slice(0, 500) };
    }
  }

  // Record in the Ledger. It refuses evidence for a head the item has moved
  // past. Each row names main's head the run was measured against; a merged
  // run's rows are bound to that commit too, measure no paths, and are stale
  // once main moves on. A row for a check that does not apply is a fact about
  // the head, so it is never merged and keeps the paths measured.
  private async record(state: RunState, head: string, fork: ArtifactsRepo): Promise<void> {
    const req = state.request;
    const ledger = this.env.LEDGER.get(this.env.LEDGER.idFromName(`project:${req.project}`));
    const current = await fork.log({ limit: 1 });
    if (current[0]?.hash !== head) throw new Error("the workspace changed while checks ran; record the push and check again");
    const at = new Date().toISOString();
    for (const r of state.results ?? []) {
      await ledger.addEvidence({
        itemId: req.itemId,
        claim: r.claim,
        grade: "observed",
        head,
        passed: r.passed,
        by: "atelier/sandbox",
        at,
        changedPaths: req.merged && !r.notApplicable ? null : state.changedPaths,
        outputTail: r.notApplicable
          ? "[atelier] not run: no path this change touches is one the check applies to"
          : `${r.outputTail}\n[atelier] ran in a Cloudflare container in ${r.seconds}s, exit ${r.exitCode}${req.merged ? `, on the merge with main at ${state.mainHead?.slice(0, 8)}` : ""}`,
        where: "sandbox",
        mainHead: state.mainHead,
        ...(r.log ? { log: r.log } : {}),
        ...(r.notApplicable ? { notApplicable: true } : req.merged ? { merged: true } : {}),
      });
    }
    state.recorded = true;
  }
}
