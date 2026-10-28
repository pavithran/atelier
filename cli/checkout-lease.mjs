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
export async function takeCheckoutLease({ request, project, kind, item, head, sync, print = (line) => console.log(line), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const path = `/projects/${encodeURIComponent(project)}/checkout-lease`;
  const id = randomUUID().replace(/-/g, "");
  const doing = kind === "ship" ? "ship" : `${item}'s merge`;
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
        return { lease: null, fact: null, release: async () => {} };
      }
      throw error;
    }
  }
  if (said) print(`${project}'s registered checkout is free; ${doing} goes on.`);
  if (answer?.replaced) print(`${doing} took over ${project}'s checkout lease from ${describeCheckoutLease(answer.replaced)}, whose holder stopped renewing it.`);
  const fact = answer?.fact ?? null;
  if (fact) print(`Fact: ${fact.detail}.\nnext: ${fact.next}`);
  let lost = false, done = false;
  const beat = setInterval(() => {
    request("POST", path, { action: "renew", id }).catch((error) => {
      if (lost || error?.refusal?.code !== "no_checkout_lease") return;
      lost = true;
      print(`Warning: ${doing} no longer holds ${project}'s checkout lease: ${error.refusal.detail}.`);
    });
  }, BEAT_MS());
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
// sends it and the parent waits at most ten seconds. The request (with its
// credential) goes on the child's stdin, never its arguments or environment.
export function syncPost(sync, path, body) {
  if (!sync?.url) return;
  const script = `let s="";process.stdin.on("data",(c)=>s+=c);process.stdin.on("end",async()=>{const r=JSON.parse(s);try{await fetch(r.url,{method:"POST",headers:r.headers,body:r.body,signal:AbortSignal.timeout(8000)});}catch{}});`;
  spawnSync(process.execPath, ["-e", script], { input: JSON.stringify({ url: `${sync.url}${path}`, headers: { ...sync.headers, "content-type": "application/json" }, body: JSON.stringify(body) }), timeout: 10_000, stdio: ["pipe", "ignore", "ignore"] });
}

