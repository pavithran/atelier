// Derives every figure the film uses from the fetched ledger (.cache/items/,
// from scripts/fetch-ledger.mjs) into data/ledger.json, which is committed so
// that the film rebuilds with the figures its narration states. Titles are
// left out: only ids, states, times, actor names and review verdicts.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const CUTOFF = process.env.LEDGER_CUTOFF ?? "2026-10-08T14:50:00.000Z";
const dir = new URL("../.cache/items/", import.meta.url).pathname;
const items = readdirSync(dir).map((f) => JSON.parse(readFileSync(dir + f, "utf8")))
  .filter((d) => d.item.createdAt < CUTOFF)
  .sort((a, b) => Number(a.item.id.slice(1)) - Number(b.item.id.slice(1)));

// The family patterns of src/models/pool.ts, for the families in this ledger.
const FAMILIES = [
  ["anthropic", /^(claude|opus|sonnet|haiku|fable)\b|anthropic/i],
  ["openai", /^(gpt|o\d|codex|chatgpt)\b|^gpt-|openai/i],
  ["zai", /^glm|zhipu|z-?ai/i],
  ["google", /^(gemini|gemma)|google/i],
  ["deepseek", /deepseek/i],
  ["xiaomi", /^mimo\b|xiaomi/i],
  ["qwen", /^qwen|qwq/i],
  ["minimax", /minimax/i],
];
const familyOf = (actor) => { const n = actor.split("/").pop(); return FAMILIES.find(([, re]) => re.test(n) || re.test(actor))?.[0] ?? "other"; };
const isModel = (a) => a.includes("/") && !a.startsWith("atelier/");
const modelOf = (a) => a.split("/").pop();

const tasks = items.map((d) => {
  const it = d.item;
  const ev = d.events.filter((e) => e.at < CUTOFF);
  const at = (kind) => ev.filter((e) => e.kind === kind).map((e) => e.at).sort()[0] ?? null;
  const builders = (it.pushActors ?? []).filter(isModel);
  const bf = new Set(builders.map(familyOf));
  const reviews = d.reviews.filter((r) => r.at < CUTOFF && isModel(r.by)).map((r) => ({
    by: r.by, family: familyOf(r.by), approve: r.approve, at: r.at,
    cross: !bf.has(familyOf(r.by)),
    blocking: (r.findings ?? []).filter((f) => f.severity === "blocking" || f.severity === "blocker").length,
    findings: (r.findings ?? []).length,
  }));
  const finalHead = it.acceptedHead ?? it.head;
  const crossBy = [...new Set(d.reviews.filter((r) => r.at < CUTOFF && r.approve && isModel(r.by) && !bf.has(familyOf(r.by)) && r.head === finalHead).map((r) => familyOf(r.by)))];
  const crossAtFinal = crossBy.length > 0;
  // The state as of the cut-off: a merge or an abandonment after it is not counted.
  let state = it.state;
  if (state === "merged" && !at("item.merged")) state = "submitted";
  if (state === "abandoned" && !at("item.abandoned")) state = "open";
  return {
    id: it.id, state, kind: it.kind ?? "task",
    createdAt: it.createdAt, claimedAt: at("item.claimed"), mergedAt: at("item.merged"), abandonedAt: at("item.abandoned"),
    builders, builderFamilies: [...bf], reviews, crossAtFinal, crossBy,
    handoffs: ev.filter((e) => e.kind === "item.handoff").length,
    observedChecks: ev.filter((e) => e.kind === "evidence.observed").length,
  };
});

const count = (xs, f) => xs.reduce((m, x) => { for (const k of [].concat(f(x))) m[k] = (m[k] ?? 0) + 1; return m; }, {});
const merged = tasks.filter((t) => t.state === "merged");
const allReviews = tasks.flatMap((t) => t.reviews);
const byDay = count(merged, (t) => t.mergedAt.slice(0, 10));
const facts = {
  cutoff: CUTOFF,
  tasks: tasks.length,
  firstTaskAt: tasks[0].createdAt,
  states: count(tasks, (t) => t.state),
  mergedByDay: byDay,
  mergedBuilderFamilies: count(merged, (t) => t.builderFamilies),
  mergedBuilderModels: count(merged, (t) => [...new Set(t.builders.map(modelOf))]),
  modelReviews: allReviews.length,
  modelRejections: allReviews.filter((r) => !r.approve).length,
  reviewsByModel: count(allReviews, (r) => modelOf(r.by)),
  rejectionsByModel: count(allReviews.filter((r) => !r.approve), (r) => modelOf(r.by)),
  reviewerFamilies: count(allReviews, (r) => r.family),
  findings: allReviews.reduce((s, r) => s + r.findings, 0),
  blockingFindings: allReviews.reduce((s, r) => s + r.blocking, 0),
  mergedWithCrossFamilyApprovalAtFinalHead: merged.filter((t) => t.crossAtFinal).length,
  observedChecks: tasks.reduce((s, t) => s + t.observedChecks, 0),
  handoffs: tasks.reduce((s, t) => s + t.handoffs, 0),
};
// The owner's verdicts on review findings (atelier finding), by verdict.
facts.findingVerdicts = count(items.flatMap((d) => d.events.filter((e) => e.kind === "review.finding" && e.at < CUTOFF)), (e) => e.data.verdict);
// From which merge on every merge carried a cross-family approval.
const sorted = [...merged].sort((a, b) => a.mergedAt < b.mergedAt ? -1 : 1);
const lastWithout = sorted.filter((t) => !t.crossAtFinal && t.kind !== "plan").at(-1);
facts.lastMergeWithoutCrossApproval = lastWithout ? { id: lastWithout.id, at: lastWithout.mergedAt } : null;
facts.mergesSinceThenAllCross = sorted.filter((t) => lastWithout && t.mergedAt > lastWithout.mergedAt && t.kind !== "plan").every((t) => t.crossAtFinal);
facts.mergesSinceThen = sorted.filter((t) => lastWithout && t.mergedAt > lastWithout.mergedAt).length;

// The stories the film tells, quoted from the ledger.
const byId = Object.fromEntries(items.map((d) => [d.item.id, d]));
const story = (id) => {
  const d = byId[id];
  return {
    id, builders: (d.item.pushActors ?? []).filter(isModel),
    reviews: d.reviews.filter((r) => r.at < CUTOFF).sort((a, b) => a.at < b.at ? -1 : 1).map((r) => ({ by: r.by, approve: r.approve, head: r.head.slice(0, 8), at: r.at, note: r.note, findings: (r.findings ?? []).map((f) => ({ file: f.file, line: f.line, severity: f.severity, text: f.text })) })),
    verdicts: d.events.filter((e) => e.kind === "review.finding").map((e) => ({ head: e.data.head.slice(0, 8), index: e.data.index, verdict: e.data.verdict, note: e.data.note })),
    landing: d.events.filter((e) => e.kind.startsWith("land.") || ["item.accepted", "item.merged", "review.requested", "review.claimed", "review.approved", "review.rejected", "evidence.observed", "push.observed", "item.submitted"].includes(e.kind))
      .sort((a, b) => a.seq - b.seq).map((e) => ({ at: e.at, kind: e.kind, actor: e.actor, ms: e.data?.ms ?? null, head: (e.data?.head ?? "").slice(0, 8) || null, claim: e.data?.claim ?? null, passed: e.data?.passed ?? null, mergeCommit: (e.data?.mergeCommit ?? "").slice(0, 8) || null, skipped: e.data?.skipped ?? null })),
    handoffs: d.events.filter((e) => e.kind === "item.handoff").map((e) => ({ at: e.at, from: e.data.from, to: e.data.to, note: e.data.note })),
    mergedAt: d.events.find((e) => e.kind === "item.merged")?.at ?? null,
  };
};
// Local models: the pool's home entries served by the owner's own server,
// the dispatches to them, and merged work earlier local builds did.
const LOCAL = /(\d+(_\d+)?bit|mlx|mxfp4|gguf|q\d_k|:studio)/i;   // LOCAL_BUILD in src/models/pool.ts
const poolRaw = JSON.parse(readFileSync(new URL("../.cache/models.json", import.meta.url), "utf8"));
const poolList = Array.isArray(poolRaw) ? poolRaw : (poolRaw.models ?? poolRaw.pool ?? []);
const localPool = poolList.filter((e) => e.where === "home" && e.provider === "ai-studio").map((e) => ({ id: e.id, harness: e.harness, family: e.family, addedAt: e.addedAt }));
const localDispatches = items.flatMap((d) => d.events.filter((e) => e.kind === "item.dispatched" && localPool.some((p) => p.id === e.data?.model)).map((e) => ({ id: d.item.id, model: e.data.model, at: e.at, state: d.item.state })));
const localMerged = tasks.filter((t) => t.state === "merged" && t.builders.some((b) => LOCAL.test(b))).map((t) => ({ id: t.id, builders: t.builders, mergedAt: t.mergedAt }));
// The fleet: every pool entry and how it is paid for.
const fleet = poolList.map((e) => ({ id: e.id, harness: e.harness, family: e.family, provider: e.provider, addedAt: e.addedAt }));
// Two tasks Atelier filed against itself on 2026-10-07 and 08, by title.
const selfTasks = Object.fromEntries(["t296", "t298"].filter((id) => byId[id]).map((id) => [id, { title: byId[id].item.title, createdAt: byId[id].item.createdAt, state: tasks.find((t) => t.id === id).state }]));
const stories = Object.fromEntries(["t278", "t219", "t252", "t50"].map((id) => [id, story(id)]));

// Who held which task at one moment: the five tasks held at once at
// 14:40:53 UTC on 5 October, the most families working together.
const MOMENT = "2026-10-05T14:40:53.494Z";
const held = [];
for (const d of items) {
  const ev = [...d.events].sort((a, b) => a.seq - b.seq);
  let cur = null, from = null;
  for (const e of ev) {
    if (e.kind === "item.claimed") { cur = e.actor; from = e.at; }
    else if (e.kind === "item.handoff" && cur) { if (from <= MOMENT && e.at > MOMENT) held.push({ id: d.item.id, actor: cur, from, to: e.at }); cur = e.data.to; from = e.at; }
    else if (["item.released", "item.merged", "item.abandoned", "item.submitted"].includes(e.kind) && cur) { if (from <= MOMENT && e.at > MOMENT) held.push({ id: d.item.id, actor: cur, from, to: e.at }); cur = null; }
  }
}
const moment = { at: MOMENT, held: held.filter((h) => isModel(h.actor)).sort((a, b) => a.from < b.from ? -1 : 1) };

// Plan t197, from GET .../items/t197/plan (saved by fetch-ledger) and its parts' events.
const planRaw = JSON.parse(readFileSync(new URL("../.cache/plan-t197.json", import.meta.url), "utf8"));
const plan = {
  id: "t197", goal: planRaw.goal, planner: planRaw.planner, proposedAt: planRaw.proposal.at, approvedAt: planRaw.approval.at, hash: planRaw.approval.hash,
  maxParallel: planRaw.approval.limits.maxParallel, jobsUsed: planRaw.approval.jobsUsed, maxJobs: planRaw.approval.limits.maxJobs,
  proposed: planRaw.plan.parts.map((p) => ({ key: p.key, dependsOn: p.dependsOn })),
  parts: planRaw.parts.map((p) => {
    const d = byId[p.id];
    return { id: p.id, key: p.key, state: p.state, added: !!p.added, dependsOn: (p.dependsOn ?? []).map((x) => x.key),
      builders: (d.item.pushActors ?? []).filter(isModel),
      approvedBy: [...new Set(d.reviews.filter((r) => r.approve && r.head === d.item.head && !(d.item.pushActors ?? []).map(familyOf).includes(familyOf(r.by))).map((r) => r.by))],
      integratedAt: d.events.find((e) => e.kind === "part.integrated")?.at ?? null };
  }),
  mergedAt: byId.t197.events.find((e) => e.kind === "item.merged")?.at ?? null,
};

// The Models page's figures, from GET /api/reliability (saved by
// fetch-ledger): each agent's speed and stalls over the speed window, and
// each reviewer's judged findings. Across all projects; only model names.
const relRaw = JSON.parse(readFileSync(new URL("../.cache/api-reliability.json", import.meta.url), "utf8"));
const gwRaw = JSON.parse(readFileSync(new URL("../.cache/api-usage.json", import.meta.url), "utf8")).gateway ?? {};
const api = {
  readAt: relRaw.speed.until,
  speed: { days: relRaw.speed.days, since: relRaw.speed.since, until: relRaw.speed.until, minSamples: relRaw.speed.minSamples, models: relRaw.speed.models.map((m) => ({ model: m.model, build: m.build, review: m.review })) },
  findings: relRaw.models.filter((m) => m.findingsConfirmed || m.findingsRefuted).map((m) => ({ model: m.model, upheld: m.findingsConfirmed, refuted: m.findingsRefuted })),
  gateway: { readable: !gwRaw.off, models: (gwRaw.models ?? []).length, days: gwRaw.days ?? null },
};

writeFileSync(new URL("../data/ledger.json", import.meta.url), JSON.stringify({ facts, stories, moment, plan, selfTasks, fleet, localPool, localDispatches, localMerged, api, tasks }, null, 1) + "\n");
console.log(JSON.stringify(facts, null, 1));
