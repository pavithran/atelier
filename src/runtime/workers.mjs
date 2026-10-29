// What the server's sources import from `cloudflare:workers`, for Node
// (src/runtime/loader.mjs maps it here). DurableObject keeps the
// constructor's contract (ctx and env on the instance). The landing Workflow,
// the one Workflow, is gone (task 6), and with it `cloudflare:workflows`.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export const env = {};
