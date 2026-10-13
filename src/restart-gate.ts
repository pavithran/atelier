// The Ledger's restart after a deploy (t586): a Durable Object that keeps
// receiving requests keeps running the code it started with, so a Ledger
// that learns it is on older code asks to be reset with ctx.abort(). The
// gate fires that reset only between requests: it counts the calls in
// flight (every Ledger method enters and leaves it, and background work
// such as a notification's delivery holds it), and once a restart is
// requested it aborts the first time the count has stayed at zero for
// settleMs. A Ledger that is never idle that long is reset anyway after
// maxWaitMs, so the new code is served within a minute of a deploy.
export class RestartGate {
  #inflight = 0;
  #pending: string | null = null;
  #idle: ReturnType<typeof setTimeout> | null = null;
  #forced: ReturnType<typeof setTimeout> | null = null;
  #fired = false;
  readonly #abort: (reason: string) => void;
  readonly settleMs: number;
  readonly maxWaitMs: number;

  constructor(abort: (reason: string) => void, settleMs = 50, maxWaitMs = 30_000) {
    this.#abort = abort;
    this.settleMs = settleMs;
    this.maxWaitMs = maxWaitMs;
  }

  get inflight(): number { return this.#inflight; }
  get pending(): boolean { return this.#pending !== null; }

  enter(): void { this.#inflight++; }

  leave(): void {
    this.#inflight = Math.max(0, this.#inflight - 1);
    if (this.#inflight === 0 && this.#pending !== null) this.#armIdle();
  }

  // Asks for a restart; false when one is already on its way.
  request(reason: string): boolean {
    if (this.#pending !== null || this.#fired) return false;
    this.#pending = reason;
    this.#forced = setTimeout(() => this.#fire(`${reason}; still busy after ${Math.round(this.maxWaitMs / 1000)} s`), this.maxWaitMs);
    if (this.#inflight === 0) this.#armIdle();
    return true;
  }

  // Runs fn as a call in flight: the count drops when it returns, throws,
  // or, for a promise, settles.
  run<T>(fn: () => T): T {
    this.enter();
    let out: T;
    try { out = fn(); } catch (err) { this.leave(); throw err; }
    if (out && typeof (out as { then?: unknown }).then === "function") {
      return Promise.resolve(out).finally(() => this.leave()) as T;
    }
    this.leave();
    return out;
  }

  // Holds the gate until background work settles.
  hold<T>(work: Promise<T>): Promise<T> {
    this.enter();
    return work.finally(() => this.leave());
  }

  #armIdle(): void {
    if (this.#idle !== null) return;
    this.#idle = setTimeout(() => {
      this.#idle = null;
      if (this.#inflight === 0 && this.#pending !== null) this.#fire(this.#pending);
    }, this.settleMs);
  }

  #fire(reason: string): void {
    if (this.#fired) return;
    this.#fired = true;
    if (this.#idle !== null) clearTimeout(this.#idle);
    if (this.#forced !== null) clearTimeout(this.#forced);
    this.#idle = this.#forced = null;
    this.#pending = null;
    this.#abort(reason);
  }
}

// Wraps every method on a class's prototype so each call runs through the
// gate gateOf finds for its instance; an instance without a gate (as while
// its constructor runs) calls straight through.
export function gateMethods(proto: object, gateOf: (self: object) => RestartGate | undefined): void {
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor") continue;
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || typeof d.value !== "function") continue;
    const fn = d.value as (...args: unknown[]) => unknown;
    Object.defineProperty(proto, name, {
      ...d,
      value: function (this: object, ...args: unknown[]) {
        const gate = gateOf(this);
        return gate ? gate.run(() => fn.apply(this, args)) : fn.apply(this, args);
      },
    });
  }
}
