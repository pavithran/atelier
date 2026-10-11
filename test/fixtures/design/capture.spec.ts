import { test, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import worker from "../../../src/index.ts";
import { signIn } from "../../signin.ts";

const ISS = "https://atelier-test.cloudflareaccess.com";
const AUD = "47c6b47feb5b3f0dcbe5f3f7f9e1d2c8";
const OWNER = "owner@example.com";
const TOKEN = "access-test-token";
const bindings = { ...env, ATELIER_TOKEN: TOKEN, CF_ACCESS_ISS: ISS, CF_ACCESS_AUD: AUD, CF_ACCESS_OWNER_EMAIL: OWNER, ARTIFACTS: {
    get: async () => ({
      log: async () => [], readCommit: async () => null, readTree: async () => null, readBlob: async () => null, info: async () => ({ remote: "https://git.test/r.git", defaultBranch: "main" }), [Symbol.dispose]() {},
    })
  } as any } as typeof env;

const pair = await generateKeyPair("RS256");
const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "atelier-test", alg: "RS256" }] };

async function assertion(expires = "5m", email = OWNER) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "atelier-test" })
    .setIssuer(ISS)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(pair.privateKey);
}

function serveKeys() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) =>
    new Response(String(input) === `${ISS}/cdn-cgi/access/certs` ? JSON.stringify(jwks) : "{}", {
      status: String(input) === `${ISS}/cdn-cgi/access/certs` ? 200 : 404,
    })
  );
}

test("capture html", async () => {
  serveKeys();
  const fixedTime = new Date("2026-10-10T12:00:00Z");
  vi.setSystemTime(fixedTime);

  const idx = bindings.LEDGER.get(bindings.LEDGER.idFromName("__index"));
  
  const setupProject = async (name: string, isPublic: boolean = false) => {
    const L = bindings.LEDGER.get(bindings.LEDGER.idFromName(`project:${name}`));
    const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: fixedTime.toISOString() };
    await idx.registerProject(record);
    await L.setProject(record, "owner");
    if (isPublic) {
      await idx.setShowcase(name, "named");
    }
    return L;
  };

  const L1 = await setupProject("empty-proj");
  const L2 = await setupProject("dense-proj");
  const L3 = await setupProject("states-proj", true);

  for (let i = 1; i <= 250; i++) {
    await L2.newItem(`Dense task ${i}`, [], "owner");
  }
  
  for (let i = 1; i <= 50; i++) {
    await L3.newItem(`State task ${i}`, [], "owner");
    if (i % 5 === 1) {
      await L3.claim(`t${i}`, "model-a");
    } else if (i % 5 === 2) {
      await L3.claim(`t${i}`, "model-b");
      await L3.setFork(`t${i}`, `branch-${i}`, "0".repeat(40), "model-b");
      await L3.recordPush(`t${i}`, "model-b", "1".repeat(40), "1".repeat(40));
      await L3.submit(`t${i}`, "model-b");
    } else if (i % 5 === 3) {
      await L3.claim(`t${i}`, "model-c");
      await L3.setFork(`t${i}`, `branch-${i}`, "0".repeat(40), "model-c");
      await L3.recordPush(`t${i}`, "model-c", "2".repeat(40), "2".repeat(40));
      await L3.addEvidence({ itemId: `t${i}`, claim: "npm test", grade: "observed", head: "2".repeat(40), passed: true, by: "model-c", at: new Date().toISOString(), changedPaths: ["a.ts"] });
      await L3.submit(`t${i}`, "model-c");
      await L3.accept(`t${i}`, "owner", "2".repeat(40));
    }
  }

  const cookie = await signIn(TOKEN, bindings, { "cf-access-jwt-assertion": await assertion() });
  
  async function fetchHTML(url: string, asPublic = false) {
    const headers: Record<string, string> = {};
    if (!asPublic) {
      headers["cookie"] = cookie;
      headers["cf-access-jwt-assertion"] = await assertion();
    }
    const res = await worker.fetch(new Request(url, { headers }), bindings);
    return await res.text();
  }

  const pages = [
    { name: "live.js", url: "https://atelier.test/live.js", pub: true, contentType: "text/javascript" },
    { name: "home", url: "https://atelier.test/home", pub: false },
    { name: "decisions", url: "https://atelier.test/decisions", pub: false },
    { name: "studio", url: "https://atelier.test/studio", pub: false },
    { name: "proj-empty", url: "https://atelier.test/p/empty-proj", pub: false },
    { name: "proj-dense", url: "https://atelier.test/p/dense-proj", pub: false },
    { name: "proj-states", url: "https://atelier.test/p/states-proj", pub: false },
    { name: "proj-states-tasks", url: "https://atelier.test/p/states-proj/tasks", pub: false },
    { name: "proj-states-t3", url: "https://atelier.test/p/states-proj/t3", pub: false },
    { name: "public-showcase", url: "https://atelier.test/", pub: true },
    { name: "public-proj", url: "https://atelier.test/p/states-proj", pub: true }
  ];

  for (const p of pages) {
    const html = await fetchHTML(p.url, p.pub);
    console.log(JSON.stringify({ magic: "capture", name: p.name, url: p.url, html, contentType: (p as any).contentType || "text/html" }));
  }
});
