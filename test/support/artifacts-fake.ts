// A local stand-in for the Artifacts binding, for tests of token revocation.
// It answers from memory and makes no network call. A method it does not
// implement throws, so a test never reaches the live service by accident.
// Every credential here is a dummy.

export type Tok = { id: string; repo: string; scope: string; revoked: boolean };
export type Revoking = "ok" | "fails" | "missing" | "gone";

export function fakeArtifacts() {
  const tokens = new Map<string, Tok>();
  let n = 0;
  const state = { revoking: "ok" as Revoking };
  const repoApi = (repo: string) => ({
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    createToken: async (scope: string) => {
      const id = `tok${++n}`;
      tokens.set(id, { id, repo, scope, revoked: false });
      return { id, plaintext: `art_secret_${id}`, scope, expiresAt: new Date(Date.now() + 8 * 3600e3).toISOString() };
    },
    revokeToken: async (id: string) => {
      if (state.revoking === "fails") throw new Error("Artifacts: 503 service unavailable");
      if (state.revoking === "missing") return false;
      if (state.revoking === "gone") throw Object.assign(new Error("token not found"), { code: "NOT_FOUND" });
      const t = tokens.get(id);
      if (t) t.revoked = true;
      return !!t;
    },
    log: fakeLog,
    [Symbol.dispose]() {},
  });
  const strict = <T extends object>(what: string, api: T): T => new Proxy(api, {
    get(target, prop, receiver) {
      if (prop in target || typeof prop === "symbol" || prop === "then") return Reflect.get(target, prop, receiver);
      return () => { throw new Error(`the Artifacts fake has no ${what}.${prop}`); };
    },
  });
  const artifacts = strict("binding", {
    get: async (repo: string) => strict(`repo.${repo}`, repoApi(repo)),
  }) as unknown as Artifacts;
  const live = (id: string) => !tokens.get(id)!.revoked;
  const writes = (repo: string) => [...tokens.values()].filter((t) => t.repo === repo && t.scope === "write").map((t) => t.id);
  return { artifacts, state, live, writes };
}

// Members a spec's fake does not implement, recorded as they are reached.
// Code that swallows errors (mainHeadOf returns null on any failure) can hide
// the throw, so a spec asserts this list is empty outside that catch, by
// calling expectNoStrayArtifactsAccess() in an afterEach.
const stray: string[] = [];

// Wraps a fake so that reading a member it lacks is recorded and throws.
function guarded<T extends object>(what: string, api: T): T {
  return new Proxy(api, {
    get(target, prop, receiver) {
      if (prop in target || typeof prop === "symbol" || prop === "then") return Reflect.get(target, prop, receiver);
      stray.push(`${what}.${String(prop)}`);
      return () => { throw new Error(`the Artifacts fake has no ${what}.${String(prop)}`); };
    },
  });
}

function guardedBinding(artifacts: unknown): unknown {
  const binding = artifacts as { get?: (repo: string) => Promise<object> };
  return guarded("binding", {
    ...binding,
    get: async (repo: string) => guarded(`repo.${repo}`, await binding.get!(repo)),
  });
}

export function strayArtifactsAccesses(): string[] { return [...stray]; }

// Fails the running test if a guarded fake was asked for something it lacks,
// whether or not the caller caught the error; clears the record either way.
export function expectNoStrayArtifactsAccess() {
  const seen = stray.splice(0);
  if (seen.length) throw new Error(`a spec reached Artifacts members its fake lacks: ${seen.join(", ")}`);
}

// The Worker's bindings with the Artifacts binding replaced by a guarded
// `artifacts`. The real binding is left out of the copy rather than
// overwritten (vitest.config.ts runs with remoteBindings: false, so the real
// binding throws "needs to be run remotely" on first use).
export function bindingsWith<E extends object>(env: E, artifacts: unknown, extra: Record<string, unknown> = {}): E {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(env)) if (key !== "ARTIFACTS") copy[key] = (env as Record<string, unknown>)[key];
  return { ...copy, ...extra, ARTIFACTS: guardedBinding(artifacts) } as E;
}

// A repository's commit list as claims read it (headOf): one commit, so a
// head read answers without a failure and a retry.
export const FAKE_HEAD = "1".repeat(40);
export const fakeLog = async () => [{ hash: FAKE_HEAD, parents: [] as string[] }];
