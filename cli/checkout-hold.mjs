// The owner's side of the checkout lease (G9, cli/checkout-lease.mjs), bound
// to this CLI's server, credential and requests. Kept apart from that module,
// which takes them as arguments, since this one imports cli/atelier.mjs.
import { spawnSync } from "node:child_process";
import { OWNER, apiToken, die, ownerActing, request, server } from "./atelier.mjs";
import { syncPost, takeCheckoutLease } from "./checkout-lease.mjs";

// The owner's take for a command run in the registered checkout `cwd`: the
// one call atelier merge and atelier ship make before touching it. A failure
// other than a held checkout ends the command, as any refused request does.
export async function holdCheckout({ project, kind, item, what, cwd }) {
  const head = () => {
    const r = spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  try {
    return await takeCheckoutLease({
      request: (method, path, body) => request(method, path, body, OWNER), project, kind, item, what, head,
      sync: { url: `${server()}/api`, headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": OWNER, ...ownerActing("POST") } },
    });
  } catch (error) { die(error.message, error.code ?? 1); }
}

// At a step boundary of a command holding the checkout: a lease lost to a
// takeover ends the command here, as a fact with its next, before any
// further step touches the checkout. `before` runs first (ship records its
// deploy as failed).
export async function stayHeld(lease, before) {
  const lost = await lease?.check?.();
  if (!lost) return;
  await before?.(lost);
  die(`Fact: ${lost.detail}.\nnext: ${lost.next}`);
}

// The same endpoint for a POST an exit handler makes (syncPost); answers
// whether the server took it.
export function postOnExit(path, body) {
  return syncPost({ url: `${server()}/api`, headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": OWNER, ...ownerActing("POST") } }, path, body);
}
