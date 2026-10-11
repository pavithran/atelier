import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The design documents (t499) hold to one another: every finding the
// critique raises is answered by a proposal in the plan, every proposal
// names its scope, dependencies, the findings it traces to and criteria of
// at most 300 characters, and every mockup the plan links exists.

const read = (p: string) => readFileSync(resolve("docs/design", p), "utf8");
const critique = read("critique.md");
const plan = read("plan.md");

const findings = [...new Set([...critique.matchAll(/^### (F\d+)\./gm)].map((m) => m[1]))];
const proposals = [...plan.matchAll(/^\*\*(P\d+)\. ([^*]+)\*\*\n((?:- .*\n)+)/gm)].map((m) => ({ id: m[1], title: m[2], body: m[3] }));

test("each proposal has a title, scope, dependencies, traced findings and criteria of at most 300 characters", () => {
  assert.ok(proposals.length >= 10, `${proposals.length} proposals`);
  for (const p of proposals) {
    for (const field of ["Scope", "Depends on", "Traces", "Criteria"]) assert.match(p.body, new RegExp(`^- ${field}: \\S`, "m"), `${p.id} has no ${field}`);
    const criteria = /^- Criteria: (.*)$/m.exec(p.body)![1];
    assert.ok([...criteria].length <= 300, `${p.id}'s criteria are ${[...criteria].length} characters`);
  }
});

test("every finding in the critique is traced by a proposal, or kept as a strength", () => {
  assert.ok(findings.length >= 15);
  const traced = new Set(proposals.flatMap((p) => [.../F\d+/g[Symbol.matchAll](/^- Traces: (.*)$/m.exec(p.body)![1])].map((m) => m[0])));
  const kept = findings.filter((f) => new RegExp(`^### ${f}\\. What is strong`, "m").test(critique));
  assert.deepEqual(findings.filter((f) => !traced.has(f) && !kept.includes(f)), []);
});

test("every proposal the critique cites exists in the plan", () => {
  const ids = new Set(proposals.map((p) => p.id));
  const cited = [...new Set([...critique.matchAll(/\bP(\d+)\b/g)].map((m) => `P${m[1]}`))];
  assert.deepEqual(cited.filter((c) => !ids.has(c)), []);
});

test("every mockup the plan links exists and links the shared stylesheet", () => {
  const linked = [...new Set([...plan.matchAll(/\]\((mockups\/[a-z-]+\.html)\)/g)].map((m) => m[1]))];
  assert.ok(linked.length >= 12, `${linked.length} mockups linked`);
  for (const file of linked) {
    assert.ok(existsSync(resolve("docs/design", file)), `${file} is missing`);
    assert.match(read(file), /<link rel="stylesheet" href="mockup\.css">/, `${file} does not use mockup.css`);
    assert.doesNotMatch(read(file), /<script|https?:\/\/fonts\./, `${file} loads script or remote fonts`);
  }
});

test("the proposals' dependencies have no cycle and section 6 orders each after what it depends on", () => {
  const deps = new Map(proposals.map((p) => [p.id, [...new Set([...(/^- Depends on: (.*)$/m.exec(p.body)![1]).matchAll(/\b([Pt]\d+)\b/g)].map((m) => m[1]))]]));
  const ids = new Set(deps.keys());
  // No cycle among the proposals (depth-first, three colours).
  const state = new Map<string, "open" | "done">();
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === "done") return;
    assert.notEqual(state.get(id), "open", `dependency cycle: ${[...path, id].join(" → ")}`);
    state.set(id, "open");
    for (const d of deps.get(id) ?? []) if (ids.has(d)) visit(d, [...path, id]);
    state.set(id, "done");
  };
  for (const id of ids) visit(id, []);
  // Section 6 names every proposal, and each first appears after every task and proposal it depends on.
  const order = plan.split(/^## /m).find((sec) => sec.startsWith("6. Dependency order"));
  assert.ok(order, "plan.md has no section 6, Dependency order");
  const first = new Map<string, number>();
  for (const m of order.matchAll(/\*\*([Pt]\d+)\b/g)) if (!first.has(m[1])) first.set(m[1], m.index!);
  for (const [id, ds] of deps) {
    assert.ok(first.has(id), `${id} is not in section 6`);
    for (const d of ds) {
      assert.ok(first.has(d), `${id} depends on ${d}, which section 6 does not place`);
      assert.ok(first.get(d)! < first.get(id)!, `section 6 places ${id} before ${d}, which it depends on`);
    }
  }
});

test("every page a mockup draws has both a desktop (1440) and a phone (390) frame", () => {
  const linked = [...new Set([...plan.matchAll(/\]\((mockups\/[a-z-]+\.html)\)/g)].map((m) => m[1]))].filter((f) => f !== "mockups/index.html");
  for (const file of linked) {
    const frames = [...read(file).matchAll(/<figcaption>(Desktop · 1440|Phone · 390) · (\/[^\s,<]*)/g)].map((m) => ({ width: m[1].split(" ")[0], route: m[2] }));
    const routes = (width: string) => new Set(frames.filter((f) => f.width === width).map((f) => f.route));
    const desktop = routes("Desktop"), phone = routes("Phone");
    assert.ok(desktop.size > 0, `${file} has no desktop frame naming its route`);
    assert.deepEqual([...desktop].filter((r) => !phone.has(r)), [], `${file}: desktop only`);
    assert.deepEqual([...phone].filter((r) => !desktop.has(r)), [], `${file}: phone only`);
  }
});

test("the mockups draw palette B with the values brief.md §1.1 fixes", () => {
  const brief = read("brief.md");
  const css = read("mockups/mockup.css");
  const light = css.slice(css.indexOf("@media (prefers-color-scheme: light)"));
  const dark = css.slice(0, css.indexOf("@media (prefers-color-scheme: light)"));
  const value = (block: string, token: string) => new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, "i").exec(block)?.[1].toLowerCase();
  let checked = 0;
  for (const row of brief.matchAll(/^ *\| [^|]+ \| ((?:`--[a-z-]+`(?:, )?)+) \| ([^|]+) \| ([^|]+) \|$/gm)) {
    const tokens = [...row[1].matchAll(/`(--[a-z-]+)`/g)].map((m) => m[1]);
    const hexes = (cell: string) => [...cell.matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0].toLowerCase());
    const [d, l] = [hexes(row[2]), hexes(row[3])];
    tokens.forEach((t, i) => {
      assert.equal(value(dark, t), d[d.length === 1 ? 0 : i], `${t} (dark) in mockup.css`);
      assert.equal(value(light, t), l[l.length === 1 ? 0 : i], `${t} (light) in mockup.css`);
      checked++;
    });
  }
  assert.ok(checked >= 15, `${checked} palette tokens checked`);
  assert.equal(value(dark, "--signal"), "#4d8bff", "palette B's one accent");
});

test("the mockups draw company colours only inside charts (d9)", () => {
  const files = readdirSync(resolve("docs/design/mockups")).filter((f) => /\.(html|css)$/.test(f));
  assert.ok(files.length >= 13, `${files.length} mockup files`);
  for (const f of files) {
    const text = read(`mockups/${f}`);
    assert.doesNotMatch(text, /--fam\b|\bf-(anthropic|openai|zai|google|qwen)\b|class="stripe"/, `${f} marks a family outside a chart`);
    // In the stylesheet a family colour is defined, or drawn by a graph's legend; in a page, only inside an <svg>.
    const outside = f.endsWith(".css")
      ? text.split("\n").filter((l) => /var\(--m-/.test(l) && !/^\.graph-legend /.test(l))
      : text.replace(/<svg[\s\S]*?<\/svg>/g, "").match(/var\(--m-[a-z]+\)/g) ?? [];
    assert.deepEqual(outside, [], `${f} draws a company colour outside a chart`);
  }
});
