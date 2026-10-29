// The Vitest names the Workers tests used, on node --test (Atelier 2.0, task
// 7): the tests and hooks are node:test's, `expect` and the spies are
// Vitest's own library (which needs no Vitest run), and the few `vi` calls
// that read Vitest's run state (waitFor, the fake clock) are written here.
// A test's timeout is its third argument or an options object before its
// function, as in Vitest.
import { format } from "node:util";
import * as nodeTest from "node:test";
import { expect, vi as vitestVi } from "vitest";

export { expect };
export const beforeAll = nodeTest.before;
export const afterAll = nodeTest.after;
export const beforeEach = nodeTest.beforeEach;
export const afterEach = nodeTest.afterEach;
export const describe = nodeTest.describe;

type Fn = () => unknown;
// Tests in a file run one at a time, so the finishers of the test running
// now are one list.
let finishers: Fn[] = [];
export function onTestFinished(fn: Fn): void { finishers.push(fn); }

const wrap = (fn: Fn) => async () => {
  finishers = [];
  try { await fn(); } finally {
    const run = finishers.reverse();
    finishers = [];
    for (const f of run) await f();
  }
};
type Each = <T>(cases: readonly T[]) => (name: string, fn: (...args: any[]) => unknown, timeout?: number) => void;
type Options = { timeout?: number };
type It = ((name: string, fn: Fn | Options, timeout?: number | Fn) => void) & { each: Each; skip: (name: string, fn?: Fn) => void };
// it(name, fn, timeout) or it(name, { timeout }, fn), as Vitest takes either.
const define = (name: string, a: Fn | Options, b?: number | Fn) => {
  const [fn, timeout] = typeof a === "function" ? [a, b as number | undefined] : [b as Fn, a.timeout];
  nodeTest.test(name, timeout ? { timeout } : {}, wrap(fn));
};
export const it: It = Object.assign(define, {
  each: (<T>(cases: readonly T[]) => (name: string, fn: (...args: any[]) => unknown, timeout?: number) => {
    for (const c of cases) {
      const args = Array.isArray(c) ? c : [c];
      define(/%[sdjio]/.test(name) ? format(name, ...args) : name, () => fn(...args), timeout);
    }
  }) as Each,
  skip: (name: string) => { nodeTest.test.skip(name); },
});
export const test = it;

// The fake clock: Date alone, which is all the tests fake.
let clock: { restore(): void } | null = null;
export const vi = Object.assign(Object.create(vitestVi) as typeof vitestVi, {
  async waitFor<T>(fn: () => T | Promise<T>, options: number | { timeout?: number; interval?: number } = {}): Promise<T> {
    const { timeout = 1000, interval = 50 } = typeof options === "number" ? { timeout: options } : options;
    const end = Date.now() + timeout;
    for (;;) {
      try { return await fn(); } catch (err) {
        if (Date.now() >= end) throw err;
        await new Promise((ok) => setTimeout(ok, interval));
      }
    }
  },
  useFakeTimers(_options?: unknown) {
    if (!clock) { nodeTest.mock.timers.enable({ apis: ["Date"], now: Date.now() }); clock = { restore: () => nodeTest.mock.timers.reset() }; }
    return vi;
  },
  setSystemTime(at: Date | number | string) {
    vi.useFakeTimers();
    nodeTest.mock.timers.setTime(new Date(at).getTime());
    return vi;
  },
  useRealTimers() { clock?.restore(); clock = null; return vi; },
});
