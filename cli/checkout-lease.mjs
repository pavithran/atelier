// The checkout lease on the CLI's side (G9, src/checkout-lease.ts): atelier
// merge and atelier ship each take it once before they touch the registered
// checkout and release it once when they are done with it.
//
// A take refused because another holder has the checkout waits, saying who
// holds it (again whenever the holder changes), and takes it once it is
// free; a holder that died stops blocking after the server's liveness limit.
// While held, a heartbeat renews it. A command that ends through die()
// (process.exit, where no finally runs) still releases it: an exit handler
// makes the release synchronously, in a child process. Only a process killed
// outright leaves it to lapse. A server that keeps no checkout lease (one
// from before G9) answers 404; the command then goes on without it and says
// so once.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { describeCheckoutLease } from "../src/checkout-lease.ts";

const POLL_MS = () => Number(process.env.ATELIER_CHECKOUT_POLL_MS ?? 5000);
const BEAT_MS = () => Number(process.env.ATELIER_CHECKOUT_BEAT_MS ?? 60_000);

// Takes the lease for `kind` ("landing" or "ship"). `request(method, path,
// body)` throws a RequestError on a refusal; `sync` is { url, headers } for
// the exit handler's release; `head()` reads the checkout's head now. The
// answer's release(head) frees it; `fact` is a change to the checkout made
// outside the lease, already printed.
export async function takeCheckoutLease({ request, project, kind, item, what, head, sync, print = (line) => console.log(line), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const path = `/projects/${encodeURIComponent(project)}/checkout-lease`;
  const id = randomUUID().replace(/-/g, "");
  const doing = what ?? (kind === "ship" ? "ship" : `${item}'s merge`);
  let said = null, answer;
  for (;;) {
    try {
      answer = await request("POST", path, { action: "take", id, kind, ...(item ? { item } : {}), host: hostname(), pid: process.pid, ...(head() ? { head: head() } : {}) });
      break;
    } catch (error) {
      if (error?.refusal?.code === "checkout_lease") {
        const holder = /held by (.*?); landing and shipping/.exec(error.refusal.detail)?.[1] ?? error.refusal.detail;
        if (holder !== said) print(`${doing} waits for ${project}'s registered checkout: it is held by ${holder}.`);
        said = holder;
        await sleep(POLL_MS());
        continue;
      }
      if (error?.refusal?.code === "not_found" || error?.refusal?.code === "404") {
        print(`The server keeps no checkout lease (it is older than Atelier 2.0's G9), so ${doing} goes on without one.`);
        return { lease: null, fact: null, check: async () => null, release: async () => {} };
      }
      throw error;
    }
  }
  if (said) print(`${project}'s registered checkout is free; ${doing} goes on.`);
  if (answer?.replaced) print(`${doing} took over ${project}'s checkout lease from ${describeCheckoutLease(answer.replaced)}, whose holder stopped renewing it.`);
  const fact = answer?.fact ?? null;
  if (fact) print(`Fact: ${fact.detail}.\nnext: ${fact.next}`);
  // A lease lost (its holder stalled past the limit and another took it
  // over) is a fact the holder acts on: check() answers it at each step
  // boundary, and the command stops there, so no further step touches the
  // checkout. The heartbeat notes a loss as soon as it sees one.
  let lost = null, done = false;
  const loseTo = (refusal) => {
    lost ??= {
      code: "checkout_lease_lost",
      detail: `${doing} lost ${project}'s checkout lease: ${refusal.detail}. It stopped before its next step, so nothing more of it touched the checkout`,
      next: `look at the checkout (git status, git log -3) once its holder is done, then run the same command again: it waits for the checkout`,
    };
  };
  const renew = () => request("POST", path, { action: "renew", id }).catch((error) => {
    if (error?.refusal?.code === "no_checkout_lease") loseTo(error.refusal);
  });
  const beat = setInterval(renew, BEAT_MS());
  beat.unref?.();
  // The release a die() would otherwise skip, made in a child process since
  // an exit handler cannot wait for a request.
  const onExit = () => {
    if (done) return;
    done = true;
    clearInterval(beat);
    const h = (() => { try { return head(); } catch { return null; } })();
    syncPost(sync, path, { action: "release", id, ...(h ? { head: h } : {}) });
  };
  process.on("exit", onExit);
  return {
    lease: answer?.lease ?? null, fact,
    // At a step boundary: renews the lease and answers the fact of its loss,
    // or null while it is held.
    check: async () => { if (!lost) await renew(); return lost; },
    release: async (at) => {
      if (done) return;
      done = true;
      clearInterval(beat);
      process.off("exit", onExit);
      const h = at ?? (() => { try { return head(); } catch { return null; } })();
      try { await request("POST", path, { action: "release", id, ...(h ? { head: h } : {}) }); }
      catch (error) { print(`Warning: ${project}'s checkout lease could not be released (${error.message}); it lapses after the server's liveness limit.`); }
    },
  };
}

// One POST made synchronously, for an exit handler: a child Node process
// sends it, trying three times (1 and 2 seconds apart) on a network failure
// or a 408, 429 or 5xx, as request() does, and the parent waits at most 15
// seconds. The request (with its credential) goes on the child's stdin,
// never its arguments or environment. Answers whether the server took it.
export function syncPost(sync, path, body) {
  if (!sync?.url) return false;
  const script = `let s="";process.stdin.on("data",(c)=>s+=c);process.stdin.on("end",async()=>{const r=JSON.parse(s);for(const wait of [0,1000,2000]){await new Promise((ok)=>setTimeout(ok,wait));try{const a=await fetch(r.url,{method:"POST",headers:r.headers,body:r.body,signal:AbortSignal.timeout(4000)});if(a.ok)process.exit(0);if(a.status!==408&&a.status!==429&&a.status<500)process.exit(2);}catch{}}process.exit(1);});`;
  const r = spawnSync(process.execPath, ["-e", script], { input: JSON.stringify({ url: `${sync.url}${path}`, headers: { ...sync.headers, "content-type": "application/json" }, body: JSON.stringify(body) }), timeout: 15_000, stdio: ["pipe", "ignore", "ignore"] });
  return r.status === 0;
}
