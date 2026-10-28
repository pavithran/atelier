// The owner's side of the checkout lease (G9, cli/checkout-lease.mjs), bound
// to this CLI's server, credential and requests. Kept apart from that module,
// which takes them as arguments, since this one imports cli/atelier.mjs.
import { spawnSync } from "node:child_process";
import { OWNER, apiToken, die, request, server } from "./atelier.mjs";
import { syncPost, takeCheckoutLease } from "./checkout-lease.mjs";

// The owner's take for a command run in the registered checkout `cwd`: the
// one call atelier merge and atelier ship make before touching it. A failure
// other than a held checkout ends the command, as any refused request does.
export async function holdCheckout({ project, kind, item, cwd }) {
  const head = () => {
    const r = spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  try {
    return await takeCheckoutLease({
      request: (method, path, body) => request(method, path, body, OWNER), project, kind, item, head,
      sync: { url: `${server()}/api`, headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": OWNER } },
    });
  } catch (error) { die(error.message, error.code ?? 1); }
}

// The same endpoint for a POST an exit handler makes (syncPost).
export function postOnExit(path, body) {
  syncPost({ url: `${server()}/api`, headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": OWNER } }, path, body);
}
