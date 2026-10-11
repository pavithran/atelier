import { afterEach, expect, it, vi } from "vitest";
import { runnerGitRequest, type RunnerGitRuntime } from "../src/runner-git.ts";

// t528: the runner Git route buffered whole packs in Worker memory, both the
// push upstream and the clone back, so fresh clones through
// /git/runner/... failed with HTTP 500 "expected packfile" once the
// repository's pack passed ~100 MB. Packs now pass through as streams, and the
// short-lived upstream token is revoked only after the response body has
// ended or been cancelled, never before it is read.

afterEach(() => vi.restoreAllMocks());

const CHUNKS = 8, SIZE = 64 * 1024;

function fixture(chunks = CHUNKS) {
  const events: string[] = [];
  const runtime: RunnerGitRuntime = {
    ledger: () => ({
      runnerGit: async () => ({ parent: "parent", actor: "codex/gpt-6-astra", id: "t1", generation: 1 }),
      assertRunnerJob: async () => undefined,
      item: async () => ({ fork: "demo--t1" }),
    }),
    token: async () => ({ id: "tok", hash: "h", actor: "runner", runner: "home:studio", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
    artifacts: { get: (async () => ({
      info: async () => ({ remote: "https://git.test/demo--t1.git" }),
      createToken: async () => { events.push("create"); return { id: "up", plaintext: "upstream-secret" }; },
      revokeToken: async (id: string) => { events.push(`revoke:${id}`); return true; },
      [Symbol.dispose]() { events.push("dispose"); },
    })) as unknown as RunnerGitRuntime["artifacts"]["get"] },
  };
  // An upstream pack that yields its chunks lazily and records each read.
  const pulled: number[] = [];
  let sent = 0;
  const pack = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks) { events.push("upstream:end"); controller.close(); return; }
      pulled.push(sent);
      controller.enqueue(new Uint8Array(SIZE).fill(sent++));
    },
  }, { highWaterMark: 0 });
  const seen: { body?: unknown } = {};
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    seen.body = init?.body;
    return new Response(pack, { headers: { "content-type": "application/x-git-upload-pack-result", "set-cookie": "x=1" } });
  });
  const request = (body = "0032want " + "a".repeat(40) + "\n00000009done\n") => runnerGitRequest(
    new Request("https://atelier.test/git/runner/demo/t1.git/git-upload-pack", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/x-git-upload-pack-request" }, body }),
    new URL("https://atelier.test/git/runner/demo/t1.git/git-upload-pack"), runtime);
  return { events, pulled, seen, request };
}

it("streams the pack to the caller, and revokes the upstream token only after the body has ended", async () => {
  const t = fixture();
  const res = await t.request();
  // Returned before a single chunk of the pack was read, and still holding the token.
  expect(t.pulled).toEqual([]);
  expect(t.events).toEqual(["create"]);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-result");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("set-cookie")).toBeNull();
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(bytes.length).toBe(CHUNKS * SIZE);
  for (let i = 0; i < CHUNKS; i++) expect(bytes[i * SIZE]).toBe(i);
  expect(t.events).toEqual(["create", "upstream:end", "revoke:up", "dispose"]);
  // The caller never sees the upstream credential.
  expect(new TextDecoder().decode(bytes)).not.toContain("upstream-secret");
});

// A Worker has 128 MiB. A pack larger than that budget passes through with at
// most a few chunks read ahead of the caller at any moment, so memory is bounded
// by the chunk size, not the pack size.
const BUDGET = 128 * 1024 * 1024;
it("passes a pack larger than the Worker's memory budget with bounded read-ahead", async () => {
  const chunks = BUDGET / SIZE + 1;
  const t = fixture(chunks);
  const res = await t.request();
  const reader = res.body!.getReader();
  let received = 0, consumed = 0, maxAhead = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    consumed += 1;
    maxAhead = Math.max(maxAhead, t.pulled.length - consumed);
  }
  expect(received).toBe(chunks * SIZE);
  expect(received).toBeGreaterThan(BUDGET);
  // Never more than two chunks (128 KiB) held ahead of the caller.
  expect(maxAhead).toBeLessThanOrEqual(2);
  expect(t.events.slice(-2)).toEqual(["revoke:up", "dispose"]);
}, 60_000);

it("revokes the upstream token when the caller cancels the stream midway", async () => {
  const t = fixture();
  const res = await t.request();
  const reader = res.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  expect(t.events).toEqual(["create"]);
  await reader.cancel("client went away");
  expect(t.events).toEqual(["create", "revoke:up", "dispose"]);
  expect(t.pulled.length).toBeLessThan(CHUNKS);
});

it("streams the request body upstream instead of buffering it", async () => {
  const t = fixture();
  const res = await t.request();
  expect(t.seen.body).toBeInstanceOf(ReadableStream);
  expect(t.seen.body).not.toBeInstanceOf(ArrayBuffer);
  await res.body!.cancel();
});

it("revokes the upstream token at once when the upstream fetch fails or has no body", async () => {
  const failed = fixture();
  vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("upstream down"));
  await expect(failed.request()).rejects.toThrow("upstream down");
  expect(failed.events).toEqual(["create", "revoke:up", "dispose"]);
  const empty = fixture();
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(null, { status: 304 }));
  expect((await empty.request()).status).toBe(304);
  expect(empty.events).toEqual(["create", "revoke:up", "dispose"]);
});
