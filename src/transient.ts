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
