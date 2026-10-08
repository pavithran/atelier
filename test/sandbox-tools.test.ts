import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPinned, GIT_DEB, installCommands, sha256Hex, toolKey, TOOLS_DIR, type PinnedDeb } from "../src/sandbox/tools.ts";
import { END_OF_ARCHIVE, entryBytes } from "../src/sandbox/tar.ts";

// t303: the check container's image has no git, so the Worker supplies
// Debian's git package, pinned by size and sha256, and the container unpacks
// it offline. These tests hold the pinning and the fallbacks; that the
// package runs in the container is proven only by a production check run.

const enc = new TextEncoder();
const good = enc.encode("the one true package\n");
const bad = enc.encode("the one fake package\n"); // same length, other bytes

async function pinned(): Promise<PinnedDeb> {
  return { name: "git", version: "1:0-test", bytes: good.length, sha256: await sha256Hex(good), urls: ["https://a.test/git.deb", "https://b.test/git.deb"] };
}

function server(answers: Record<string, Uint8Array | number | Error>) {
  const asked: string[] = [];
  return {
    asked,
    fetch: async (url: string) => {
      asked.push(url);
      const a = answers[url];
      if (a instanceof Error) throw a;
      if (typeof a === "number") return new Response("no", { status: a });
      return a ? new Response(a) : new Response("missing", { status: 404 });
    },
  };
}

function bucket(initial: Record<string, Uint8Array> = {}) {
  const held = new Map(Object.entries(initial));
  return {
    held,
    get: async (key: string) => (held.has(key) ? { arrayBuffer: async () => held.get(key)!.slice().buffer } : null),
    put: async (key: string, bytes: Uint8Array) => { held.set(key, bytes); return { size: bytes.length }; },
  } as unknown as R2Bucket & { held: Map<string, Uint8Array> };
}

test("the pinned git is Debian trixie's amd64 package, named by size and sha256, with a permanent fallback", () => {
  assert.equal(GIT_DEB.name, "git");
  assert.match(GIT_DEB.sha256, /^[a-f0-9]{64}$/);
  assert.ok(GIT_DEB.bytes > 1_000_000);
  assert.match(GIT_DEB.urls[0], /^https:\/\/deb\.debian\.org\/debian\/pool\/main\/g\/git\/git_2\.47\.3-0%2Bdeb13u1_amd64\.deb$/);
  assert.match(GIT_DEB.urls[1], /^https:\/\/snapshot\.debian\.org\/file\/[a-f0-9]{40}$/);
  assert.equal(toolKey(GIT_DEB), `tools/git/${GIT_DEB.sha256}.deb`);
});

test("a package is taken from the first URL whose bytes verify, and kept in R2 under its sha256", async () => {
  const deb = await pinned();
  const s = server({ "https://a.test/git.deb": good });
  const r2 = bucket();
  assert.deepEqual(await fetchPinned(deb, { fetch: s.fetch, bucket: r2 }), good);
  assert.deepEqual(s.asked, ["https://a.test/git.deb"]);
  assert.deepEqual(r2.held.get(toolKey(deb)), good);
  // The next run reads R2 and reaches no mirror.
  const again = server({});
  assert.deepEqual(await fetchPinned(deb, { fetch: again.fetch, bucket: r2 }), good);
  assert.deepEqual(again.asked, []);
});

test("bytes that do not verify are refused, from a mirror or from R2, and the next source is tried", async () => {
  const deb = await pinned();
  const r2 = bucket({ [toolKey(deb)]: bad });
  const s = server({ "https://a.test/git.deb": bad, "https://b.test/git.deb": good });
  assert.deepEqual(await fetchPinned(deb, { fetch: s.fetch, bucket: r2 }), good);
  assert.deepEqual(s.asked, ["https://a.test/git.deb", "https://b.test/git.deb"]);
  assert.deepEqual(r2.held.get(toolKey(deb)), good, "the bad copy in R2 is replaced");
});

test("with no source verifying, the error names every refusal and nothing is stored", async () => {
  const deb = await pinned();
  const r2 = bucket();
  const s = server({ "https://a.test/git.deb": 503, "https://b.test/git.deb": enc.encode("short") });
  await assert.rejects(fetchPinned(deb, { fetch: s.fetch, bucket: r2 }), (err: Error) => {
    assert.match(err.message, /no verified copy of git 1:0-test/);
    assert.match(err.message, /a\.test\/git\.deb: HTTP 503/);
    assert.match(err.message, /b\.test\/git\.deb: 5 bytes, not 21/);
    return true;
  });
  assert.equal(r2.held.size, 0);
  // Without a bucket the mirrors alone are used.
  assert.deepEqual(await fetchPinned(deb, { fetch: server({ "https://b.test/git.deb": good }).fetch }), good);
  await assert.rejects(fetchPinned(deb, { fetch: server({ "https://a.test/git.deb": new Error("down") }).fetch }), /a\.test\/git\.deb: down/);
});

test("the package lands where installCommands unpacks it, and nothing runs but dpkg-deb, rm and git --version", () => {
  const dir = mkdtempSync(join(tmpdir(), "tools-test-"));
  try {
    const parts = [...entryBytes({ path: `${TOOLS_DIR}/git.deb`, mode: 0o644, kind: "file", data: good }), END_OF_ARCHIVE];
    writeFileSync(join(dir, "in.tar"), Buffer.concat(parts));
    execFileSync("tar", ["-x", "-f", "in.tar", "-C", dir], { cwd: dir });
    const cmds = installCommands(GIT_DEB);
    const debPath = cmds[0][2];
    assert.deepEqual(readFileSync(join(dir, debPath)), Buffer.from(good));
    assert.deepEqual(cmds, [["dpkg-deb", "-x", "/tmp/atelier-tools/git.deb", "/"], ["rm", "-f", "/tmp/atelier-tools/git.deb"], ["git", "--version"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the container keeps the managed image, npm-only egress and no Internet; git comes in before the tree", () => {
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const containers = wrangler.match(/"containers":\s*\[([^\]]*)\]/)?.[1] ?? "";
  assert.match(containers, /"class_name":\s*"CheckRunner"/);
  assert.match(containers, /"scheduling_policy":\s*"durable_object"/);
  // Wrangler refuses instance_type for a Durable Object-managed container.
  assert.doesNotMatch(containers, /instance_type/);
  // No Dockerfile or registry image: wrangler deploy needs no Docker.
  assert.doesNotMatch(containers, /"image"|"images"|dockerfile/i);
  const runner = readFileSync(new URL("../src/sandbox/runner.ts", import.meta.url), "utf8");
  assert.match(runner, /const IMAGE = "cloudflare\/debian-trixie";/);
  assert.match(runner, /export const EGRESS_HOSTS = \["registry\.npmjs\.org"\];/);
  assert.match(runner, /enableInternet: false,/);
  const supply = runner.indexOf("await this.supplyGit(container)");
  const tree = runner.indexOf("await writeTree(");
  assert.ok(supply > 0 && tree > supply, "git is supplied before the tree is unpacked");
});
