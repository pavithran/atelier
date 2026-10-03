// Runs a project's required checks in a Cloudflare container, so that an
// Observed result no longer depends on the machine of the agent being judged.
//
// The container never holds a credential and cannot reach the repository:
// the Worker reads the item's exact tree from Artifacts and streams it into
// `tar -x`. The container starts with the Internet off; the only host it can
// reach is the npm registry, through a pass-through gateway that allows GET and
// HEAD. Results are written to the Ledger by this code alone, marked "sandbox",
// which nothing posted to the public API can claim.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { changedPaths, forkPoint, repoReader } from "../diff";
import { END_OF_ARCHIVE } from "./tar";
import { writeTree } from "./tree";

const IMAGE = "cloudflare/debian-trixie"; // Cloudflare-managed: Node 24 on Debian Trixie slim
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const WORKDIR = "/workspace";
const STEP_SECONDS = 600;
const OUTPUT_TAIL = 4000;
export const EGRESS_HOSTS = ["registry.npmjs.org"];

export interface RunRequest {
  runId: string;
  project: string;
  itemId: string;
  baselineRepo: string;
  fork: string;
  head: string;            // the head the caller asked about; the run refuses any other
  checks: string[];
  requestedBy: string;
}

export interface CheckResult {
  claim: string;
  passed: boolean;
  exitCode: number;
  seconds: number;
  outputTail: string;
}

export interface RunState {
  status: "queued" | "running" | "done" | "failed";
  request: RunRequest;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  changedPaths?: string[];
  results?: CheckResult[];
  recorded?: boolean;      // whether the Ledger accepted the results
  error?: string;
}

// Pass-through egress: the npm registry only, reads only, nothing added.
export class Egress extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!EGRESS_HOSTS.includes(url.hostname) || (request.method !== "GET" && request.method !== "HEAD")) {
      return new Response(`Atelier's check sandbox may not reach ${request.method} ${url.hostname}`, { status: 403 });
    }
    return fetch(request);
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

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<RunState>("state");
    if (!state || state.status !== "queued") return;
    state.status = "running";
    state.startedAt = new Date().toISOString();
    await this.ctx.storage.put("state", state);
    try {
      await this.run(state);
      state.status = "done";
    } catch (err) {
      state.status = "failed";
      state.error = String((err as Error)?.message ?? err).slice(0, 1000);
    } finally {
      state.finishedAt = new Date().toISOString();
      await this.ctx.storage.put("state", state);
      const container = this.ctx.container;
      if (container?.running) await container.destroy().catch(() => {});
    }
  }

  private async run(state: RunState): Promise<void> {
    const req = state.request;
    using fork = await this.env.ARTIFACTS.get(req.fork);
    using baseline = await this.env.ARTIFACTS.get(req.baselineRepo);
    const fp = await forkPoint(fork, baseline);
    if (!fp) throw new Error("the workspace shares no history with the baseline");
    if (fp.head !== req.head) throw new Error(`the workspace moved to ${fp.head.slice(0, 8)} after ${req.head.slice(0, 8)} was requested`);
    const reader = repoReader(fork);
    state.changedPaths = await changedPaths(reader, fp.baseTree, fp.headTree);
    await this.ctx.storage.put("state", state);

    const container = this.ctx.container;
    if (!container) throw new Error("no container is configured for CheckRunner");
    for (const host of EGRESS_HOSTS) await container.interceptOutboundHttps(host, this.ctx.exports.Egress({ props: {} }));
    container.start({
      image: IMAGE,
      entrypoint: ["sleep", "infinity"],
      enableInternet: false,
      instance: "standard-1",
      env: {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: "/root",
        CI: "1",
        NODE_EXTRA_CA_CERTS: CA,
        npm_config_cafile: CA,
        npm_config_update_notifier: "false",
      },
    });

    const mkdir = await (await container.exec(["mkdir", "-p", WORKDIR])).output();
    if (mkdir.exitCode !== 0) throw new Error("could not create the workspace directory");
    const pipe = new IdentityTransformStream();
    const writer = pipe.writable.getWriter();
    const unpack = await container.exec(["tar", "-x", "-f", "-", "-C", WORKDIR], { stdin: pipe.readable, stdout: "ignore", stderr: "pipe" });
    const written = (async () => {
      try {
        await writeTree(reader, fp.headTree, (b) => writer.write(b));
        await writer.write(END_OF_ARCHIVE);
        await writer.close();
      } catch (err) {
        await writer.abort(err);
        throw err;
      }
    })();
    const [unpacked] = await Promise.all([unpack.output(), written]);
    if (unpacked.exitCode !== 0) throw new Error(`tar failed: ${new TextDecoder().decode(unpacked.stderr).slice(0, 500)}`);

    const decoder = new TextDecoder();
    state.results = [];
    for (const claim of req.checks) {
      const t0 = Date.now();
      const proc = await container.exec(["timeout", "--kill-after=5", String(STEP_SECONDS), "sh", "-c", claim], { cwd: WORKDIR, stderr: "combined" });
      const out = await proc.output();
      const timedOut = out.exitCode === 124 ? `\n[atelier] stopped after ${STEP_SECONDS}s` : "";
      state.results.push({
        claim,
        passed: out.exitCode === 0,
        exitCode: out.exitCode,
        seconds: Math.round((Date.now() - t0) / 1000),
        outputTail: tail(decoder.decode(out.stdout) + timedOut),
      });
      await this.ctx.storage.put("state", state);
    }

    // Record in the Ledger. It refuses evidence for a head the item has moved past.
    const ledger = this.env.LEDGER.get(this.env.LEDGER.idFromName(`project:${req.project}`));
    const at = new Date().toISOString();
    for (const r of state.results) {
      await ledger.addEvidence({
        itemId: req.itemId,
        claim: r.claim,
        grade: "observed",
        head: fp.head,
        passed: r.passed,
        by: "atelier/sandbox",
        at,
        changedPaths: state.changedPaths,
        outputTail: `${r.outputTail}\n[atelier] ran in a Cloudflare container in ${r.seconds}s, exit ${r.exitCode}`,
        where: "sandbox",
      });
    }
    state.recorded = true;
  }
}
