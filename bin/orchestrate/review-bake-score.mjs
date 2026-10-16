// review-bake-score.mjs: scores the reviews a review-bake.sh run collected
// against the judge's ground truth.
//
//   node review-bake-score.mjs --out DIR --truth truth.json [--sample sample.txt]
//        [--labels labels.json] [--json] [--write]
//
// DIR/reviews/REVIEWER__BUILD.md holds each review (REVIEWER is the reviewer
// with "/" written "_"), DIR/status/REVIEWER__BUILD.json how its run ended,
// DIR/pairs.txt (reviewer TAB build) every pair the run scheduled: a pair with
// neither file counts as a failed review (missing), and the report says how many.
// truth.json (see below) says, per build, its judge's grade, the defects the
// judge confirmed (each with a regular expression that recognises a FINDING
// line naming it) and the findings the judge ruled false or outside the review
// bar. A review is read for its last "VERDICT: APPROVE|REJECT" line and its
// "FINDING: blocking|followup file:line text" lines; a review with no verdict
// line is a failed review and counts only as failed.
//
// Per review it reports: the confirmed defects the review caught (a FINDING of
// either severity matched the defect), the defects it missed, its blocking
// findings that are true (they match a confirmed defect), false (they match a
// finding the judge ruled false) or unjudged (neither: read them, then say
// what they are in labels.json), an approval of a C or D build, a rejection of
// an A build. Per reviewer it totals those and gives
//   precision = true blocking findings / all blocking findings (unjudged ones,
//               which the judge's verdict does not mention, count against it);
//               precisionJudged leaves the unjudged ones out,
//   recall    = confirmed defects caught / confirmed defects in the builds it
//               reviewed (recallReal counts only those the judge called real,
//               not tidy-ups).
//
// truth.json: { ruled: [RULED], builds: { BUILD: { grade, defects: [DEFECT],
//   ruled: [RULED] } } } with DEFECT = { id, severity: "real"|"minor", desc,
//   re } and RULED = { id, desc, re }. labels.json: { "REVIEWER|BUILD|N":
//   VALUE } where N is the finding's place in its review (from 0) and VALUE is
//   a defect id (the finding names that defect), "false" (a blocking finding
//   that is wrong or outside the bar), "real" (a blocking finding that is a
//   true defect the judge did not list), "other" (a blocking finding the
//   judge's verdict does not mention, true or not: it stays unjudged) or
//   "none" (counts for nothing). Ids join with "+".
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const VERDICT_LINE = /^[\s>*_`#-]*(?:VERDICT)[\s*_`]*:[\s*_`]*(APPROVE|REJECT)\b/i;
const FINDING_LINE = /^[\s>*_`#-]*FINDING[\s*_`]*:?[\s*_`]*\[?(blocking|follow-?up|non-?blocking)\]?[\s*_`]*:?\s+(\S+)\s*(.*)$/i;

// parseReview(text): { verdict: "APPROVE"|"REJECT"|null, findings: [{ index, severity, where, text }] }.
export function parseReview(text) {
  let verdict = null;
  const findings = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const v = VERDICT_LINE.exec(raw);
    if (v) verdict = v[1].toUpperCase();
    const f = FINDING_LINE.exec(raw);
    if (f) {
      const severity = f[1].toLowerCase() === "blocking" ? "blocking" : "followup";
      findings.push({ index: findings.length, severity, where: f[2], text: f[3].replace(/[*_`]+$/g, "").trim() });
    }
  }
  return { verdict, findings };
}

const matches = (re, s) => new RegExp(re, "i").test(s);

// classify(review, entry, labels, labelPrefix, ruled): what each finding is.
// A finding is { kind: "defect", ids } (it names confirmed defects), "false",
// "real", "unjudged" or "none"; a followup is only ever "defect" or "none".
export function classify(parsed, entry, ruled, labels = {}, prefix = "") {
  return parsed.findings.map((f) => {
    const label = labels[`${prefix}|${f.index}`];
    const subject = `${f.where} ${f.text}`;
    if (label !== undefined) {
      if (label === "false") return { ...f, kind: f.severity === "blocking" ? "false" : "none", ids: [], labelled: true };
      if (label === "real") return { ...f, kind: f.severity === "blocking" ? "real" : "none", ids: [], labelled: true };
      if (label === "none") return { ...f, kind: "none", ids: [], labelled: true };
      if (label === "other") return { ...f, kind: f.severity === "blocking" ? "unjudged" : "none", ids: [], labelled: true };
      const ids = String(label).split("+");
      return { ...f, kind: "defect", ids, labelled: true };
    }
    const ids = entry.defects.filter((d) => matches(d.re, subject)).map((d) => d.id);
    if (ids.length) return { ...f, kind: "defect", ids };
    if (f.severity !== "blocking") return { ...f, kind: "none", ids: [] };
    const isRuled = [...ruled, ...(entry.ruled ?? [])].some((r) => matches(r.re, subject));
    return { ...f, kind: isRuled ? "false" : "unjudged", ids: [] };
  });
}

// scoreReview(...): the numbers for one review of one build.
export function scoreReview({ reviewer, build, text, status, missing }, truth, labels = {}) {
  const entry = truth.builds[build];
  if (!entry) throw new Error(`no ground truth for build ${build}`);
  const parsed = parseReview(text ?? "");
  const base = { reviewer, build, grade: entry.grade, defects: entry.defects.length, tries: status?.tries ?? null, missing: Boolean(missing) };
  if (!parsed.verdict) return { ...base, failed: true, verdict: null, caught: [], caughtBlocking: [], missed: entry.defects.map((d) => d.id), trueBlocking: 0, falseBlocking: 0, unjudgedBlocking: 0, badApproval: false, badRejection: false, findings: [] };
  const key = `${reviewer}|${build}`;
  const findings = classify(parsed, entry, truth.ruled ?? [], labels, key);
  const caught = new Set(), caughtBlocking = new Set();
  for (const f of findings) if (f.kind === "defect") for (const id of f.ids) { caught.add(id); if (f.severity === "blocking") caughtBlocking.add(id); }
  const count = (k) => findings.filter((f) => f.severity === "blocking" && f.kind === k).length;
  // A blocking finding naming a confirmed defect, or labelled real, is true.
  const trueBlocking = findings.filter((f) => f.severity === "blocking" && (f.kind === "defect" || f.kind === "real")).length;
  return {
    ...base,
    failed: false,
    verdict: parsed.verdict,
    caught: [...caught],
    caughtBlocking: [...caughtBlocking],
    missed: entry.defects.filter((d) => !caught.has(d.id)).map((d) => d.id),
    trueBlocking,
    falseBlocking: count("false"),
    unjudgedBlocking: count("unjudged"),
    badApproval: parsed.verdict === "APPROVE" && (entry.grade === "C" || entry.grade === "D"),
    badRejection: parsed.verdict === "REJECT" && entry.grade === "A",
    findings,
  };
}

// scoreRun(reviews, truth, labels): per-review rows and per-reviewer totals.
export function scoreRun(reviews, truth, labels = {}) {
  const rows = reviews.map((r) => scoreReview(r, truth, labels));
  const reviewers = {};
  for (const r of rows) {
    const t = (reviewers[r.reviewer] ??= { reviewer: r.reviewer, reviews: 0, failed: 0, missing: 0, approvalsCD: 0, rejectionsA: 0, defects: 0, defectsReal: 0, caught: 0, caughtReal: 0, trueBlocking: 0, falseBlocking: 0, unjudgedBlocking: 0, rightVerdicts: 0, judgedVerdicts: 0 });
    t.reviews++;
    if (r.missing) t.missing++;
    if (r.failed) { t.failed++; continue; }
    const entry = truth.builds[r.build];
    t.approvalsCD += r.badApproval ? 1 : 0;
    t.rejectionsA += r.badRejection ? 1 : 0;
    t.defects += entry.defects.length;
    t.defectsReal += entry.defects.filter((d) => d.severity === "real").length;
    t.caught += r.caught.length;
    t.caughtReal += r.caught.filter((id) => entry.defects.find((d) => d.id === id)?.severity === "real").length;
    t.trueBlocking += r.trueBlocking;
    t.falseBlocking += r.falseBlocking;
    t.unjudgedBlocking += r.unjudgedBlocking;
    // The right verdict: reject a C or D build, approve an A build; B is either.
    if (r.grade !== "B") { t.judgedVerdicts++; if ((r.grade === "A") === (r.verdict === "APPROVE")) t.rightVerdicts++; }
  }
  const ratio = (a, b) => (b ? a / b : null);
  for (const t of Object.values(reviewers)) {
    const blocking = t.trueBlocking + t.falseBlocking + t.unjudgedBlocking;
    t.blocking = blocking;
    t.precision = ratio(t.trueBlocking, blocking);
    t.precisionJudged = ratio(t.trueBlocking, t.trueBlocking + t.falseBlocking);
    t.recall = ratio(t.caught, t.defects);
    t.recallReal = ratio(t.caughtReal, t.defectsReal);
  }
  return { rows, reviewers: Object.values(reviewers) };
}

const pct = (x) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);

export function renderMarkdown(result) {
  const out = [];
  const missing = result.rows.filter((r) => r.missing);
  if (missing.length) out.push(`${missing.length} scheduled review(s) left no result and count as failed: ${missing.map((r) => `${r.reviewer} ${r.build}`).join("; ")}`, "");
  out.push("## Per reviewer", "");
  out.push("| reviewer | reviews | failed (missing) | approvals of C/D | rejections of A | right verdicts (A/C/D) | defects caught | blocking findings: true / false / unjudged | precision | precision (judged only) | recall | recall (real only) |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const t of result.reviewers) {
    out.push(`| ${t.reviewer} | ${t.reviews} | ${t.failed} (${t.missing}) | ${t.approvalsCD} | ${t.rejectionsA} | ${t.rightVerdicts}/${t.judgedVerdicts} | ${t.caught}/${t.defects} | ${t.trueBlocking} / ${t.falseBlocking} / ${t.unjudgedBlocking} | ${pct(t.precision)} | ${pct(t.precisionJudged)} | ${pct(t.recall)} | ${pct(t.recallReal)} |`);
  }
  out.push("", "## Per build", "");
  out.push("| build | grade | reviewer | verdict | caught | missed | blocking true / false / unjudged | flag |");
  out.push("|---|---|---|---|---|---|---|---|");
  const rows = [...result.rows].sort((a, b) => a.build.localeCompare(b.build) || a.reviewer.localeCompare(b.reviewer));
  for (const r of rows) {
    if (r.failed) { out.push(`| ${r.build} | ${r.grade} | ${r.reviewer} | FAILED | | | | ${r.missing ? "no result: scheduled but never recorded" : `no verdict after ${r.tries ?? "?"} tries`} |`); continue; }
    const flag = r.badApproval ? "approves a C/D build" : r.badRejection ? "rejects an A build" : "";
    out.push(`| ${r.build} | ${r.grade} | ${r.reviewer} | ${r.verdict} | ${r.caught.join(", ") || "-"} | ${r.missed.join(", ") || "-"} | ${r.trueBlocking} / ${r.falseBlocking} / ${r.unjudgedBlocking} | ${flag} |`);
  }
  return out.join("\n") + "\n";
}

// loadReviews(out, builds, reviewers, pairs): the review texts and statuses of
// a run. With `pairs` (the run's pairs.txt: every scheduled { reviewer, build })
// each pair is returned, and one with neither a review nor a status is marked
// missing, so it scores as a failed review instead of vanishing. Without
// pairs, only the pairs that left a file are returned.
export function loadReviews(out, builds, reviewers, pairs = null) {
  const reviews = [];
  const list = pairs ?? reviewers.flatMap((reviewer) => builds.map((build) => ({ reviewer, build })));
  for (const { reviewer, build } of list) {
    const file = `${reviewer.replace(/\//g, "_")}__${build}`;
    const md = join(out, "reviews", `${file}.md`);
    const st = join(out, "status", `${file}.json`);
    const none = !existsSync(st) && !existsSync(md);
    if (none && !pairs) continue;
    reviews.push({ reviewer, build, text: existsSync(md) ? readFileSync(md, "utf8") : "", status: existsSync(st) ? JSON.parse(readFileSync(st, "utf8")) : null, missing: none });
  }
  return reviews;
}

// readPairs(out, builds): the scheduled pairs of DIR/pairs.txt (reviewer TAB build), or null when the run left none.
export function readPairs(out, builds) {
  const file = join(out, "pairs.txt");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => { const [reviewer, build] = l.split("\t"); return { reviewer, build }; }).filter((p) => p.build && builds.includes(p.build));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // --has-verdict FILE: exit 0 when the file holds a verdict this parser reads (review-bake.sh's one test of a reply).
  const hv = process.argv.indexOf("--has-verdict");
  if (hv !== -1) {
    let text = "";
    try { text = readFileSync(process.argv[hv + 1], "utf8"); } catch { /* unreadable: no verdict */ }
    process.exit(parseReview(text).verdict ? 0 : 1);
  }
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? undefined : process.argv[i + 1]; };
  const out = arg("out"), truthFile = arg("truth");
  if (!out || !truthFile) { console.error("usage: review-bake-score.mjs --out DIR --truth truth.json [--sample sample.txt] [--labels labels.json] [--json] [--write]"); process.exit(64); }
  const truth = JSON.parse(readFileSync(truthFile, "utf8"));
  const labelsFile = arg("labels") ?? join(out, "labels.json");
  const labels = existsSync(labelsFile) ? JSON.parse(readFileSync(labelsFile, "utf8")) : {};
  const sampleFile = arg("sample") ?? join(out, "sample.txt");
  const builds = readFileSync(sampleFile, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.split(/\s+/)[0]);
  // The reviewers are those with a review or a status file in the run.
  const names = new Set();
  for (const dir of ["reviews", "status"]) {
    if (!existsSync(join(out, dir))) continue;
    for (const f of readdirSync(join(out, dir))) { const m = /^(.+)__(.+)\.(md|json)$/.exec(f); if (m && builds.includes(m[2])) names.add(m[1]); }
  }
  // "codex_gpt-6-astra" back to "codex/gpt-6-astra": the first underscore is the slash.
  for (const p of readPairs(out, builds) ?? []) names.add(p.reviewer.replace("/", "_"));
  const reviewers = [...names].map((n) => n.replace("_", "/")).sort();
  const pairs = readPairs(out, builds);
  const result = scoreRun(loadReviews(out, builds, reviewers, pairs), truth, labels);
  if (process.argv.includes("--write")) {
    const slim = { ...result, rows: result.rows.map(({ findings, ...r }) => ({ ...r, findings: findings.map(({ index, severity, where, kind, ids }) => ({ index, severity, where, kind, ids })) })) };
    writeFileSync(join(out, "scores.json"), JSON.stringify(slim, null, 2) + "\n");
    writeFileSync(join(out, "scores.md"), renderMarkdown(result));
  }
  process.stdout.write(process.argv.includes("--json") ? JSON.stringify(result, null, 2) + "\n" : renderMarkdown(result));
  const unjudged = result.rows.reduce((n, r) => n + (r.unjudgedBlocking ?? 0), 0);
  if (unjudged) console.error(`review-bake-score: ${unjudged} blocking finding(s) are unjudged; read them (--json) and label them in labels.json`);
}
