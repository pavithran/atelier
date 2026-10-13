import { env } from "cloudflare:workers";
import { afterAll, expect, it, vi } from "vitest";
import { EMPTY_PROJECT, FIXED_NOW, PLANS, SECRETS, STATE_OF, TOTAL_TASKS, UNAVAILABLE_PROJECT, seed, total, type Shape } from "./seed.ts";
import { ALIASES, designEnv, draw, pageStates, serveKeys, session } from "./pages.ts";

// The design captures' fixture (t499) holds what the brief says it holds:
// at least 300 tasks across three projects, each seeded state where it was
// put, and every page and state the brief lists drawn with the status and
// text it is captured for. The capture command (scripts/design/capture.ts)
// draws the same pages from the same seed in a browser; this spec keeps the
// fixture honest without one.

afterAll(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("seeds 310 tasks across three projects, each state where the brief says, and draws every page state", { timeout: 600_000 }, async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const seeded = await seed(env);
  expect(new Date().toISOString()).toBe(FIXED_NOW);

  // The totals, read back from the Ledgers rather than from the plan.
  expect(TOTAL_TASKS).toBe(310);
  let counted = 0;
  for (const plan of PLANS) {
    const items = await env.LEDGER.get(env.LEDGER.idFromName(`project:${plan.name}`)).items();
    expect(items.length, plan.name).toBe(total(plan));
    counted += items.length;
    for (const [shape, ids] of Object.entries(seeded.byShape[plan.name]) as [Shape, string[]][]) {
      expect(ids.length, `${plan.name} ${shape}`).toBe(plan.shapes[shape]);
      for (const id of ids) expect(items.find((i) => i.id === id)?.state, `${plan.name} ${id} ${shape}`).toBe(STATE_OF[shape]);
    }
  }
  expect(counted).toBe(310);
  expect(counted).toBeGreaterThanOrEqual(300);
  expect((await env.LEDGER.get(env.LEDGER.idFromName(`project:${EMPTY_PROJECT}`)).items()).length).toBe(0);
  const listed = (await env.LEDGER.get(env.LEDGER.idFromName("__index")).projects()).map((p: { name: string }) => p.name);
  expect(listed.sort()).toEqual([EMPTY_PROJECT, UNAVAILABLE_PROJECT, ...PLANS.map((p) => p.name)].sort());

  const keys = serveKeys();
  const pages = designEnv(env, seeded);
  const cookie = await session(pages);
  const failures: string[] = [];
  const links = new Set<string>();
  for (const p of pageStates(seeded)) {
    if (p.setup === "no-showcase") continue;
    const res = await draw(pages, p.path, p.audience, cookie);
    const body = await res.text();
    if (res.status !== p.status || !body.includes(p.marker)) failures.push(`${p.id} ${p.path}: ${res.status} (want ${p.status}), marker ${JSON.stringify(p.marker)} ${body.includes(p.marker) ? "found" : "missing"}`);
    // Nothing the anonymised project holds reaches a page a visitor reads.
    if (p.audience !== "owner") for (const secret of SECRETS) if (body.includes(secret)) failures.push(`${p.id} exposes ${JSON.stringify(secret)}`);
    // The owner's bar (t543): on every owner page, filled, with one current
    // item in each row on a page that drew, and the project row under /p/.
    if (p.audience === "owner") {
      const head = body.slice(body.indexOf('<header class="owner-bar">'), body.indexOf("</header>", body.indexOf('<header class="owner-bar">')));
      if (!body.includes('<header class="owner-bar">') || body.includes("<!--shell:")) failures.push(`${p.id}: no filled owner bar`);
      const marked = (label: string) => (head.split(`aria-label="${label}">`)[1]?.split("</nav>")[0] ?? "").split('aria-current="page"').length - 1;
      if (p.status === 200 && marked("Atelier") !== (["/models", "/usage"].includes(p.path) ? 0 : 1)) failures.push(`${p.id}: ${marked("Atelier")} current items in row 1`);
      // Under /p/, an error or an empty repository included (gate finding 3).
      if (p.path.startsWith("/p/") && marked("Project") !== 1) failures.push(`${p.id}: ${marked("Project")} current tabs`);
      for (const m of head.matchAll(/<a [^>]*href="([^"]+)"/g)) links.add(m[1]);
      if (p.id === "decisions") {
        const listed = /<h1 id="dec-h">Decisions · (\d+)<\/h1>/.exec(body)?.[1];
        const shown = /, waiting on you: <\/span>(\d+)\??<\/span>/.exec(head)?.[1];
        if (!listed || shown !== listed) failures.push(`decisions: the badge says ${shown}, the list ${listed}`);
      }
    }
  }
  // Every link in the bar leads to a page that answers: a page above, with
  // the status it is drawn with, or one that answers 200. The unreadable
  // project's tabs answer as its Overview does, and the empty repository's
  // Log as its Code does: the row an error page is given still names them.
  const drawn = new Map(pageStates(seeded).map((p) => [p.path, p.status]));
  const want = (link: string) => drawn.get(link)
    ?? (link.startsWith(`/p/${UNAVAILABLE_PROJECT}/`) ? drawn.get(`/p/${UNAVAILABLE_PROJECT}`) : link === `/p/${EMPTY_PROJECT}/log` ? drawn.get(`/p/${EMPTY_PROJECT}/code`) : 200);
  for (const link of links) {
    const res = await draw(pages, link, "owner", cookie);
    if (res.status !== want(link)) failures.push(`bar link ${link}: ${res.status}`);
  }
  for (const a of ALIASES) {
    const res = await draw(pages, a.path, a.audience, cookie);
    const location = res.headers.get("location") ?? "";
    if (res.status !== a.status || (a.location && !location.endsWith(a.location))) failures.push(`alias ${a.path}: ${res.status} ${location}`);
  }
  // The named project's git history from before Atelier is the comparison's "before".
  const shown = await (await draw(pages, "/", "public", cookie)).text();
  expect(shown).toContain("Git keeps what a commit claims. Atelier keeps what happened.");
  expect(shown).toContain("of commits name an agent");
  // The no-showcase state, with the setting cleared and put back.
  const I = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  for (const plan of PLANS) if (plan.mode) await I.removeShowcase(plan.name);
  const none = await draw(pages, "/", "public", cookie);
  expect(none.status).toBe(404);
  for (const plan of PLANS) if (plan.mode) await I.setShowcase(plan.name, plan.mode);
  keys.mockRestore();
  expect(failures).toEqual([]);
});
