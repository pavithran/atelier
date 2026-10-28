// The locks that serialize a push with the changes that end its grant
// (Atelier 2.0, task 5; docs/branches.md). Each key is a readers-writer lock
// whose waiters are served strictly in turn: a writer waits for every holder
// before it, and a reader queued behind a writer waits for that writer. A
// waiter that gives up (its time runs out, or its signal aborts) leaves the
// queue and is never granted; a later waiter is still served only once every
// holder before it has released.
//
// Keys, always taken in this order, so no two holders wait on each other:
//   grant:ID        a push (writer), and a revocation of that grant (writer);
//   project:KEY     a push and a change to one ordinary task (readers), and a
//                   change that may reach several tasks: a plan's, or the
//                   stage tick's (writer);
//   task:KEY/tN     a push to t/N and every change that ends or rotates its
//                   grant (writers).
import { PUSH_MAX_MS } from "./http.mjs";

// The longest a waiter waits: a push's own limit, and a little more for its
// answer. A push's backend is ended at PUSH_MAX_MS.
export const LOCK_WAIT_MS = PUSH_MAX_MS + 30_000;

class Slot {
  readers = 0;
  writer = false;
  queue = [];
  get idle() { return !this.readers && !this.writer && !this.queue.length; }
  pump() {
    while (this.queue.length) {
      const next = this.queue[0];
      if (next.kind === "w" ? this.writer || this.readers : this.writer) return;
      this.queue.shift();
      if (next.kind === "w") this.writer = true; else this.readers++;
      next.grant();
    }
  }
}

export class Locks {
  #slots = new Map();
  // Resolves to the release once held; rejects (code "push_running", or the
  // signal's reason) when given up. `kind` is "r" or "w".
  acquire(key, kind = "w", { waitMs = LOCK_WAIT_MS, signal } = {}) {
    let slot = this.#slots.get(key);
    if (!slot) this.#slots.set(key, slot = new Slot());
    return new Promise((ok, fail) => {
      let timer;
      const waiter = { kind };
      const leave = (error) => {
        const at = slot.queue.indexOf(waiter);
        if (at < 0) return;
        slot.queue.splice(at, 1);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        slot.pump();
        if (slot.idle) this.#slots.delete(key);
        fail(error);
      };
      const onAbort = () => leave(signal.reason ?? new Error("aborted"));
      waiter.grant = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        let released = false;
        ok(() => {
          if (released) return;
          released = true;
          if (kind === "w") slot.writer = false; else slot.readers--;
          slot.pump();
          if (slot.idle && this.#slots.get(key) === slot) this.#slots.delete(key);
        });
      };
      if (signal?.aborted) { fail(signal.reason ?? new Error("aborted")); return; }
      slot.queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => leave(Object.assign(new Error(`${key} is still held by a push`), { code: "push_running" })), waitMs);
      timer.unref?.();
      slot.pump();
    });
  }
  // Several keys in order, released together; on any failure, those taken go.
  async acquireAll(wants, options) {
    const held = [];
    const all = () => { for (const release of held.splice(0).reverse()) release(); };
    try {
      for (const [key, kind] of wants) held.push(await this.acquire(key, kind, options));
    } catch (error) { all(); throw error; }
    return all;
  }
  // Whether nothing holds or waits for `key`.
  idle(key) { return !this.#slots.has(key); }
}
