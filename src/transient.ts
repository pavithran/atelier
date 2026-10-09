// Failures a retry can cure, and the line a failed request writes to Workers
// Logs (t349). An Error logged as an object reaches Workers Logs as its
// stack alone, so the line spells out the message and the code.

// What an error says of itself: its name, code and message, and its stack.
// Across a binding an error can arrive as a plain object or a string, so
// each field is read only when it is there.
export function errorFields(err: unknown): { name: string; code: string; message: string; stack: string } {
  const e = (err ?? {}) as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown };
  const text = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
  return {
    name: text(e.name),
    code: text(e.code),
    message: typeof err === "string" ? err : text(e.message),
    stack: text(e.stack),
  };
}

// One line for Workers Logs: what was asked, and the error's code and
// message, then its stack.
export function errorLine(what: string, err: unknown): string {
  const f = errorFields(err);
  const head = `${what} failed: ${f.name || "Error"} code=${f.code || "none"} message=${JSON.stringify(f.message)}`;
  return f.stack ? `${head}\n${f.stack}` : head;
}

// Whether a Durable Object or the runtime marks the error as one a retry
// may cure: a Durable Object reset, overloaded or briefly unreachable sets
// `retryable` or `overloaded` on what it throws.
export function retryableByRuntime(err: unknown): boolean {
  const e = (err ?? {}) as { retryable?: unknown; overloaded?: unknown };
  return e.retryable === true || e.overloaded === true;
}

// How long the caller is asked to wait before it retries a 503, in seconds.
export const RETRY_AFTER = 2;

// The backoff's first delay ceiling, in milliseconds. Production keeps
// BASE_RETRY_MS; a test that injects transient failures lowers it with
// setRetryBaseMs so that the backoff takes milliseconds, not seconds. The
// setting lives in the module, which each spec file loads afresh.
export const BASE_RETRY_MS = 250;
let retryBaseMs = BASE_RETRY_MS;

// For tests only: set the first delay ceiling of every withRetry that is not
// given its own `baseMs`; no argument restores the production delay.
export function setRetryBaseMs(ms: number = BASE_RETRY_MS): void {
  retryBaseMs = ms;
}

// Runs one step against Artifacts, retrying a failure `permanent` does not
// claim, with exponential backoff and jitter so that many callers failing
// together do not retry together. The last failure is thrown as it is.
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 4, baseMs = retryBaseMs, permanent = () => false, sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)), onRetry }:
  { attempts?: number; baseMs?: number; permanent?: (err: unknown) => boolean; sleep?: (ms: number) => Promise<void>; onRetry?: (err: unknown, attempt: number) => void } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || permanent(err)) throw err;
      onRetry?.(err, attempt);
      const ceiling = baseMs * 2 ** (attempt - 1);
      await sleep(ceiling / 2 + Math.random() * ceiling / 2);
    }
  }
}
