import worker from "../src/index.ts";

// Signs in through the Worker's own login route, as a browser does, and
// returns the Cookie header value of the session it issued. The session id is
// random and stored hashed, so a test cannot compute it from the token.
export async function signIn(token: string, bindings: Env): Promise<string> {
  const res = await worker.fetch(new Request("https://atelier.test/login", { method: "POST", body: new URLSearchParams({ token }) }), bindings);
  const set = res.headers.get("set-cookie") ?? "";
  const id = /^atelier=([a-f0-9]{64});/.exec(set)?.[1];
  if (res.status !== 303 || !id) throw new Error(`sign-in failed: ${res.status} ${set}`);
  return `atelier=${id}`;
}
