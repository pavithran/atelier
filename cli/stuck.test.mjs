import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stuckReport, reportLimits } from '../src/stuck/report.ts';
const now = new Date('2026-10-10T12:00:00Z');
const at = ms => new Date(+now - ms).toISOString();
const item = (over = {}) => ({ id: 't1', title: 'Task', scope: ['src/**'], state: 'claimed', owner: 'codex/model', head: 'a'.repeat(40), base: null, fork: null, acceptedHead: null, createdAt: at(0), updatedAt: at(0), lastPushAt: null, ...over });
const snapshot = (over = {}) => ({ items: [item()], events: [], lease: null, workflows: [], reviews: [], coreFiles: ['src/**'], ...over });
const event = (seq, kind, ms, data = {}, itemId = 't1') => ({ seq, kind, at: at(ms), data, itemId, actor: 'codex/model' });
const report = (s = snapshot(), offers = [], runs = [], active = [], unavailable = []) => stuckReport('demo', 'https://example.org', now, reportLimits(), s, offers, runs, active, unavailable);
const kinds = r => r.entries.map(e => e.kind);
test('limits reject zero, negative, nonfinite; age equals a limit is not stuck', () => {
  for (const n of [0, -1, NaN, Infinity, '', 'oops']) assert.throws(() => reportLimits({ noPushHours: n }));
  assert.equal(reportLimits({ noPushHours: '3' }).noPushHours, 3);
  assert.deepEqual(kinds(report(snapshot({ events: [event(1, 'item.claimed', 6*3600000)] }))), []);
  assert.deepEqual(kinds(report(snapshot({ events: [event(1, 'item.claimed', 6*3600000+1)] }))), ['task']);
});
test('lease waits use stage time; unknown is not an orphan; CLI holder and expiry are recognised', () => {
  const record = { instance: 'wf', at: at(7200000), stage: 'lease', stageAt: at(1800000), round: 0 };
  const lease = { item: 't1', holder: 'owner', at: at(1000) };
  assert.deepEqual(kinds(report(snapshot({ lease }))), []);
  const s = snapshot({ lease, workflows: [{ item: 't1', record, status: 'unknown' }] });
  assert.deepEqual(kinds(report(s)), []);
  record.stageAt = at(1800001);
  assert.deepEqual(kinds(report(s)), ['lease-wait']);
  s.workflows[0].status = 'errored';
  record.stageAt = at(500);
  assert.deepEqual(kinds(report(s)), ['orphan-lease']);
  assert.match(report(s).entries[0].recovery, /land t1 --release-lease/);
  lease.at = at(900000);
  assert.deepEqual(kinds(report(s)), []);
  assert.deepEqual(kinds(report(snapshot({ items: [], lease: { ...lease, at: at(1) } }))), ['orphan-lease']);
});
test('idle runner includes timestamp coarsening and active jobs; unavailable jobs do not prove idle', () => {
  const offers = [{ runner: 'home:studio', kind: 'home', agents: [], at: at(360000) }];
  assert.deepEqual(kinds(report(snapshot(), offers)), []);
  offers[0].at = at(360001);
  assert.deepEqual(kinds(report(snapshot(), offers)), ['idle-runner']);
  assert.deepEqual(kinds(report(snapshot(), offers, [], ['home:studio'])), []);
  assert.deepEqual(kinds(report(snapshot(), offers, [], null)), []);
});
test('current claimed reviews use renewed claims; old heads, closed and blocked tasks excluded', () => {
  const r = { id: 1, item: 't1', head: item().head, claimedBy: 'reviewer/model', claimedAt: at(7200000), runner: 'home:review' };
  const s = snapshot({ reviews: [r] });
  assert.deepEqual(kinds(report(s)), []);
  r.claimedAt = at(7200001);
  assert.deepEqual(kinds(report(s)), ['review']);
  r.head = 'b'.repeat(40);
  assert.deepEqual(kinds(report(s)), []);
  r.head = item().head;
  for (const state of ['blocked','merged','abandoned']) assert.deepEqual(kinds(report({ ...s, items: [item({ state })] })), []);
});
test('core hold ages from current handoff or later push, not dispatch creation', () => {
  const waiting = item({ id: 't2', state: 'open', owner: null, dispatch: { to: 'home', agent: null, model: null, by: 'owner', at: at(99999999), note: '' } });
  const s = snapshot({ items: [item(), waiting], events: [event(1, 'item.claimed', 8*3600000), event(2, 'item.handoff', 6*3600000)] });
  assert.deepEqual(kinds(report(s)), []);
  s.events[1].at = at(6*3600000+1);
  assert.ok(kinds(report(s)).includes('core-hold'));
  s.events.push(event(3, 'push.observed', 1));
  assert.deepEqual(kinds(report(s)), []);
});
test('give-ups deduplicate and resolve on retries; checks use observed commands in rolling day', () => {
  const s = snapshot({ items: [item({ state: 'open', owner: null })], events: [event(1, 'item.claimed', 10000, { runner: 'home:studio' }), event(2, 'item.released', 8000)] });
  assert.deepEqual(kinds(report(s)), ['runner-give-up']);
  const run = { actor: 'codex/model', role: 'build', outcome: 'stalled', project: 'demo', item: 't1', detail: '', runner: 'home:studio', at: at(7000) };
  assert.equal(report(s, [], [run, run]).entries.length, 1);
  s.events.push(event(3, 'item.claimed', 6000));
  assert.deepEqual(kinds(report(s, [], [run])), []);
  const checks = snapshot({ events: [event(1,'evidence.observed',86400000,{ passed:false,claim:'old' }),event(2,'evidence.reported',1,{passed:false,claim:'reported'}),event(3,'evidence.observed',100,{passed:false,claim:'npm test',outputTail:'individual test failed'}),event(4,'evidence.observed',100,{passed:false,claim:'npm run typecheck'})] });
  const r = report(checks);
  assert.equal(r.failedChecksLastDay.length, 2);
  assert.match(r.failedChecksLastDay[0].reason, /npm test/);
  assert.doesNotMatch(JSON.stringify(r), /individual test/);
  assert.deepEqual(report({ ...checks, events: [...checks.events].reverse() }), r);
});
test('unavailable evidence remains explicit with a fixed observation time', () => {
  const r = report(null, null, null, null, ['ledger failed', 'ledger failed']);
  assert.equal(r.observedAt, now.toISOString());
  assert.deepEqual(r.unavailable, ['ledger failed']);
  assert.equal(r.complete, false);
  assert.equal(r.failedChecksLastDay, null);
  assert.deepEqual(r.entries, []);
});

test('old terminal Workflow does not prove a newer CLI lease orphaned; owner token required', async () => {
  const { agentRoute } = await import('../src/tokens.ts');
  assert.equal(agentRoute('GET', ['projects', 'demo', 'stuck']), false);
  const s = snapshot({ lease: { item: 't1', holder: 'owner', at: at(1000) }, workflows: [{ item: 't1', record: { instance: 'old', at: at(90000), stage: 'done', stageAt: at(60000), round: 0 }, status: 'complete' }] });
  assert.deepEqual(kinds(report(s)), []);
});

test('existing consecutive-failure and unanswered-rejection rules survive, with strict boundaries', () => {
  const s = snapshot({ items: [item({ state: 'submitted' })], events: [event(1, 'evidence.observed', 1000, { passed: false, head: 'a', claim: 'npm test' }), event(2, 'evidence.observed', 1000, { passed: false, head: 'b', claim: 'npm test' })] });
  assert.ok(report(s).entries.some(e => e.reason.includes('different heads')));
  s.events.push(event(3, 'evidence.observed', 500, { passed: true, head: 'b' }));
  assert.deepEqual(kinds(report(s)), []);
  s.events = [event(1, 'review.rejected', 86400000)];
  assert.deepEqual(kinds(report(s)), []);
  s.events[0].at = at(86400001);
  assert.deepEqual(kinds(report(s)), ['task']);
  s.events.push(event(2, 'push.observed', 1000));
  assert.deepEqual(kinds(report(s)), []);
});
test('withdrawn and superseded review give-ups disappear; active jobs suppress stale run failures', () => {
  const run = { actor: 'reviewer/model', role: 'review', outcome: 'stalled', project: 'demo', item: 't1', detail: '', runner: 'home:review', at: at(1000) };
  const s = snapshot({ items: [item({ state: 'submitted' })], openReviewItems: ['t1'] });
  assert.deepEqual(kinds(report(s, [], [run])), ['runner-give-up']);
  assert.deepEqual(kinds(report(s, [], [run], ['home:review'])), []);
  s.openReviewItems = [];
  assert.deepEqual(kinds(report(s, [], [run])), []);
});

test('distinct current review requests for a task are preserved, duplicate rows collapse', () => {
  const r = { id: 1, item: 't1', head: item().head, claimedBy: 'reviewer/model', claimedAt: at(7200001), runner: 'home:review' };
  const s = snapshot({ reviews: [r, r, { ...r, id: 2, claimedBy: 'tier/model' }] });
  assert.equal(report(s).entries.length, 2);
  assert.match(report(s).entries[0].recovery, /review-release t1/);
});
test('plan parts receive their documented retry recovery instead of ordinary dispatch', () => {
  const s = snapshot({ items: [item({ kind: 'part', plan: 't9', state: 'open', owner: null })], events: [event(1, 'item.claimed', 10000, { runner: 'home:studio' }), event(2, 'item.released', 1000)] });
  assert.match(report(s).entries[0].recovery, /plan retry t1/);
  s.items[0].state = 'claimed';
  s.events = [event(1, 'item.claimed', 21600001)];
  assert.match(report(s).entries[0].recovery, /release t1.*plan retry t1/);
});
