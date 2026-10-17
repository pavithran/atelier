import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIXED_NOW, PLANS, TOTAL_TASKS, seed } from "./seed.ts";
import { ORIGIN, designEnv, draw, pageStates, serveKeys, session } from "./pages.ts";

// Draws every page state in the brief from the seeded fixture with the
// production renderers and CSS, and prints each as one JSON line for
// scripts/design/capture.ts, which loads them into a browser. It is run only
// by that command (scripts/design/vitest.config.ts), never by npm test, whose
// fixture.spec.ts asserts the same seed and pages without printing them.
// The lines reach the command through that config's onConsoleLog.

it("draws the design captures", { timeout: 600_000 }, async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const seeded = await seed(env);
  serveKeys();
  const pages = designEnv(env, seeded);
  const cookie = await session(pages);
  const emit = (o: Record<string, unknown>) => console.log(JSON.stringify({ magic: "design-capture", ...o }));
  emit({ kind: "fixture", now: FIXED_NOW, tasks: TOTAL_TASKS, projects: PLANS.map((p) => ({ name: p.name, shapes: p.shapes })), ids: seeded.byShape });
  const live = await draw(pages, "/live.js", "public", "");
  emit({ kind: "asset", url: `${ORIGIN}/live.js`, contentType: live.headers.get("content-type"), body: await live.text() });
  const states = pageStates(seeded);
  for (const p of states) {
    const res = await draw(pages, p.path, p.audience, cookie);
    const body = await res.text();
    expect(res.status, p.id).toBe(p.status);
    expect(body, p.id).toContain(p.marker);
    emit({ kind: "page", id: p.id, path: p.path, url: `${ORIGIN}${p.path}`, audience: p.audience, status: res.status, state: p.state, csp: res.headers.get("content-security-policy"), body });
  }
  emit({ kind: "done", pages: states.length });
});
