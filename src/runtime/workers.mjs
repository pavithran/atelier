// What the server's sources import from `cloudflare:workers` and
// `cloudflare:workflows`, for Node (src/runtime/loader.mjs maps both here).
// DurableObject keeps the constructor's contract (ctx and env on the
// instance); the Workflow classes exist so the modules that name them load,
// and a landing Workflow is never started under Node (design section 4.2:
// `--workflow` is dropped).
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkflowEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class NonRetryableError extends Error {
  constructor(message, name) {
    super(message);
    this.name = name ?? "NonRetryableError";
  }
}

export const env = {};
