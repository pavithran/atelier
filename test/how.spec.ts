import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import how from "../src/how.css";
import layout from "../src/layout.css";
import { escapeText, renderLogin, renderShowcase } from "../src/ui";
import { HELP_FORMS, guideText } from "../src/usage.ts";
import { LOOP, ORCHESTRATOR, RULES } from "../src/how-data.ts";

// The public How it works page, driven through the Worker's own fetch handler.

const get = (path: string, extra: Record<string, string> = {}, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://atelier.test${path}`, { redirect: "manual", ...init }), { ...env, ...extra } as typeof env);

async function page(extra: Record<string, string> = {}) {
  const res = await get("/how", extra);
  expect(res.status).toBe(200);
  return { res, body: await res.text() };
}

it("renders without a session, with or without a server token, and says it is public", async () => {
  for (const extra of [{}, { ATELIER_TOKEN: "how-test-token" }] as Record<string, string>[]) {
    const { res, body } = await page(extra);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(body).toContain("<title>How it works · Atelier</title>");
    expect(body).toContain("<h1>How Atelier works</h1>");
    expect(body).toContain("public · reads no project data");
    expect(body).not.toContain("<script");
    expect(body).not.toContain("<form");
    expect(body).not.toContain('class="rail"');
    expect(body).not.toContain('href="/p/');
  }
});

it("contains every command and flag form the CLI help prints, and the agent guide", async () => {
  const { body } = await page();
  expect(HELP_FORMS.length).toBeGreaterThan(40);
  for (const form of HELP_FORMS) expect(body, form).toContain(`<code>atelier ${escapeText(form)}</code>`);
  expect(body).toContain(`<pre>${escapeText(guideText())}</pre>`);
});

it("draws the loop as an inline SVG that stands alone, with a caption and a label", async () => {
  const { body } = await page();
  const figure = /<figure class="how-fig">[\s\S]*?<\/figure>/.exec(body)?.[0] ?? "";
  const svg = /<svg[\s\S]*?<\/svg>/.exec(figure)?.[0] ?? "";
  expect(svg).toMatch(/^<svg viewBox="0 0 \d+ \d+" role="img" aria-label="[^"]{80,}"/);
  expect(figure).toMatch(/<\/svg><\/div><figcaption>[^<]{80,}<\/figcaption>/);
  for (const bad of ["<script", "<style", "<foreignObject", "<image", "href=\"http", "xlink:href"]) expect(svg).not.toContain(bad);
  expect(svg.match(/class="hw-node/g)).toHaveLength(LOOP.length);
  expect(svg.match(/class="hw-rec"/g)).toHaveLength(LOOP.length);
  expect(svg.match(/hw-cond/g)).toHaveLength(LOOP.filter((s) => s.conditional).length);
  for (const [i, step] of LOOP.entries()) {
    expect(svg).toContain(`>${i + 1} ${escapeText(step.name)}</text>`);
    expect(svg).toContain(`>${escapeText(step.moves)}</text>`);
    for (const line of step.records) expect(svg).toContain(`>${escapeText(line)}</tspan>`);
  }
  // Every arrowhead and fill resolves inside the fragment or to a site token.
  for (const id of svg.match(/url\(#([a-z-]+)\)/g) ?? []) expect(svg).toContain(`id="${id.slice(5, -1)}"`);
});

it("keeps the diagram's text between 11 and 13 pixels at drawn scale", async () => {
  const { body } = await page();
  const svgs = [...body.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((m) => m[0]);
  const classes = new Set(svgs.flatMap((svg) => [...svg.matchAll(/<text class="([a-z-]+)"/g)].map((m) => m[1])));
  expect([...classes].sort()).toEqual(["hw-cmd", "hw-lane-label", "hw-move", "hw-name", "hw-note", "hw-recs", "lay-label", "lay-name", "lay-sub"]);
  for (const name of classes) {
    const rule = new RegExp(`\\.${name}\\s*\\{[^}]*font:[^;}]*?(\\d+)px`).exec(name.startsWith("lay-") ? layout : how);
    expect(rule, `${name} has no font size in its stylesheet`).not.toBeNull();
    const size = Number(rule![1]);
    expect(size, name).toBeGreaterThanOrEqual(11);
    expect(size, name).toBeLessThanOrEqual(13);
  }
});

it("marks each orchestrator part built or not built yet, as the data says", async () => {
  const { body } = await page();
  expect(body.match(/>Built<\/span>/g) ?? []).toHaveLength(ORCHESTRATOR.filter((p) => p.built).length);
  expect(body.match(/>Not built yet<\/span>/g) ?? []).toHaveLength(ORCHESTRATOR.filter((p) => !p.built).length);
  for (const part of ORCHESTRATOR) expect(body).toContain(escapeText(part.name));
});

it("the orchestrator section describes the flow as it runs: plans, routing, automatic reviews by home runners, the integration branch and atelier land", async () => {
  const { body } = await page();
  const section = /<section id="the-orchestrator"[\s\S]*?<\/section>/.exec(body)?.[0] ?? "";
  expect(section).not.toBe("");
  const prose = /<p>[\s\S]*?<\/p>/.exec(section)?.[0] ?? "";
  for (const said of [
    '<code>atelier plan "goal"</code>', "plan job", "by its hash, once", "<code>routeParts</code>", "another model family",
    "review request", "<code>runReview</code>", "<code>cli/agy-review.mjs</code>", "integration branch", "<code>atelier runner --integrate</code>",
    "owner's acceptance and merge", "<code>atelier land</code>", "landing lease",
    "Every home runner offers build and plan jobs", "A rejection with blocking findings", "the integrator submits the plan task",
  ]) expect(prose, said).toContain(said);
  for (const stale of ["nothing else calls it", "pure functions with tests", "by hand"]) expect(prose).not.toContain(stale);
  expect(section).toContain("<h3>Landing a single task");
});

it("lists every rule, and every contents link has its section", async () => {
  const { body } = await page();
  for (const rule of RULES) expect(body).toContain(`<h3>${escapeText(rule.title)}</h3>`);
  const links = [...body.matchAll(/<a href="#([a-z-]+)"/g)].map((m) => m[1]);
  expect(links).toEqual(["terms", "where-it-runs", "the-loop", "rules", "the-orchestrator", "commands"]);
  for (const id of links) expect(body).toContain(`<section id="${id}" class="how-section">`);
});

it("reads no project and no setting: the same bytes whatever the server holds", async () => {
  const record = { name: "how-secret-project", title: "How Secret Title", repo: "how-secret-project", policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await env.LEDGER.get(env.LEDGER.idFromName(`project:${record.name}`)).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const plain = (await page()).body;
  const loaded = (await page({ SHOWCASE: record.name, OWNER_NAME: "Zed Ownerson", OWNER_ACTOR: "zed-owner", ATELIER_TOKEN: "how-test-token", TIMEZONE: "Asia/Tokyo" })).body;
  expect(loaded).toBe(plain);
  for (const secret of [record.name, record.title, "Zed Ownerson", "zed-owner"]) expect(plain).not.toContain(secret);
});

it("answers GET only, and only at /how", async () => {
  const post = await get("/how", { ATELIER_TOKEN: "how-test-token" }, { method: "POST", body: "{}" });
  expect(post.status).toBe(303);
  expect(post.headers.get("location")).toBe("https://atelier.test/login");
  expect((await get("/how/more", { ATELIER_TOKEN: "how-test-token" })).headers.get("location")).toBe("https://atelier.test/login");
});

it("is linked from the sign-in page and the public showcase, which stay free of signed-in links", async () => {
  expect(renderLogin()).toContain('<a href="/how">how Atelier works</a>');
  expect(renderLogin(undefined, true)).toContain('<a href="/showcase">See the public showcase</a>, or read <a href="/how">');
  const showcase = renderShowcase([], { planned: 0 } as never, "owner", null);
  expect(showcase).toContain('<a href="/how">How it works</a>');
  expect(showcase).not.toContain('href="/p/');
  expect((await (await get("/login")).text())).toContain('href="/how"');
});

it("the How page and the showcase draw where Atelier runs, layer by layer", async () => {
  const pages: [string, string][] = [["/how", (await page()).body], ["/showcase", renderShowcase([], undefined as never, "pavi", "PAVI")]];
  for (const [path, body] of pages) {
    expect(body, path).toContain('class="lay-fig"');
    expect(body, path).toContain("The CLI is the one path to Cloudflare");
    expect(body, path).toContain(">Check container<");
    expect(body, path).toContain(">with --sandbox; internet off<");
  }
  expect(pages[0][1].indexOf('id="where-it-runs"')).toBeLessThan(pages[0][1].indexOf('id="the-loop"'));
});
