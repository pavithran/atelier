import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import how from "../src/how.css";
import layout from "../src/layout.css";
import { escapeText, renderLogin, renderShowcase } from "../src/ui";
import { HELP_FORMS, guideText } from "../src/usage.ts";
import { LOOP, ORCHESTRATOR, RULES } from "../src/how-data.ts";
import { PLAN_FLOW, PLAN_FLOW_CAPTION, PLAN_FLOW_LABEL, PLAN_FLOW_RETURNS } from "../src/diagrams.ts";

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
  expect([...classes].sort()).toEqual(["hw-cmd", "hw-lane-label", "hw-move", "hw-name", "hw-note", "hw-recs", "lay-label", "lay-name", "lay-sub", "pf-label", "pf-name", "pf-note", "pf-sub"]);
  for (const name of classes) {
    const rule = new RegExp(`\\.${name}\\s*\\{[^}]*font:[^;}]*?(\\d+)px`).exec(name.startsWith("hw-") ? how : layout);
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

it("the orchestrator section draws the plan flow from goal to merge as an inline SVG figure that scrolls", async () => {
  const { body } = await page();
  const section = /<section id="the-orchestrator"[\s\S]*?<\/section>/.exec(body)?.[0] ?? "";
  const figure = /<figure class="pf-fig">[\s\S]*?<\/figure>/.exec(section)?.[0] ?? "";
  expect(figure).not.toBe("");
  const svg = /<svg[\s\S]*?<\/svg>/.exec(figure)?.[0] ?? "";
  const unescape = (t: string) => t.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const label = /^<svg viewBox="0 0 \d+ \d+" role="img" aria-label="([^"]+)"/.exec(svg)?.[1] ?? "";
  expect(unescape(label)).toBe(PLAN_FLOW_LABEL);
  const caption = /<\/svg><\/div><figcaption>([^<]+)<\/figcaption><\/figure>$/.exec(figure)?.[1] ?? "";
  expect(unescape(caption)).toBe(PLAN_FLOW_CAPTION);
  expect(PLAN_FLOW_CAPTION).toContain("goal to merge");
  // It sits after the prose and before the list of parts.
  expect(section.indexOf("<p>")).toBeLessThan(section.indexOf('<figure class="pf-fig">'));
  expect(section.indexOf('<figure class="pf-fig">')).toBeLessThan(section.indexOf('<ul class="how-status">'));
  for (const bad of ["<script", "<style", "<foreignObject", "<image", "href=\"http", "xlink:href"]) expect(svg).not.toContain(bad);
  // Every step and return is drawn, the goal first and the merge last.
  expect(svg.match(/<rect class="pf-node/g)).toHaveLength(PLAN_FLOW.length);
  const text = unescape(svg);
  for (const [i, s] of PLAN_FLOW.entries()) {
    expect(text).toContain(`>${i + 1} ${s.name}</text>`);
    for (const line of s.sub) expect(text).toContain(`>${line}</tspan>`);
  }
  expect(PLAN_FLOW[0]).toMatchObject({ lane: "owner", name: "State a goal" });
  expect(PLAN_FLOW.at(-1)).toMatchObject({ lane: "owner", name: "Accept and merge" });
  for (const note of Object.values(PLAN_FLOW_RETURNS)) expect(text).toContain(`>${note}</text>`);
  expect(svg.match(/class="pf-return"/g)).toHaveLength(3);
  for (const lane of ["Owner", "Home runners and their agents", "Atelier"]) expect(svg).toContain(`>${lane}</text>`);
  // Every arrowhead resolves inside the fragment.
  for (const id of svg.match(/url\(#([a-z-]+)\)/g) ?? []) expect(svg).toContain(`id="${id.slice(5, -1)}"`);
  // The frame scrolls sideways on a narrow screen: the drawing keeps a
  // minimum width inside a frame that overflows rather than shrinking.
  expect(figure).toContain('<div class="scroll">');
  expect(layout).toMatch(/\.pf-fig \.scroll \{[^}]*overflow-x: auto/);
  expect(layout).toMatch(/\.pf-fig svg \{[^}]*min-width: \d+px/);
});

it("colours the plan flow only through classes defined in layout.css, from site tokens that follow light and dark", async () => {
  const { body } = await page();
  const svg = /<figure class="pf-fig">[\s\S]*?(<svg[\s\S]*?<\/svg>)/.exec(body)?.[1] ?? "";
  expect(svg).not.toBe("");
  // No colour literal and no inline paint: no hex, rgb or hsl, and no style,
  // fill, stroke or color attribute.
  expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![a-z-])|rgba?\(|hsla?\(/);
  expect(svg).not.toMatch(/\s(style|fill|stroke|color|stop-color)="/);
  const classes = new Set([...svg.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(" ")));
  expect([...classes].every((c) => c.startsWith("pf-"))).toBe(true);
  for (const name of classes) {
    const rule = new RegExp(`\\.${name}(?![a-z-])[^{]*\\{([^}]*)\\}`).exec(layout);
    expect(rule, `${name} is not defined in layout.css`).not.toBeNull();
    // Each colour in the rule is a token, so it switches with the theme.
    expect(rule![1], name).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\((?!var\()/);
    if (/(fill|stroke):/.test(rule![1])) expect(rule![1], name).toMatch(/(fill|stroke): (none|(rgba\()?var\(--)/);
  }
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
