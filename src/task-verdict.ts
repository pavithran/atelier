// The task page (t586): it leads with its verdict, then the five-step track,
// then the evidence as a checklist, the builder's summary marked Not verified,
// and the diff; the thread, rounds, history, brief and technical details sit
// folded below. Read only: it draws no button or form of its own. The forms
// the page has always drawn arrive in `parts`, already drawn by src/ui.ts, and
// are set below the verdict in the order they had.
//
// It takes the Detail that Ledger.detail returns and the diff diffFor reads,
// and nothing else: no ledger or fetch call. A figure the record lacks reads
// "not recorded", or is left out.

import { bindingOf, countingReviews, countingRunsAt, DEFAULT_OWNER, evidenceAt, singleFamily } from "./rules.ts";
import { definingOf, submission } from "./brief.ts";
import { vendorOf } from "./graph.ts";
import { findingJudgements, type FindingJudgement } from "./models/finding-judgements.ts";
import { stamp } from "./time.ts";
import type { ItemDiff } from "./diff.ts";
import type { Detail, ReviewParts } from "./ui.ts";

export type TrackStep = { verb: string; line: string; state: "done" | "current" | "todo" };
export interface TaskVerdictContext {
  project: string;            // the project's name, for its links
  projectTitle: string;
  progress: { steps: TrackStep[]; note: string | null };   // taskProgress (src/ui.ts)
}

const NOT_RECORDED = "not recorded";
const e = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const when = (iso: string | null | undefined): string => (iso && Number.isFinite(Date.parse(iso)) ? stamp(iso) : NOT_RECORDED);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Where a check ran, as brief.ts says it (WHERE_LABEL there is not exported).
const WHERE_LABEL = { sandbox: "in a Cloudflare container", runner: "on a runner, in a clean clone" } as const;

const COMPANY: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google", zai: "Z.ai", deepseek: "DeepSeek", qwen: "Alibaba", minimax: "MiniMax",
  mistral: "Mistral", meta: "Meta", moonshot: "Moonshot", xai: "xAI", xiaomi: "Xiaomi", bytedance: "ByteDance", cohere: "Cohere",
  other: "company not recorded", owner: "the developer",
};

function who(actor: string, owner: string): { model: string; company: string; text: string } {
  const vendor = vendorOf(actor, owner);
  const slash = actor.indexOf("/");
  const model = vendor === "owner" ? "the developer" : slash === -1 ? actor : actor.slice(slash + 1);
  const company = COMPANY[vendor] ?? NOT_RECORDED;
  return { model, company, text: vendor === "owner" ? model : `${model} (${company})` };
}

const ICON = {
  ok: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.4l2.6 2.6L12 5.4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bad: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4.2v4.6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="8" cy="11.4" r="1.1" fill="currentColor"/></svg>',
  wait: "",
  chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
type Mark = keyof Pick<typeof ICON, "ok" | "bad" | "warn" | "wait">;
const mark = (kind: Mark, label: string) => `<span class="mark mark-${kind}" role="img" aria-label="${e(label)}">${ICON[kind]}</span>`;

// ── the verdict ────────────────────────────────────────────────────────────

type Kind = "ready" | "sent-back" | "protected" | "blocked" | "failed" | "accepted" | "merged" | "closed" | "open" | "working" | "waiting";
interface Verdict { kind: Kind; line: string; ask: string }

function verdictOf(d: Detail): Verdict {
  const { item, gate } = d;
  const owner = d.ownerActor ?? DEFAULT_OWNER;
  const counted = countingReviews(d.reviews, bindingOf(item), d.policy, owner);
  const view = evidenceAt(d.policy, d.evidence, item.head);
  const required = view.checks.length;
  const passed = view.checks.filter((c) => c.grade === "observed" && c.passed).length;
  const failed = view.checks.filter((c) => c.grade === "observed" && !c.passed);
  const rejection = counted.filter((r) => !r.approve).sort((a, b) => b.at.localeCompare(a.at))[0];
  // An independent reviewer's approval is named before the developer's own.
  const approval = counted.filter((r) => r.approve).sort((a, b) => Number(a.by === owner) - Number(b.by === owner) || b.at.localeCompare(a.at))[0];
  const holder = item.owner ?? "the task holder";

  if (item.state === "merged") return { kind: "merged", line: "Landed. The change is in the project.", ask: "Nothing waits on you." };
  if (item.state === "abandoned") return { kind: "closed", line: "Closed without landing.", ask: "Nothing waits on you." };
  if (item.state === "blocked" && item.blocked) {
    const by = who(item.blocked.by, owner);
    return { kind: "blocked", line: `Blocked by ${by.text} ${when(item.blocked.at)}: ${item.blocked.reason}`, ask: "Unblock it once what it waits on is settled." };
  }
  if (item.state === "open") return { kind: "open", line: item.dispatch ? "Sent to a runner; no one has claimed it yet." : "No one has claimed it yet.", ask: "Send it to an agent, or wait for one to claim it." };
  if (item.state === "accepted") return { kind: "accepted", line: `Accepted${item.acceptedHead ? ` at ${item.acceptedHead.slice(0, 8)}` : ""}; it is waiting for the merge.`, ask: "Merge it, with the command below." };
  if (item.state === "claimed" || !item.head) return { kind: "working", line: `${holder} is working on it${item.head ? "" : "; nothing is pushed yet"}.`, ask: "Nothing for you to do yet." };
  if (rejection) {
    const r = who(rejection.by, owner);
    return { kind: "sent-back", line: `Sent back by ${r.text}: ${rejection.note || "no note recorded"}`, ask: `Nothing for you to do: waiting for ${holder} to address the review and push a new revision.` };
  }
  if (gate.needsAssessor) {
    const single = singleFamily(d.policy);
    const need = gate.requirement ? `${gate.requirement}.` : `It needs a review by ${single ? `a different ${single} model than every contributor` : "a model of another company than every contributor"}.`;
    return { kind: "protected", line: need, ask: "Only that review moves it on." };
  }
  if (failed.length) return { kind: "failed", line: `${failed.length} of ${required} required checks failed: ${failed.map((c) => c.claim).join(", ")}.`, ask: `Waiting for ${holder} to fix it and run the checks again.` };
  if (gate.ready) {
    const checks = required ? `${passed} of ${required} required checks passed` : "No checks are required";
    const by = approval ? who(approval.by, owner) : null;
    return { kind: "ready", line: by ? `Approved by ${by.text}. ${checks}.` : `${checks}. No approving review is recorded.`, ask: "Ready to land: land it from chat." };
  }
  return { kind: "waiting", line: `Not ready: ${gate.blockers.length ? gate.blockers.join("; ") : "the gate gives no reason"}.`, ask: "Waiting on what is listed under evidence." };
}

// ── the track ──────────────────────────────────────────────────────────────

function trackOf(d: Detail, ctx: TaskVerdictContext, kind: Kind): string {
  const { item } = d;
  const owner = d.ownerActor ?? DEFAULT_OWNER;
  let steps = ctx.progress.steps.map((s) => ({ ...s }));
  // A task the gate calls ready has been reviewed: Review is done and Land is next.
  if (d.gate.ready && item.state !== "merged" && item.state !== "abandoned" && item.state !== "blocked") {
    steps = steps.map((s) => (s.verb === "Review" ? { ...s, state: "done" as const } : s.verb === "Land" ? { ...s, state: "current" as const } : s));
  }
  const rejection = countingReviews(d.reviews, bindingOf(item), d.policy, owner).filter((r) => !r.approve).sort((a, b) => b.at.localeCompare(a.at))[0];
  const done = steps.filter((s) => s.state === "done").length;
  const note = (s: TrackStep): string => {
    if (s.verb === "Review" && kind === "sent-back" && rejection) return `Sent back ${when(rejection.at)}`;
    if (s.state === "current") return item.state === "blocked" ? "Blocked here" : kind === "ready" ? "Waiting for you" : "Now";
    return s.state === "done" ? "Done" : "Not yet";
  };
  const lis = steps.map((s) => `<li class="st st-${s.state === "current" ? "now" : s.state === "done" ? "done" : "next"}${s.verb === "Review" && kind === "sent-back" ? " was-back" : ""}"${s.state === "current" ? ' aria-current="step"' : ""}><span class="node">${s.state === "done" ? ICON.ok : ""}</span><b class="st-name">${e(s.verb)}</b><span class="st-note">${e(note(s))}</span></li>`).join("");
  return `<ol class="track done-${done}" aria-label="Progress: claim, branch, prove, review, land">${lis}</ol>${ctx.progress.note && item.state !== "blocked" ? `<p class="meta task-steps-note">${e(ctx.progress.note)}</p>` : ""}`;
}

// ── the evidence ───────────────────────────────────────────────────────────

function checkRows(d: Detail): { html: string; count: string; allPassed: boolean } {
  const view = evidenceAt(d.policy, d.evidence, d.item.head);
  if (!view.checks.length) return { html: `<ul class="rows"><li class="row">${mark("wait", "none required")}<div class="row-main"><span>${view.notApplicable.length ? "No required check applies to this revision." : "This project requires no checks."}</span></div></li></ul>`, count: "", allPassed: false };
  const rows = view.checks.map((c) => {
    const last = countingRunsAt(d.policy, d.evidence, d.item.head, c.claim).at(-1);
    const status = c.grade === "pending" ? "waiting" : c.passed ? "passed" : "failed";
    const where = c.grade === "observed" ? WHERE_LABEL[c.where === "sandbox" ? "sandbox" : "runner"] : "";
    const time = status === "waiting" || !last ? "" : when(last.at);
    return `<li class="row is-${status}">${mark(status === "passed" ? "ok" : status === "failed" ? "bad" : "wait", status)}<div class="row-main"><span class="mono">${e(c.claim)}</span><span class="row-sub">${status === "passed" ? "Passed" : status === "failed" ? "Failed" : "Waiting: no run at this revision yet"}${where ? `, ${e(where)}` : ""}</span></div><div class="row-meta">${time ? e(time) : status === "waiting" ? "no run yet" : NOT_RECORDED}</div></li>`;
  }).join("");
  const passed = view.checks.filter((c) => c.grade === "observed" && c.passed).length;
  return { html: `<ul class="rows">${rows}</ul>`, count: `${passed} of ${view.checks.length} passed`, allPassed: passed === view.checks.length };
}

function reviewRows(d: Detail): string {
  const { item } = d;
  const owner = d.ownerActor ?? DEFAULT_OWNER;
  const counted = countingReviews(d.reviews, bindingOf(item), d.policy, owner).sort((a, b) => a.at.localeCompare(b.at));
  if (!counted.length) return `<ul class="rows"><li class="row">${mark("wait", "waiting")}<div class="row-main"><span>No counting review at this revision yet.</span></div></li></ul>`;
  const submitted = definingOf(d).filter((ev) => ev.itemId === item.id && ev.kind === "item.submitted").map((ev) => ev.at).sort();
  const judged: FindingJudgement[] = findingJudgements(d.judgementEvents ?? d.events, owner).findings;
  const rows = counted.map((r) => {
    const w = who(r.by, owner);
    const round = submitted.filter((at) => at <= r.at).length;
    const seq = (r as { seq?: number }).seq;
    const blocking = (r.findings ?? []).map((f, i) => [f, i + 1] as const).filter(([f]) => f.severity === "blocking").map(([f, index]) => {
      // A verdict is on one review's finding: matched by that review's seq and the finding's 1-based index, never by its words.
      const j = judged.find((x) => x.review === seq && x.index === index);
      return `<div class="finding"><div class="finding-top"><span class="tag tag-bad">Blocking</span><span class="mono">${e(f.file)}${f.line === null ? "" : `:${f.line}`}</span></div><p>${e(f.text)}</p><p class="finding-verdict">${j?.verdict ? `Verdict: ${e(j.verdict)}` : "Verdict: not judged yet"}</p></div>`;
    }).join("");
    return `<li class="row">${mark(r.approve ? "ok" : "bad", r.approve ? "approved" : "changes requested")}<div class="row-main"><span>${e(w.model)} <span class="co">${e(w.company)}</span> ${r.approve ? "approved" : "asked for changes"}</span><span class="row-sub">Built by ${item.owner ? e(who(item.owner, owner).model) : NOT_RECORDED}${r.note ? ` · ${e(r.note)}` : ""}</span>${blocking}</div><div class="row-meta">${round ? `Round ${round}` : `Round ${NOT_RECORDED}`}<span class="sep">·</span>${e(when(r.at))}</div></li>`;
  }).join("");
  return `<ul class="rows">${rows}</ul>`;
}

function scopeRows(d: Detail, diff: ItemDiff | "unavailable" | null): string {
  const { item, gate } = d;
  const read = diff && diff !== "unavailable" ? diff : null;
  const outside = gate.outOfScope;
  const inside = read ? `${Math.max(0, read.files.length - outside.length)} of ${read.files.length}${read.truncated ? "+" : ""} files inside` : "not read";
  const chips = (list: string[], cls = "") => `<span class="chips">${list.map((x) => `<span class="chip ${cls} mono">${e(x)}</span>`).join("")}</span>`;
  return `<ul class="rows"><li class="row">${mark(outside.length ? "warn" : "ok", outside.length ? "outside scope" : "inside scope")}<div class="row-main"><span>Declared: ${item.scope.length ? "" : "unrestricted"}</span>${item.scope.length ? chips(item.scope) : ""}${outside.length ? `<span class="row-sub">Outside it:</span>${chips(outside, "chip-warn")}` : ""}</div><div class="row-meta">${e(inside)}</div></li></ul>`;
}

function evidenceBlock(d: Detail, diff: ItemDiff | "unavailable" | null): string {
  const checks = checkRows(d);
  return `<section class="block evidence" aria-labelledby="evidence-h"><h3 id="evidence-h">Evidence</h3>
  <div class="card list">
    <div class="group-h"><span>Required checks</span>${checks.count ? `<span class="count${checks.allPassed ? " c-ok" : ""}">${e(checks.count)}</span>` : ""}</div>
    ${checks.html}
    <div class="group-h"><span>Review</span></div>
    ${reviewRows(d)}
    <div class="group-h"><span>Scope</span></div>
    ${scopeRows(d, diff)}
  </div></section>`;
}

// ── the page ───────────────────────────────────────────────────────────────

const fold = (title: string, inner: string, id = "") => `<details class="fold"${id ? ` id="${id}"` : ""}><summary>${ICON.chevron}<span>${e(title)}</span></summary>${inner.trim() ? inner : `<p class="meta">${NOT_RECORDED[0].toUpperCase()}${NOT_RECORDED.slice(1)}.</p>`}</details>`;

export function renderTaskVerdict(d: Detail, diff: ItemDiff | "unavailable" | null, parts: ReviewParts, ctx: TaskVerdictContext): string {
  const { item } = d;
  const v = verdictOf(d);
  const said = submission(definingOf(d), item.id, item.head);
  const summary = item.head
    ? `<section class="block said-block"><h3>What the builder says <span class="tag tag-unv">Not verified</span></h3>
  <blockquote class="said"><p>${said ? `“${e(said.summary)}”` : `Summary ${NOT_RECORDED}`}</p>${said ? `<footer>${e(said.by)}, in its own words</footer>` : ""}</blockquote></section>`
    : "";
  const hero = `<article class="card hero is-${v.kind}">
  <header class="review-header">
    <p class="crumbs mono">${e(ctx.projectTitle)}<span>/</span>${e(item.id)}</p>
    <h2>${e(item.title)}</h2>
    <p class="decision-status pill ${v.kind}"><span class="pill-dot"></span><strong>${e(parts.status.title)}</strong></p>
    ${v.kind === "ready" ? "" : `<p class="review-description">${e(parts.status.detail)}</p>`}
    ${parts.status.unknowns.map((u) => `<p class="meta">${e(u)}</p>`).join("")}
  </header>
  <div class="verdict" id="verdict"><p class="verdict-line">${e(v.line)}</p><p class="verdict-ask">${e(v.ask)}</p></div>
  ${trackOf(d, ctx, v.kind)}
</article>`;

  const browse = item.workspace ? `<p class="meta browse"><a href="/p/${encodeURIComponent(ctx.project)}/${encodeURIComponent(item.id)}/code">Browse the branch</a> · <a href="/p/${encodeURIComponent(ctx.project)}/${encodeURIComponent(item.id)}/log">Its log</a></p>` : "";
  // The forms and refusals main draws, and the commands it gives, below the verdict. A task ready to land shows no command, here or in the decision brief (which tells the reader to run one): its landing is asked of chat.
  const actions = `${parts.notice}${v.kind === "ready" ? parts.ownerRows : parts.ownerState}
  <div class="actions">${parts.actions}</div>${parts.secret}${v.kind === "ready" ? "" : `${parts.askReview}${parts.merge}`}${parts.reaccept}`;
  const body = item.head
    ? `${evidenceBlock(d, diff)}${parts.fast}${summary}
  <section id="changes" class="block changes"><h3>Changes</h3><div class="card diff">${parts.diff}${parts.scope}${parts.protectedNote}</div></section>`
    : `${parts.openScope}${parts.fastReady}${parts.notices}`;
  const folds = `<div class="folds">
  ${fold("Thread", parts.thread)}
  ${fold("Earlier rounds", parts.rounds)}
  ${parts.history.replace('<details class="disclosure" id="history"><summary>Task history</summary>', `<details class="fold" id="history"><summary>${ICON.chevron}<span>Task history</span></summary>`)}
  ${fold("Brief and acceptance criteria", `${parts.text}${parts.origin}${parts.framing}${v.kind === "ready" ? parts.briefAsk : parts.brief}`)}
  ${fold("Check output and review notes", parts.checks, item.head ? "checks" : "")}
  ${fold(`Technical details${parts.live ? " and handoff" : ""}`, `${parts.technical}${browse}${parts.ownership}${parts.close}`)}
</div>`;
  return `${hero}
<div class="verdict-actions">${actions}</div>
${parts.revision}
${body}
${folds}`;
}
