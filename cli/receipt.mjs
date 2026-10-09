// A task's receipt: its whole story from the ledger, in the order the events
// were recorded. Pure: the caller fetches the item's detail (GET
// /api/projects/NAME/items/ID, which carries the item's events newest first)
// and this only formats, so the same text prints from a test as from the
// server's answer. Every field a person or an agent wrote is flattened, so a
// newline inside a note or finding can never pose as a line of the story.
//
// The story is the events that say what became of the task: created, claimed,
// handed off and released, each pushed head as Artifacts answered it, each
// observed check at each head, each review with its verdict and every finding
// (the owner's verdict on a finding printed under the finding it judged, as
// the ledger binds them: head, reviewer, index and the finding itself), the
// submission, the acceptance and the merge or abandonment that ended it. The
// landing's own steps (land.*) and the queue's plumbing (dispatches, review
// requests and their claims, forks, sandbox runs) are the integration record,
// not the story; `--json` carries the whole event stream for a machine reader.
import { stripVTControlCharacters } from "node:util";
import { DEFAULT_OWNER, recordedText } from "../src/rules.ts";

const flat = (value) => stripVTControlCharacters(String(value)).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
const at = (iso) => `${String(iso).slice(0, 16).replace("T", " ")} UTC`;
const short = (sha) => (sha ? String(sha).slice(0, 8) : "—");

// A verdict binds to its finding as the ledger binds it (findingKey in
// src/review/needed.ts): the head, the reviewer, the finding's position and
// the finding itself. Bound here again rather than imported, so the review
// code stays called by the ledger and the runner alone; test/receipt.test.mjs
// holds this to the same binding.
const findingKey = (head, by, index, f) => JSON.stringify([head, by, index, f?.file ?? "", f?.text ?? ""]);

// The owner's verdicts on findings, the newest record of each winning.
function ownerVerdicts(events) {
  const found = new Map();
  for (const e of events) {
    if (e.kind !== "review.finding") continue;
    const d = e.data ?? {};
    if (typeof d.head !== "string" || typeof d.index !== "number" || typeof d.verdict !== "string") continue;
    const key = findingKey(d.head, d.by, d.index, d.finding ?? {});
    const held = found.get(key);
    if (!held || (e.seq ?? 0) > held.seq) found.set(key, { verdict: d.verdict, note: typeof d.note === "string" ? d.note : "", seq: e.seq ?? 0 });
  }
  return new Map([...found].map(([k, v]) => [k, { verdict: v.verdict, note: v.note }]));
}

// The detail route reads this many of the item's events; a record at the
// limit may hold more beyond it.
export const EVENT_PAGE = 200;

// The item's events, oldest first: the order they were recorded in.
export function receiptEvents(detail) {
  return [...(detail?.events ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

// The receipt as a machine reads it: the item's own fields and its whole
// event stream in the ledger's order, newest page included.
export function receiptJson(project, id, detail) {
  return { project, id, title: flat(detail.item.title), state: detail.item.state, events: receiptEvents(detail) };
}

// One line for each event of the story, or null for an event the receipt
// does not tell (the plumbing named above). A review answers with more lines:
// each finding of its own, and under a finding the owner's verdict on it.
function linesFor(e, verdicts, used, owner) {
  const d = e.data ?? {};
  switch (e.kind) {
    case "item.created":
      // The header line above already names the task and its title; the created
      // event says who filed it and when.
      return [`created by ${flat(e.actor)}`];
    case "item.claimed":
      return [`claimed by ${flat(e.actor)}${d.runner ? `, on runner ${flat(d.runner)}` : ""}`];
    case "item.handoff":
      return [`handed off by ${flat(d.from ?? "?")} to ${flat(d.to ?? "?")}${d.note ? `: ${flat(d.note)}` : ""}`];
    case "item.released":
      return [`released by ${flat(e.actor)}${d.from ? `, who held it` : ""}${d.note ? `: ${flat(d.note)}` : ""}`];
    case "item.edited": {
      const fields = [["nonGoals", "non-goals"], ["stopWhen", "stop-when"], ["nextGate", "next gate"]].filter(([k]) => d[k] !== undefined).map(([, label]) => label);
      return [`framing edited by ${flat(e.actor)}${fields.length ? `: ${fields.join(", ")}` : ""}`];
    }
    case "push.observed":
      return [`head ${short(d.head)} pushed by ${flat(e.actor)}, observed in Artifacts${d.rebasedFrom ? `, rebased from ${short(d.rebasedFrom)}` : ""}${d.reportedHead ? ` (the agent named ${short(d.reportedHead)})` : ""}${d.approvalInvalidated ? "; the acceptance at the earlier head no longer stands" : ""}`];
    case "push.unrecorded":
      return [`head ${short(d.head)} seen in Artifacts outside a recorded push; the recorded head ${short(d.recorded)} stands (${flat(d.reason)})`];
    case "evidence.observed":
      return [`check ${d.passed ? "passed" : "failed"}, observed${d.where === "sandbox" ? " in a Cloudflare container" : " in a clean clone"}: ${flat(d.claim)} at ${short(d.head)}${d.merged ? `, merged with main ${short(d.mainHead)}` : ""}`];
    case "evidence.reported":
      return [`claim reported by ${flat(e.actor)}: ${flat(d.claim)} at ${short(d.head)} (shown, never counted as a check)`];
    case "evidence.not_applicable":
      return [`check not applicable at ${short(d.head)}: ${flat(d.claim)}`];
    case "review.approved":
    case "review.rejected": {
      const verdict = e.kind === "review.approved" ? "approved" : "rejected";
      // Who recorded the verdict, as the task page says it (recordedText):
      // the reviewer itself when its own token proved the event, else the
      // owner token in the reviewer's name. An event from before the ledger
      // recorded that says nothing.
      const recorded = recordedText({ by: e.actor, recordedBy: d.recordedBy, proved: e.proved === true, claimed: d.claimed === true }, owner);
      const out = [`${d.tier ? "tier review " : ""}${verdict} by ${flat(e.actor)} at ${short(d.head)}${recorded ? ` (${flat(recorded)})` : ""}: ${flat(d.note) || "(no note)"}`];
      (d.findings ?? []).forEach((f, i) => {
        out.push(`${i + 1}. ${flat(f.severity)} ${flat(f.file)}${f.line ? `:${f.line}` : ""} ${flat(f.text)}`);
        const key = findingKey(d.head, e.actor, i + 1, { file: String(f.file ?? ""), text: String(f.text ?? "") });
        const v = verdicts.get(key);
        if (v) { used.add(key); out.push(`owner's verdict: ${flat(v.verdict)}${v.note ? `. ${flat(v.note)}` : ""}`); }
      });
      return out;
    }
    case "review.finding": {
      const key = findingKey(d.head, d.by, d.index, { file: String(d.finding?.file ?? ""), text: String(d.finding?.text ?? "") });
      if (used.has(key)) return null;
      const f = d.finding ?? {};
      return [`finding verdict by ${flat(e.actor)}: ${flat(d.verdict)} on ${flat(f.severity)} ${flat(f.file)}${f.line ? `:${f.line}` : ""} of the review at ${short(d.head)} (#${d.index})`];
    }
    case "item.submitted":
      return [`submitted by ${flat(e.actor)} at ${short(d.head)}${d.summary ? `: ${flat(d.summary)}` : ""}`];
    case "review.overridden":
      return [`independent review overridden by ${flat(e.actor)}: ${flat(d.reason)}`];
    case "item.accepted":
      return [`accepted by ${flat(e.actor)} at ${short(d.head)}${d.note ? `: ${flat(d.note)}` : ""}`];
    case "item.merged":
      return [`merged by ${flat(e.actor)}: ${short(d.head)} accepted, merge commit ${short(d.mergeCommit)} on the baseline`];
    case "item.abandoned":
      return [`abandoned by ${flat(e.actor)}${d.note ? `: ${flat(d.note)}` : ""}${d.deliveredBy ? `; delivered by ${flat(d.deliveredBy)}` : ""}`];
    case "item.blocked":
      return [`blocked by ${flat(e.actor)}: ${flat(d.reason)}`];
    case "item.unblocked":
      return [`unblocked by ${flat(e.actor)}, back to ${flat(d.to)}`];
    case "item.defect":
      return [`defect recorded by ${flat(e.actor)} at ${short(d.head)}: ${flat(d.note)}${d.foundIn ? ` (found in ${flat(d.foundIn)})` : ""}`];
    default:
      return null;
  }
}

// The receipt as a person reads it: a header naming the task, one line per
// story event in the order it was recorded, and the task's address when an
// origin is given.
export function receiptText(project, id, detail, origin = null) {
  const events = receiptEvents(detail);
  const verdicts = ownerVerdicts(events);
  const used = new Set();
  const owner = detail.ownerActor ?? DEFAULT_OWNER;
  const cut = events.length >= EVENT_PAGE;
  const lines = [
    `${project}/${id}  ${flat(detail.item.title)}`,
    `The whole story from the ledger, in order${cut ? ` (the newest ${events.length} events; the record may hold more)` : ""}.`,
  ];
  const pad = " ".repeat(22);
  for (const e of events) {
    const own = linesFor(e, verdicts, used, owner);
    if (!own) continue;
    lines.push(...own.map((line, i) => (i ? pad + line : `${at(e.at)}  ${line}`)));
  }
  if (origin) lines.push(`${origin}/p/${encodeURIComponent(project)}/${encodeURIComponent(id)}`);
  return lines.join("\n");
}
