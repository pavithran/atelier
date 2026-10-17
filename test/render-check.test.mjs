import { test } from "node:test";
import assert from "node:assert/strict";

// The render check (t283): /how as a browser renders it, not as text. The
// page is built from this tree exactly as the Worker builds it, with the same
// modules and CSS, and POSTed to Atelier's render gateway, which loads it in
// Cloudflare Browser Run and answers the
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

// The page, bundled from the pushed tree with the Worker's own rule that
// makes CSS importable as text. /how reads no project, so it renders the same
// on a clean clone.
const ENTRY = `
import { renderHow } from "./src/how.ts";

export const pages = [
  { page: "/how", html: renderHow() },
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
