import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { GAVE_UP } from '../src/dispatch/rules.ts';
import { stuckReport, reportLimits } from '../src/stuck/report.ts';
import { FLAGS, HANDLERS, parseArgs } from './atelier.mjs';
import stuckCommand from './commands/stuck.mjs';
import { commandUsage, helpText } from '../src/usage.ts';

test('stuck registers its extracted handler, flags and help', () => {
  assert.equal(HANDLERS.get('stuck'), stuckCommand);
  const flags = ['no-push-hours', 'unanswered-hours', 'core-hold-minutes', 'runner-poll-minutes', 'review-answer-hours'];
  for (const flag of flags) {
    assert.equal(FLAGS.stuck[flag], false);
    assert.equal(parseArgs(['stuck', `--${flag}`, '3'])[flag], '3');
    assert.ok(commandUsage('stuck').includes(`--${flag} N`));
  }
  assert.equal(parseArgs(['stuck', '--json']).json, true);
  assert.match(helpText(), /stuck \[--project P\]/);
  assert.match(commandUsage('stuck'), /failed reads are unavailable/);
});
const now = new Date('2026-10-10T12:00:00Z');
const at = ms => new Date(+now - ms).toISOString();
const item = (over = {}) => ({ id: 't1', title: 'Task', scope: ['src/**'], state: 'claimed', owner: 'codex/model', head: 'a'.repeat(40), base: null, workspace: null, acceptedHead: null, createdAt: at(0), updatedAt: at(0), lastPushAt: null, ...over });
const snapshot = (over = {}) => ({ items: [item()], events: [], lease: null, reviews: [], coreFiles: ['src/**'], ...over });
const event = (seq, kind, ms, data = {}, itemId = 't1') => ({ seq, kind, at: at(ms), data, itemId, actor: 'codex/model' });
const report = (s = snapshot(), offers = [], runs = [], active = [], unavailable = []) => stuckReport('demo', 'https://example.org', now, reportLimits(), s, offers, runs, active, unavailable);
const idleSnapshot = () => snapshot({ items: [item({ state: 'open', owner: null, dispatch: { to: 'home', agent: 'codex', model: 'gpt-6', by: 'owner', at: at(0), note: '' } })] });
const idleAgents = [{ agent: 'codex', models: ['gpt-6'] }];
const kinds = r => r.entries.filter(e => e.kind !== 'task-idle').map(e => e.kind);
test('limits reject zero, negative, nonfinite; age equals a limit is not stuck', () => {
  for (const n of [0, -1, NaN, Infinity, '', 'oops']) assert.throws(() => reportLimits({ noPushHours: n }));
  assert.equal(reportLimits({ noPushHours: '3' }).noPushHours, 3);
  assert.deepEqual(kinds(report(snapshot({ events: [event(1, 'item.claimed', 6*3600000)] }))), []);
  assert.deepEqual(kinds(report(snapshot({ events: [event(1, 'item.claimed', 6*3600000+1)] }))), ['task']);
});
test('a live lease held for an open task is no orphan; one whose task is closed or gone is, until it lapses', () => {
  const lease = { item: 't1', holder: 'owner', at: at(1000) };
  assert.deepEqual(kinds(report(snapshot({ lease }))), []);
  const closed = snapshot({ lease, items: [item({ state: 'merged' })] });
  assert.deepEqual(kinds(report(closed)), ['orphan-lease']);
  assert.match(report(closed).entries[0].recovery, /land t1 --release-lease/);
  lease.at = at(900000);
  assert.deepEqual(kinds(report(closed)), []);
  assert.deepEqual(kinds(report(snapshot({ items: [], lease: { ...lease, at: at(1) } }))), ['orphan-lease']);
});
test('idle runner includes timestamp coarsening and active jobs; unavailable jobs do not prove idle', () => {
  const offers = [{ runner: 'home:studio', kind: 'home', agents: idleAgents, at: at(360000) }];
  assert.deepEqual(kinds(report(idleSnapshot(), offers)), []);
  offers[0].at = at(360001);
  assert.deepEqual(kinds(report(idleSnapshot(), offers)), ['idle-runner']);
  assert.deepEqual(kinds(report(idleSnapshot(), offers, [], ['home:studio'])), []);
  assert.deepEqual(kinds(report(idleSnapshot(), offers, [], null)), []);
});
test('current claimed reviews; old heads, closed and blocked tasks excluded', () => {
  const r = { id: 1, item: 't1', head: item().head, claimedBy: 'reviewer/model', claimedAt: at(3600000), runner: 'home:review' };
  const s = snapshot({ reviews: [r] });
  assert.deepEqual(kinds(report(s)), []);
  r.claimedAt = at(3600001);
  assert.deepEqual(kinds(report(s)), ['review']);
  r.head = 'b'.repeat(40);
  assert.deepEqual(kinds(report(s)), []);
  r.head = item().head;
  for (const state of ['blocked','merged','abandoned']) assert.deepEqual(kinds(report({ ...s, items: [item({ state })] })), []);
});
const LIMIT = 3600000;
// A claimed review as the ledger keeps it: claimedAt is rewritten on each
// renewal, and the review.claimed event naming request id marks its start.
const claimedReview = (id, startMs, renewedMs) => ({
  review: { id, item: 't1', head: item().head, claimedBy: 'reviewer/model', claimedAt: at(renewedMs), runner: 'home:review' },
  event: event(id, 'review.claimed', startMs, { head: item().head, runner: 'home:review', request: id }),
});
test('a claim renewed every 30 s for 3 h is listed, aged from its claim', () => {
  const start = 3 * 3600000;
  const c = claimedReview(1, start, start);
  // Renew every 30 s, as the runner does, up to the observation time.
  for (let ms = start - 30000; ms >= 0; ms -= 30000) c.review.claimedAt = at(ms);
  assert.equal(c.review.claimedAt, at(0));
  const r = report(snapshot({ reviews: [c.review], events: [c.event] }));
  assert.deepEqual(kinds(r), ['review']);
  assert.equal(r.entries[0].since, at(start));
  assert.equal(r.entries[0].ageMs, start);
});
test('a fresh review claim is not listed', () => {
  const c = claimedReview(1, 60000, 30000);
  assert.deepEqual(kinds(report(snapshot({ reviews: [c.review], events: [c.event] }))), []);
});
test('a renewed review claim is listed only beyond the answer limit, from its claim', () => {
  const exact = claimedReview(1, LIMIT, 0);
  assert.deepEqual(kinds(report(snapshot({ reviews: [exact.review], events: [exact.event] }))), []);
  const over = claimedReview(1, LIMIT + 1, 0);
  assert.deepEqual(kinds(report(snapshot({ reviews: [over.review], events: [over.event] }))), ['review']);
});
test('a re-claim after expiry ages from the new claim, not the expired one', () => {
  // Request 1 was claimed 4 h ago and expired; its replacement, request 2,
  // was claimed 10 minutes ago and is renewed.
  const old = claimedReview(1, 4 * 3600000, 3 * 3600000);
  const fresh = claimedReview(2, 600000, 0);
  const events = [fresh.event, event(5, 'review.expired', 3 * 3600000 - 300000, { request: 1 }), old.event];
  assert.deepEqual(kinds(report(snapshot({ reviews: [fresh.review], events }))), []);
  const later = claimedReview(2, LIMIT + 1, 0);
  const r = report(snapshot({ reviews: [later.review], events: [later.event, old.event] }));
  assert.deepEqual(kinds(r), ['review']);
  assert.equal(r.entries[0].since, at(LIMIT + 1));
});
test('core hold ages from current handoff or later push, not dispatch creation', () => {
  const waiting = item({ id: 't2', state: 'open', owner: null, dispatch: { to: 'home', agent: null, model: null, by: 'owner', at: at(99999999), note: '' } });
  const s = snapshot({ items: [item(), waiting], events: [event(1, 'item.claimed', 8*3600000), event(2, 'item.handoff', 30*60000)] });
  assert.deepEqual(kinds(report(s)), []);
  s.events[1].at = at(30*60000+1);
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

test('the stuck report needs the owner token', async () => {
  const { agentRoute } = await import('../src/tokens.ts');
  assert.equal(agentRoute('GET', ['projects', 'demo', 'stuck']), false);
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
  const s = snapshot({ items: [item({ state: 'submitted', createdAt: at(5000) })], openReviewItems: ['t1'] });
  assert.deepEqual(kinds(report(s, [], [run])), ['runner-give-up']);
  assert.deepEqual(kinds(report(s, [], [run], ['home:review'])), []);
  s.events.push(event(1, 'review.claimed', 500));
  assert.deepEqual(kinds(report(s, [], [run])), []);
  s.events = [];
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
  assert.match(report(s).entries[0].recovery, /check in with the holder/);
});


test('core holds have an independent limit and recover the held dispatch without rebuilding the blocker', () => {
  // A submitted blocker holds only while its landing holds the lease (t473).
  const waiting = item({ id: 't2', state: 'open', owner: null, dispatch: { to: 'home', agent: null, model: null, by: 'owner', at: at(99999999), note: '' } });
  const s = snapshot({ items: [item({ state: 'submitted' }), waiting], events: [event(1, 'item.claimed', 1800001)], lease: { item: 't1', holder: 'owner', at: at(1000) } });
  const entry = report(s).entries[0];
  assert.equal(entry.kind, 'core-hold');
  assert.equal(entry.recovery, 'Land the blocker with atelier land t1 --project demo; or, if the overlap is harmless, atelier dispatch t2 --to home --note \'\' --overlap-ok --project demo');
  assert.equal(entry.evidence, 'https://example.org/p/demo/t1');
  assert.deepEqual(stuckReport('demo', 'https://example.org', now, reportLimits({ coreHoldMinutes: 31, noPushHours: 0.01 }), s, [], [], []).entries, []);
  s.events.push(event(2, 'item.handoff', 1800000));
  assert.deepEqual(kinds(report(s)), []);
  s.events[1].at = at(1800001);
  assert.deepEqual(kinds(report(s)), ['core-hold']);
  s.items[0].state = 'accepted';
  const accepted = report(s).entries[0];
  assert.equal(accepted.recovery, 'Land the blocker with atelier merge t1 --project demo; or, if the overlap is harmless, atelier dispatch t2 --to home --note \'\' --overlap-ok --project demo');
  assert.equal(accepted.since, s.events[1].at);
  assert.equal(accepted.evidence, entry.evidence);
  assert.match(commandUsage('stuck'), /merge if already accepted/);
  s.items[0].state = 'merged';
  s.lease = null; // the landing ended with the merge
  assert.deepEqual(kinds(report(s)), []);
});
test('each task rule preserves its suggestion without dispatching or releasing the task', () => {
  const s = snapshot({ events: [event(1, 'item.claimed', 21600001)] });
  assert.match(report(s).entries[0].recovery, /check in with the holder \(codex\/model\).*show t1 --reviews/);
  s.items[0].state = 'submitted';
  s.events = [event(1, 'review.rejected', 86400001)];
  assert.match(report(s).entries[0].recovery, /check in with the holder/);
  s.events = [event(1, 'evidence.observed', 2, { passed: false, head: 'a' }), event(2, 'evidence.observed', 1, { passed: false, head: 'b' })];
  assert.match(report(s).entries[0].recovery, /hand off:.*handoff t1 --to H\/M/);
  assert.doesNotMatch(report(s).entries[0].recovery, /dispatch|release/);
});
test('core-hold override preserves routing and literal notes; a merge-main dispatch is never held', () => {
  const mm = { to: 'cloud', agent: 'codex', model: 'gpt-6-astra', note: '', by: 'owner', at: at(99999999), job: 'merge-main', head: 'b'.repeat(40) };
  const held = snapshot({ items: [item({ state: 'submitted' }), item({ id: 't2', state: 'open', owner: null, dispatch: mm })], events: [event(1, 'item.claimed', 1800001)], lease: { item: 't1', holder: 'owner', at: at(1000) } });
  assert.deepEqual(report(held).entries.filter((e) => e.kind === 'core-hold'), []);
  for (const job of [undefined]) {
    const dispatch = { to: 'cloud', agent: 'codex', model: 'gpt-6-astra', note: 'Owner\'s "note": $HOME `literal`\nnext line', by: 'owner', at: at(99999999), ...(job ? { job, head: 'b'.repeat(40) } : {}) };
    const waiting = item({ id: 't2', state: 'open', owner: null, dispatch });
    const s = snapshot({ items: [item({ state: 'submitted' }), waiting], events: [event(1, 'item.claimed', 1800001)], lease: { item: 't1', holder: 'owner', at: at(1000) } });
    const recovery = report(s).entries[0].recovery.split('if the overlap is harmless, atelier ')[1];
    // Only printf runs: exercise shell tokenisation of the displayed arguments.
    const argv = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${recovery}`], { encoding: 'utf8' }).split('\0').slice(0, -1);
    const args = parseArgs(argv);
    assert.equal(args.to, dispatch.to);
    assert.equal(args.agent, dispatch.agent);
    assert.equal(args.model, dispatch.model);
    assert.equal(args.note, dispatch.note);
    assert.equal(args.job, job);
    assert.equal(args.head, dispatch.head);
    assert.equal(args['overlap-ok'], true);
    assert.equal(args.project, 'demo');
  }
});
test('idle runner recovery names the observed runner', () => {
  const r = report(idleSnapshot(), [{ runner: 'home:studio', kind: 'home', agents: idleAgents, at: at(360001) }]);
  assert.equal(r.entries[0].recovery, 'atelier runner --name "home:studio" --once');
});
test('new limits default to thirty minutes and reject invalid values', () => {
  for (const key of ['coreHoldMinutes']) {
    assert.equal(reportLimits()[key], 30);
    for (const value of [0, -1, NaN, Infinity, '', 'invalid']) assert.throws(() => reportLimits({ [key]: value }));
    assert.equal(reportLimits({ [key]: '2.5' })[key], 2.5);
  }
});

// gpt-6-astra's review of t537 at bbc55485: every recovery the stuck report
// prints names the project as one shell word, so a name with a space or a
// metacharacter selects that project and runs nothing.
test('stuck recoveries quote the project as one shell word', () => {
  const waiting = item({ id: 't2', state: 'open', owner: null, dispatch: { to: 'home', agent: null, model: null, by: 'owner', at: at(99999999), note: '' } });
  const s = snapshot({ items: [item({ state: 'submitted' }), waiting], events: [event(1, 'item.claimed', 1800001)], lease: { item: 't1', holder: 'owner', at: at(1000) } });
  for (const name of ['my project', 'a;exit 3', "it's $(printf x)"]) {
    const entry = stuckReport(name, 'https://example.org', now, reportLimits(), s, [], [], []).entries.find((e) => e.kind === 'core-hold');
    const land = entry.recovery.replace(/^Land the blocker with atelier /, '').replace(/; or, .*$/, '');
    const words = execFileSync('/bin/sh', ['-c', `set -- ${land}; printf '%s\\n' "$@"`], { encoding: 'utf8' }).trimEnd().split('\n');
    assert.deepEqual(words, ['land', 't1', '--project', name]);
  }
});
// 2026-10-12: a runner that gave up on t396 kept its claim, and its core-file
// hold stopped fifteen dispatches for three hours with no word in this report
// (t584). The runner now pushes, then releases with a note that starts GAVE_UP.
test('a runner that pushed and then gave a task up is named with its reason, and holds nothing', () => {
  const waiting = item({ id: 't2', state: 'open', owner: null, dispatch: { to: 'home', agent: null, model: null, by: 'owner', at: at(99999999), note: '' } });
  const gone = item({ state: 'open', owner: null, dispatch: waiting.dispatch });
  const s = snapshot({ items: [gone, waiting], events: [
    event(1, 'item.claimed', 9000000, { runner: 'home:studio' }), event(2, 'push.observed', 8000000),
    event(3, 'item.released', 7000000, { note: `${GAVE_UP}merge failed twice (its commits are pushed)` })] });
  const r = report(s);
  assert.deepEqual(kinds(r), ['runner-give-up']);
  assert.equal(r.entries[0].subject, 't1');
  assert.match(r.entries[0].reason, /^runner home:studio gave it up: merge failed twice/);
  assert.match(r.entries[0].recovery, /dispatch t1/);
  // The same release without the runner's word, after a push, is an ordinary release.
  s.events[2].data = { note: 'handing back' };
  assert.deepEqual(kinds(report(s)), []);
});
test('a give-up recorded after an ordinary release keeps the runner\'s reason in the report', () => {
  const gone = item({ state: 'open', owner: null });
  const s = snapshot({ items: [gone], events: [
    event(1, 'item.claimed', 9000000, { runner: 'home:studio' }), event(2, 'item.released', 8000000, { note: 'harness made no new commit' }),
    event(3, 'item.gave_up', 7000000, { runner: 'home:studio', kind: 'failures', note: 'harness made no new commit' })] });
  const r = report(s);
  assert.deepEqual(kinds(r), ['runner-give-up']);
  assert.match(r.entries[0].reason, /^runner home:studio gave it up: harness made no new commit/);
});

test('a run report from before the task was created is ignored', () => {
  const run = { actor: 'reviewer/model', role: 'review', outcome: 'stalled', project: 'demo', item: 't1', detail: '', runner: 'home:review', at: at(10000) };
  const make = createdAt => snapshot({ items: [item({ state: 'submitted', createdAt })], openReviewItems: ['t1'] });
  assert.deepEqual(kinds(report(make(at(20000)), [], [run])), ['runner-give-up']);
  assert.deepEqual(kinds(report(make(at(5000)), [], [run])), []);
});
test('an idle runner last polled over 48 hours ago is dropped; 47 hours still lists', () => {
  const offer = ms => [{ runner: 'home:studio', kind: 'home', agents: idleAgents, at: at(ms) }];
  assert.deepEqual(kinds(report(idleSnapshot(), offer(47 * 3600000))), ['idle-runner']);
  assert.deepEqual(kinds(report(idleSnapshot(), offer(48 * 3600000 + 1))), []);
});

// An expired one-shot offer is not stuck when no queued job needs it.
test('idle runners need a matching waiting job', () => {
  const offer = { runner: 'home:one-shot', kind: 'home', agents: [{ agent: 'codex', models: ['gpt-6'] }], at: at(360001) };
  assert.deepEqual(kinds(report(snapshot(), [offer])), []);
  const waiting = item({ state: 'open', owner: null, dispatch: { to: 'home', agent: 'codex', model: 'gpt-6', by: 'owner', at: at(0), note: '' } });
  assert.deepEqual(kinds(report(snapshot({ items: [waiting] }), [offer])), ['idle-runner']);
  assert.deepEqual(kinds(report(snapshot({ items: [waiting] }), [{ ...offer, kind: 'cloud' }])), []);
  assert.deepEqual(kinds(report(snapshot({ items: [waiting] }), [{ ...offer, jobs: ['review'] }])), []);
  assert.deepEqual(kinds(report(snapshot({ items: [waiting] }), [{ ...offer, projects: ['elsewhere'] }])), []);
  const request = { id: 1, item: 't1', head: item().head, dispatch: { ...waiting.dispatch, job: 'review' } };
  assert.deepEqual(kinds(report(snapshot({ items: [item({ state: 'submitted' })], openRequests: [request] }), [{ ...offer, jobs: ['review'] }])), ['idle-runner']);
});

test('held work without movement is reported only past an hour, with holder and last event', () => {
  for (const state of ['claimed', 'submitted']) {
    for (const ms of [30*60000+1, 3600000, 3600001]) {
      const s = snapshot({ items: [item({ state })], events: [event(1, 'item.claimed', 7200000), event(2, 'item.noted', ms)] });
      const r = report(s);
      const entries = r.entries.filter(e => e.kind === 'task-idle');
      assert.equal(entries.length, ms > 3600000 ? 1 : 0);
      if (entries.length) {
        assert.equal(r.project, 'demo');
        assert.equal(entries[0].subject, 't1');
        assert.match(entries[0].reason, /codex\/model.*60 minutes.*item.noted/);
        assert.equal(entries[0].since, at(ms));
        assert.deepEqual(report({ ...s, events: [...s.events].reverse() }), r);
      }
    }
  }
  assert.deepEqual(report(snapshot({ items: [item({ state: 'blocked' })], events: [event(1, 'item.claimed', 7200000)] })).entries, []);
});
test('review without a verdict is reported only past an hour despite renewals', () => {
  for (const ms of [3600000, 3600001]) {
    const c = claimedReview(1, ms, 0);
    const entries = report(snapshot({ reviews: [c.review], events: [c.event] })).entries.filter(e => e.kind === 'review');
    assert.equal(entries.length, ms > 3600000 ? 1 : 0);
    if (entries.length) assert.match(entries[0].reason, /reviewer\/model.*60 minutes.*review.claimed/);
  }
});
