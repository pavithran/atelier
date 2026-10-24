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
