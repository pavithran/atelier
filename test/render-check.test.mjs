import { test } from "node:test";
import assert from "node:assert/strict";

// The render check (t283): /how and the showcase as a browser renders them,
// not as text. The pages are built from this tree exactly as the Worker
// builds them — same modules, same CSS — and POSTed to Atelier's render
// gateway, which loads them in Cloudflare Browser Run and answers the
// geometry it laid out; a label wider than its box, boxes that overlap, a
// figure that shrinks instead of scrolling, all fail here where the pages'
// own .spec.ts tests can only read their HTML as strings.
//
// The gateway lives at a reserved host that only Atelier's check sandbox can
// reach: the container's egress is otherwise the npm registry alone, and it
// holds no credential. On any other machine the host does not exist, and
// this check says so and skips — it cannot render, so it claims nothing.
// Where the host answers, every answer but 200 fails the check: a gateway
// with no browser, a render that failed, or a run past its renders is a
// render that did not happen, not a page that passed.

const HOST = "https://render.atelier.test";

// The pages, bundled from the pushed tree with the Worker's own rule that
// makes CSS importable as text. The showcase is drawn with a small portfolio
// shaped like the one in test/showcase.spec.ts, because the page is a
// function of the server's projects and this check runs on a clean clone.
const ENTRY = `
import { renderHow } from "./src/how.ts";
import { renderShowcase } from "./src/ui.ts";
import { addTally, buildStory, emptyTally } from "./src/graph.ts";
import { buildImported } from "./src/import/history.ts";

const at = (d, m = 0) => new Date(Date.UTC(2026, 9, d, 12, m)).toISOString();
const items = ["Brief a task", "Claim and build", "Send it for review"].map((title, i) => ({ id: "t" + (i + 1), title, state: "claimed" }));
const events = items.flatMap((item, i) => [
  { seq: 2 * i + 1, at: at(5, i), actor: "pavi", kind: "item.created", itemId: item.id, data: {} },
  { seq: 2 * i + 2, at: at(5, i), actor: "codex/gpt-6-astra", kind: "item.claimed", itemId: item.id, data: {} },
]).reverse();
const story = (name, title) => buildStory(name, items, events, "pavi", false, title, { redact: true, ownerLabel: "PAVI" });
const stories = [story("atelier", "Atelier"), story("quiet-tool", "A quiet tool")];
const imported = new Map([["atelier", buildImported(Array.from({ length: 40 }, (_, i) => ({ hash: "h" + i, committedAt: i + 1, message: "work" })), null, true)]]);
const shown = [
  { project: { name: "atelier", repo: "atelier", policy: { checks: [], protected: [] }, createdAt: at(1) }, mode: "named", story: stories[0] },
  { project: { name: "quiet-tool", repo: "quiet-tool", policy: { checks: [], protected: [] }, createdAt: at(1) }, mode: "anonymous", story: stories[1] },
];
export const pages = [
  { page: "/how", html: renderHow() },
  { page: "/showcase", html: renderShowcase(stories, stories.reduce((t, s) => addTally(t, s.tally), emptyTally()), "pavi", "PAVI", false, imported, shown) },
];
`;

export async function buildPages() {
  const [{ build }, { fileURLToPath, pathToFileURL }] = await Promise.all([import("esbuild"), import("node:url")]);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const built = await build({
    stdin: { contents: ENTRY, resolveDir: root, loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    loader: { ".css": "text" },
    legalComments: "none",
    logLevel: "silent",
  });
  const { randomUUID } = await import("node:crypto");
  const file = `${(await import("node:os")).tmpdir()}/atelier-render-${randomUUID()}.mjs`;
  const { writeFileSync, unlinkSync } = await import("node:fs");
  writeFileSync(file, built.outputFiles[0].text);
  try {
    return (await import(pathToFileURL(file).href)).pages;
  } finally {
    unlinkSync(file);
  }
}

test("the public pages render in a browser without a broken diagram or layout (t283)", async (t) => {
  let probe;
  try {
    probe = await fetch(`${HOST}/`, { signal: AbortSignal.timeout(2500) });
  } catch {
    t.skip("no render gateway on this machine; only Atelier's check sandbox answers one");
    return;
  }
  assert.equal(probe.status, 200, `the render gateway answered ${probe.status}: ${(await probe.text()).slice(0, 300)}`);
  const pages = await buildPages();
  for (const { page, html } of pages) {
    const res = await fetch(`${HOST}/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page, html }),
      signal: AbortSignal.timeout(180_000),
    });
    assert.equal(res.status, 200, `${page}: the render gateway could not render it (${res.status} ${(await res.text()).slice(0, 300)})`);
    const { problems } = await res.json();
    assert.deepEqual(problems, [], `${page} as a browser renders it:\n${(problems ?? []).join("\n")}`);
  }
});
