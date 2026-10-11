// t457: on 2026-10-10 the owner's approval of hqpe-control/t44 was recorded
// and the task page looked unchanged, and the override's disclosure looked
// like a button that did nothing. The page now says, beside its actions and
// from the record, where the owner's approval, the independent review, the
// command-line permission and the acceptance stand, with one next move, and
// draws the override as a disclosure apart from its submit buttons.
import { afterEach, expect, it } from "vitest";
import { NO_CRITERIA } from "../src/criteria.ts";
import { ownerState, renderItem, type Detail } from "../src/ui";
import { setTimeZone } from "../src/time";
import type { ProjectRecord, LedgerEvent } from "../src/ledger";
import type { Review } from "../src/rules";

const head = "a".repeat(40), other = "c".repeat(40), time = "2026-10-10T17:41:00Z";
const project: ProjectRecord = { name: "example", repo: "example", policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: time };
const diff = { head, base: "b".repeat(40), files: [], truncated: false };
const NOW = Date.parse("2026-10-10T18:00:00Z");

// A submitted protected change on a server behind Access, waiting for its
// independent review: the override is the one thing that could clear it.
function detail(): Detail {
  return {
    ownerActor: "pavi", ownerFactor: "access",
    item: { id: "t1", title: "Gallery sightlines", state: "submitted", owner: "codex/gpt-6", scope: ["src/**"], fork: "example--t1", base: "b".repeat(40), head, acceptedHead: null, lastPushAt: time, updatedAt: time, createdAt: time },
    policy: project.policy,
    evidence: [{ itemId: "t1", claim: "npm test", grade: "observed", head, passed: true, by: "codex/gpt-6", at: time, changedPaths: ["src/a.ts"] }],
    reviews: [], gate: { ready: false, needsAssessor: true, blockers: ["Protected"], outOfScope: [] }, events: [],
  };
}
const review = (o: Partial<Review>): Review => ({ itemId: "t1", head, criteria: NO_CRITERIA, approve: true, by: "pavi", note: "", at: time, ...o });
const event = (seq: number, kind: string, data: Record<string, unknown>, at = time): LedgerEvent => ({ seq, itemId: "t1", at, actor: "pavi", kind, data });
const header = (html: string) => html.slice(0, html.indexOf("</header>"));

afterEach(() => { setTimeZone(undefined); });

it("criterion 1: a recorded approval says Approved by you, with the short head and a zoned time, beside the actions, and Approve is not offered again", () => {
  setTimeZone("America/New_York");
  const d = detail();
  const before = renderItem(project, d, "PAVI", diff);
  expect(before).toContain("<button>Approve revision</button>");
  expect(before).not.toContain("Approved by you");
  d.reviews = [review({})];
  const html = renderItem(project, d, "PAVI", diff);
  const actions = html.slice(html.indexOf('<div class="actions">'));
  expect(actions.indexOf('<p class="approval-recorded" role="status"><strong>Approved by you</strong> at <code>aaaaaaaa</code>')).toBe(actions.indexOf("<p"));
  expect(actions).toContain('<time datetime="2026-10-10T17:41:00Z">2026-10-10 13:41 EDT</time>');
  expect(html).not.toContain("Approve revision");
  // The approval is the owner's own opinion, never the independent review.
  expect(actions).toContain("your own opinion, not the independent review");
});

it("criterion 1: only the configured owner's latest review at this head and criteria counts, and only while it approves", () => {
  const cases: [string, Review[], boolean][] = [
    ["another reviewer's approval", [review({ by: "codex/gpt-6-astra" })], false],
    ["an approval of another head", [review({ head: other })], false],
    ["an approval of other criteria", [review({ criteria: "sha256:old" })], false],
    ["a withdrawn approval", [review({ withdrawn: { by: "pavi", at: time, reason: "x" } } as Partial<Review>)], false],
    ["an approval since followed by a rejection", [review({}), review({ approve: false, note: "tighten", at: "2026-10-10T17:50:00Z" })], false],
    ["a rejection since followed by an approval", [review({ approve: false, note: "tighten" }), review({ at: "2026-10-10T17:50:00Z" })], true],
  ];
  for (const [what, reviews, approved] of cases) {
    const d = detail(); d.reviews = reviews;
    const html = renderItem(project, d, "PAVI", diff);
    expect([what, html.includes("Approved by you")]).toEqual([what, approved]);
    expect([what, html.includes("Approve revision")]).toEqual([what, !approved]);
  }
  // A stale approval is named as not standing, not shown as current.
  const d = detail(); d.reviews = [review({ head: other })];
  expect(ownerState(d, true, NOW).approval.text).toBe("Not given at this revision; your earlier review was of another revision or other criteria");
});

it("criterion 2: approval, independent review, CLI permission and acceptance are labelled apart, with one next move", () => {
  const d = detail(); d.reviews = [review({})];
  const html = header(renderItem(project, d, "PAVI", diff));
  for (const label of ["Your approval", "Independent review", "Command-line permission", "Acceptance"]) expect(html).toContain(`<dt>${label}</dt>`);
  expect(html.match(/class="next-action"/g)).toHaveLength(1);
  // The owner's approval does not stand in for the independent review.
  const s = ownerState(d, true, NOW);
  expect(s.approval.tone).toBe("go");
  expect(s.independent.text).toBe("Required and not yet given; your approval does not count as it");
  expect(s.acceptance.text).toBe("Not ready: 1 blocker");
  expect(s.next.kind).toBe("waiting");
  expect(html).not.toContain("Accept revision");
});

it("criterion 2: the state matrix covers blockers, unavailable diffs and the terminal states", () => {
  type Row = [string, (d: Detail) => void, boolean, Partial<Record<"independent" | "acceptance", string>>, "next" | "waiting" | "complete", RegExp];
  const rows: Row[] = [
    ["waiting for review", () => {}, true, { independent: "Required and not yet given; your approval does not count as it", acceptance: "Not ready: 1 blocker" }, "waiting", /^Waiting for an independent review: ask one with the landing command below\. If no reviewer qualifies, the override below is the way on\.$/],
    ["ready to accept", (d) => { d.reviews = [review({ by: "claude-code/opus-5.5" })]; d.gate = { ready: true, needsAssessor: false, blockers: [], outOfScope: [] }; }, true, { independent: "Approved by claude-code/opus-5.5", acceptance: "Ready to accept" }, "next", /^Accept the revision\.$/],
    ["overridden", (d) => { d.item.reviewOverride = { head, by: "pavi", reason: "none qualifies", at: time }; d.gate = { ready: true, needsAssessor: false, blockers: [], outOfScope: [] }; }, true, { independent: "Overridden by you, 2026-10-10 17:41 UTC: not a review", acceptance: "Ready to accept" }, "next", /^Accept the revision\.$/],
    ["failing check", (d) => { d.evidence[0].passed = false; d.gate = { ready: false, needsAssessor: true, blockers: ["`npm test` failed when observed", "Protected"], outOfScope: [] }; }, true, { acceptance: "Not ready: 2 blockers" }, "waiting", /^Waiting: The task owner must fix the failing checks/],
    ["diff unavailable", () => {}, false, { acceptance: "Unavailable until the changes shown match the recorded revision" }, "next", /^Reload this task/],
    ["secret pending", (d) => { d.item.secretScan = head; }, true, {}, "waiting", /^Waiting for the secret scan/],
    ["blocked", (d) => { d.item.state = "blocked"; d.item.blocked = { by: "pavi", at: time, reason: "waiting on design", from: "submitted" }; }, true, { acceptance: "Not possible while the task is blocked" }, "next", /^Unblock the task/],
    ["accepted", (d) => { d.item.state = "accepted"; d.item.acceptedHead = head; }, true, { acceptance: "Accepted at aaaaaaaa; not yet merged" }, "next", /^Run the merge command/],
    ["merged", (d) => { d.item.state = "merged"; d.item.acceptedHead = head; }, true, { acceptance: "Merged at aaaaaaaa" }, "complete", /^Complete: the revision is merged/],
    ["closed", (d) => { d.item.state = "abandoned"; }, true, { acceptance: "Closed without merging" }, "complete", /^Complete: the task was closed/],
    ["integrated part", (d) => { d.item.state = "integrated"; d.item.plan = "t9"; d.reviews = [review({ by: "claude-code/opus-5.5" })]; d.gate = { ready: false, needsAssessor: false, blockers: ["state is integrated, not submitted"], outOfScope: [] }; }, true, { independent: "Approved by claude-code/opus-5.5", acceptance: "Integrated into t9 at aaaaaaaa; lands with the plan" }, "waiting", /^Waiting for t9 to land: this part is submitted and integrated into the plan's branch/],
    ["working", (d) => { d.item.state = "claimed"; d.gate = { ready: false, needsAssessor: false, blockers: ["state is claimed, not submitted"], outOfScope: [] }; }, true, { acceptance: "Not submitted yet" }, "waiting", /^Waiting: The task owner is preparing the work/],
  ];
  for (const [what, set, visible, expected, kind, next] of rows) {
    const d = detail(); set(d);
    const s = ownerState(d, visible, NOW);
    for (const [key, text] of Object.entries(expected)) expect([what, key, s[key as "independent" | "acceptance"].text]).toEqual([what, key, text]);
    expect([what, s.next.kind]).toEqual([what, kind]);
    expect(s.next.text, what).toMatch(next);
    // Every state draws the four rows and exactly one next line.
    const html = header(renderItem(project, d, "PAVI", visible ? diff : "unavailable"));
    expect(html.match(/<dt>/g), what).toHaveLength(4);
    expect(html.match(/class="next-action"/g), what).toHaveLength(1);
  }
});

it("criterion 3: the override is a native disclosure with a marker that turns, apart from its submit buttons", () => {
  const html = renderItem(project, detail(), "PAVI", diff);
  const start = html.indexOf('<details class="override-disclosure">');
  expect(start).toBeGreaterThan(-1);
  const box = html.slice(start, html.indexOf("</details>", start));
  // The summary is the details' first child, so the browser's own toggle
  // (pointer, Enter and Space) opens it; nothing else is scripted.
  expect(box.startsWith('<details class="override-disclosure"><summary>')).toBe(true);
  const summary = box.slice(box.indexOf("<summary>"), box.indexOf("</summary>"));
  // The summary holds no control at all and no form: opening it submits nothing.
  expect(summary).not.toMatch(/<button|<form|<input|<a\b|type="submit"|tabindex|onclick|role=/);
  // Every submit button lies after the summary, inside one of its two forms.
  const body = box.slice(box.indexOf("</summary>"));
  expect(body.match(/<button/g)).toHaveLength(2);
  expect(body.match(/<form /g)).toHaveLength(2);
  expect(html).not.toContain("<script");
  expect(summary).toContain('<span class="disclosure-marker" aria-hidden="true"></span>Accept without an independent review');
  expect(summary).toContain('<span class="when-closed">show the override and command-line permission</span><span class="when-open">hide</span>');
  // The override-and-accept stays its own explicit button, as does the permission.
  expect(box).toContain('action="/ui/example/t1/override"');
  expect(box).toContain("<button>Override the review and accept</button>");
  expect(box).toContain("<button>Allow an override from the command line</button>");
  // Its stylesheet rules are checked in test/layout.test.ts, which reads the
  // file. Pointer, keyboard and Safari behaviour is checked by the
  // orchestrator after deploy (test/owner-state-smoke.md).
});

it("criterion 4: the override asks why the owner is overriding, and still requires a bounded reason", () => {
  const html = renderItem(project, detail(), "PAVI", diff);
  expect(html).toContain('<label>Why are you overriding the independent review?<textarea name="note" required rows="3" maxlength="500"></textarea></label>');
  expect(html).not.toContain("Why is no independent review possible?");
});

it("criterion 5: the CLI permission reads active with revision and zoned expiry, expired, consumed or invalidated", () => {
  setTimeZone("America/New_York");
  const until = "2026-10-10T18:10:00Z";
  const allowed = event(1, "override.allowed", { head, until, factor: "access" });
  const states: [string, (d: Detail) => void, string, string][] = [
    ["none", () => {}, "none", "Not given"],
    ["active", (d) => { d.item.overrideConfirmation = { head, by: "pavi", at: time, until, factor: "access" }; d.events = [allowed]; }, "active", "Active for revision aaaaaaaa until 2026-10-10 14:10 EDT, for one override"],
    ["expired", (d) => { d.item.overrideConfirmation = { head, by: "pavi", at: time, until: "2026-10-10T17:56:00Z", factor: "access" }; }, "expired", "Expired 2026-10-10 13:56 EDT, unused"],
    ["invalidated", (d) => { d.item.overrideConfirmation = { head: other, by: "pavi", at: time, until, factor: "access" }; }, "invalidated", "Invalidated: given for revision cccccccc, and the revision has changed since"],
    ["consumed", (d) => { d.item.state = "accepted"; d.item.acceptedHead = head; d.events = [event(2, "review.overridden", { head, confirmed: "command line" }, "2026-10-10T17:58:00Z"), allowed]; }, "consumed", "Consumed by the command-line override at aaaaaaaa, 2026-10-10 13:58 EDT; it allows nothing more"],
    // As the Ledger leaves it: a page override clears the confirmation too.
    // Its expiry is still ahead, and it is never said to have expired.
    ["cleared by a page override", (d) => { d.item.state = "accepted"; d.item.acceptedHead = head; d.item.reviewOverride = { head, by: "pavi", reason: "none qualifies", at: "2026-10-10T17:52:00Z" }; d.events = [event(2, "review.overridden", { head, confirmed: "page", factor: "access" }, "2026-10-10T17:52:00Z"), allowed]; }, "invalidated", "Invalidated by your override on this page at aaaaaaaa, 2026-10-10 13:52 EDT; it was never used"],
    ["given and not yet expired, though cleared", (d) => { d.events = [allowed]; }, "invalidated", "Invalidated: no longer on record, so it allows nothing"],
    ["expired by its time", (d) => { d.events = [event(1, "override.allowed", { head, until: "2026-10-10T17:56:00Z", factor: "access" })]; }, "expired", "Expired 2026-10-10 13:56 EDT, unused"],
    ["used at an earlier revision", (d) => { d.item.head = other; d.events = [event(2, "review.overridden", { head, confirmed: "command line" }), allowed]; }, "none", "Not given"],
    ["forbidden", (d) => { d.policy = { ...d.policy, noOverride: true }; }, "forbidden", "Forbidden: this project refuses every override"],
    ["active, then noOverride", (d) => { d.item.overrideConfirmation = { head, by: "pavi", at: time, until, factor: "access" }; d.events = [allowed]; d.policy = { ...d.policy, noOverride: true }; }, "forbidden", "Prohibited by policy: given for revision aaaaaaaa until 2026-10-10 14:10 EDT, but this project now refuses every override, so it allows nothing"],
    ["no factor", (d) => { d.ownerFactor = null; }, "unconfirmable", "Unavailable: this server takes no owner confirmation"],
  ];
  for (const [what, set, status, text] of states) {
    const d = detail(); set(d);
    const p = ownerState(d, true, NOW).permission;
    expect([what, p.status, p.text]).toEqual([what, status, text]);
  }
  // Granting it is said not to approve, override or accept anything.
  expect(renderItem(project, detail(), "PAVI", diff)).toContain("Allowing it approves, overrides and accepts nothing by itself.");
});

// The drawing alone; test/owner-forms.spec.ts drives the real handlers to it.
it("criterion 6 (drawing): a refused submission is said beside its form, keeps the reason, never the secret, and claims no success", () => {
  const secretDetail = () => ({ ...detail(), ownerFactor: "secret" as const });
  // A refused override: the disclosure reopens, the reason is kept, the secret field is empty.
  const d = secretDetail(); d.formError = { verb: "override", message: "t1 has moved: the revision shown is not the one recorded.", note: "No <other> family is available" };
  const html = renderItem(project, d, "PAVI", diff);
  expect(html).toContain('<details class="override-disclosure" open>');
  expect(html).toContain('<textarea name="note" required rows="3" maxlength="500">No &lt;other&gt; family is available</textarea>');
  expect(html).toContain('<button aria-describedby="error-override">Override the review and accept</button><p class="error form-error" role="alert" id="error-override">t1 has moved: the revision shown is not the one recorded. Nothing was recorded from this attempt. <a href="/p/example/t1">Reload this task</a>');
  for (const field of html.match(/<input[^>]*name="confirmation"[^>]*>/g) ?? []) expect(field).not.toContain("value=");
  expect(html.match(/name="confirmation"/g)).toHaveLength(2);
  expect(html).not.toContain("Approved by you");
  // A refused permission is said beside its own button, and grants nothing on the page.
  const allow = secretDetail(); allow.formError = { verb: "allow-override", message: "needs the confirmation secret, which was not this server's." };
  const allowHtml = renderItem(project, allow, "PAVI", diff);
  expect(allowHtml).toContain('<button aria-describedby="error-allow-override">Allow an override from the command line</button><p class="error form-error" role="alert" id="error-allow-override">');
  expect(ownerState(allow, true, NOW).permission.status).toBe("none");
  // A refused approval (a stale head or criteria) leaves Approve in place with its error, and no claim of approval.
  const stale = detail(); stale.formError = { verb: "approve", message: "the criteria have changed since this page was drawn." };
  const staleHtml = renderItem(project, stale, "PAVI", diff);
  expect(staleHtml).toContain('<button aria-describedby="error-approve">Approve revision</button><p class="error form-error" role="alert" id="error-approve">The criteria have changed since this page was drawn.');
  expect(staleHtml).not.toContain("Approved by you");
  // A refused request for changes keeps its note.
  const reject = detail(); reject.formError = { verb: "reject", message: "refused", note: "tighten the copy" };
  expect(renderItem(project, reject, "PAVI", diff)).toContain('<details class="request-changes" open><summary>Request changes</summary>');
  expect(renderItem(project, reject, "PAVI", diff)).toContain(">tighten the copy</textarea>");
  // Without a refusal no error is drawn.
  expect(renderItem(project, detail(), "PAVI", diff)).not.toContain('role="alert"');
});

it("criterion 2: the independent review row credits the approval the gate counts, never an earlier same-family one", () => {
  // The contributor is codex/gpt-6 (openai). An earlier approval from the
  // same family does not qualify; a later one from another family does.
  const d = detail();
  d.reviews = [
    review({ by: "codex/gpt-6-astra", at: "2026-10-10T17:00:00Z" }),
    review({ by: "claude-code/opus-5.5", at: "2026-10-10T17:30:00Z" }),
  ];
  d.gate = { ready: true, needsAssessor: false, blockers: [], outOfScope: [] };
  expect(ownerState(d, true, NOW).independent.text).toBe("Approved by claude-code/opus-5.5");
  // Order does not decide it: the qualifying approval is named when it came first too.
  d.reviews = [
    review({ by: "claude-code/opus-5.5", at: "2026-10-10T17:00:00Z" }),
    review({ by: "codex/gpt-6-astra", at: "2026-10-10T17:30:00Z" }),
  ];
  expect(ownerState(d, true, NOW).independent.text).toBe("Approved by claude-code/opus-5.5");
  // A same-family approval alone, an unproved one, a tier one or one of
  // another head is never credited as the independent review.
  for (const r of [
    review({ by: "codex/gpt-6-astra" }),
    review({ by: "claude-code/opus-5.5", proved: false }),
    review({ by: "claude-code/opus-5.5", tier: true }),
    review({ by: "claude-code/opus-5.5", head: other }),
  ]) {
    const e = detail(); e.reviews = [r];
    e.gate = { ready: false, needsAssessor: false, blockers: [], outOfScope: [] };
    expect(ownerState(e, true, NOW).independent.text, JSON.stringify(r)).not.toMatch(/^Approved by/);
  }
});
