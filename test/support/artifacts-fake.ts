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

// The Worker's bindings with the Artifacts binding replaced by `artifacts`.
// The real binding is left out of the copy rather than overwritten, so a spec
// that reaches it fails on the spot instead of calling the live service
// (vitest.config.ts runs with remoteBindings: false, so the real binding
// throws "needs to be run remotely" on first use).
export function bindingsWith<E extends object>(env: E, artifacts: unknown, extra: Record<string, unknown> = {}): E {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(env)) if (key !== "ARTIFACTS") copy[key] = (env as Record<string, unknown>)[key];
  return { ...copy, ...extra, ARTIFACTS: artifacts } as E;
}

// A repository's commit list as claims read it (headOf): one commit, so a
// head read answers without a failure and a retry.
export const FAKE_HEAD = "1".repeat(40);
export const fakeLog = async () => [{ hash: FAKE_HEAD, parents: [] as string[] }];
