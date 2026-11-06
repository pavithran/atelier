import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as suggestModule from '../src/models/suggest.ts';
const { suggestBuilder } = suggestModule;
import { suggestReviewer } from '../src/review/suggest.ts';
import { cleanEntry } from '../src/models/pool.ts';
const entry = (id, harness = 'codex') => cleanEntry({ id, harness, where: 'home' }, 'owner', '2026-10-01');
const pool = [entry('gpt-6.1-sol'), entry('gpt-6-astra'), entry('fable-5', 'claude-code'), entry('gemini-3', 'gemini-cli')];
const item = { id: 't1', title: 'Improve formatting', scope: ['src/**'], owner: 'codex/gpt-6.1-sol', pushActors: [] };
const input = { item, project: 'p', pool, policy: { eligible: ['codex', 'claude-code', 'gemini-cli'], checks: [], protected: [] }, sources: [], runs: [] };
const event = (seq, kind, actor, data = {}) => ({ seq, kind, actor, data, itemId: 't1', at: `2026-10-0${seq}T00:00:00Z` });
const run = (day, outcome = 'stalled', role = 'build') => ({ actor: 'codex/gpt-6.1-sol', role, outcome, at: `2026-10-0${day}T00:00:00Z`, project: 'p', item: 't1', detail: '', runner: 'home:test' });

test('builder is drawn from pool and explains record ranking', () => {
  const result = suggestBuilder({ ...input, sources: [{ project: 'p', events: [event(1, 'item.claimed', item.owner), event(2, 'item.merged', 'owner')] }] });
  assert.equal(result.actor, item.owner);
  assert.match(result.reasons.join(' '), /1 merge/);
});
test('builder and reviewer suggestions name the latest note that bears on their task', () => {
  const notes = [
    { at: '2026-10-01T09:00:00Z', by: 'owner', text: 'Stalls on long refactors.' },
    { at: '2026-10-02T09:00:00Z', by: 'owner', text: 'Only t9 is affected.', item: 't9', project: 'p' },
  ];
  const noted = { ...pool[0], notes };
  const general = 'Latest note, 2026-10-01 by owner: Stalls on long refactors.';
  const forT9 = 'Latest note, 2026-10-02 by owner on p/t9: Only t9 is affected.';
  assert.ok(suggestBuilder({ ...input, pool: [noted] }).reasons.includes(general));
  assert.ok(suggestBuilder({ ...input, item: { ...item, id: 't9' }, pool: [noted] }).reasons.includes(forT9));
  const reviewer = { ...input, pool: [noted], item: { ...item, owner: 'gemini-cli/gemini-3', pushActors: ['claude-code/fable-5'] } };
  assert.equal(suggestReviewer(reviewer).actor, 'codex/gpt-6.1-sol');
  assert.ok(suggestReviewer(reviewer).reasons.includes(general));
  assert.ok(suggestReviewer({ ...reviewer, item: { ...reviewer.item, id: 't9' } }).reasons.includes(forT9));
  assert.ok(!suggestBuilder({ ...input, pool: [pool[0]] }).reasons.some((r) => r.startsWith('Latest note')));
});
test('a task note bears only on the project it names, even where another project has the same task id', () => {
  const notes = [
    { at: '2026-10-01T09:00:00Z', by: 'owner', text: 'Stalls on long refactors.' },
    { at: '2026-10-02T09:00:00Z', by: 'owner', text: 'Only alpha t1 is affected.', item: 't1', project: 'alpha' },
    { at: '2026-10-03T09:00:00Z', by: 'owner', text: 'Only beta t1 is affected.', item: 't1', project: 'beta' },
  ];
  const noted = { ...pool[0], notes };
  const reviewer = { ...input, pool: [noted], item: { ...item, owner: 'gemini-cli/gemini-3', pushActors: ['claude-code/fable-5'] } };
  const alpha = 'Latest note, 2026-10-02 by owner on alpha/t1: Only alpha t1 is affected.';
  const beta = 'Latest note, 2026-10-03 by owner on beta/t1: Only beta t1 is affected.';
  assert.ok(suggestBuilder({ ...input, project: 'alpha', pool: [noted] }).reasons.includes(alpha));
  assert.ok(suggestBuilder({ ...input, project: 'beta', pool: [noted] }).reasons.includes(beta));
  assert.ok(suggestReviewer({ ...reviewer, project: 'alpha' }).reasons.includes(alpha));
  assert.ok(suggestReviewer({ ...reviewer, project: 'beta' }).reasons.includes(beta));
  const gamma = 'Latest note, 2026-10-01 by owner: Stalls on long refactors.';
  assert.ok(suggestBuilder({ ...input, project: 'gamma', pool: [noted] }).reasons.includes(gamma));
  assert.ok(!suggestBuilder({ ...input, project: 'gamma', pool: [noted] }).reasons.join(' ').includes('t1'));
});
// G6 and G17: no keyword of the task's words, no count of rejections and no
// run of stalled builds narrows the builders; each was a judgment the model
// now makes, reading the reliability figures.
test('no keyword, rejection count or stall history narrows the builders', () => {
  const sources = [{ project: 'p', events: [event(1, 'item.claimed', item.owner), event(2, 'item.merged', 'owner')] }];
  for (const title of ['Fix security checks', 'Repair concurrency', 'Change gate rules']) {
    assert.equal(suggestBuilder({ ...input, sources, item: { ...item, title } }).actor, item.owner);
  }
  const rejected = [{ project: 'p', events: [event(1, 'review.rejected', 'claude-code/fable-5', { head: 'a' }), event(2, 'review.rejected', 'claude-code/fable-5', { head: 'b' })] }];
  assert.equal(suggestBuilder({ ...input, sources: rejected, pool: [pool[0]] }).actor, item.owner);
  assert.equal(suggestBuilder({ ...input, runs: [run(1), run(2), run(3)], pool: [pool[0]] }).actor, item.owner);
  assert.equal(suggestModule.stalledBuilder, undefined);
  assert.equal(suggestModule.sensitive, undefined);
});
test('review excludes every contributor company and refuses unknown or exhausted companies', () => {
  const result = suggestReviewer({ ...input, item: { ...item, pushActors: ['claude-code/fable-5'] } });
  assert.equal(result.actor, 'gemini-cli/gemini-3');
  assert.throws(() => suggestReviewer({ ...input, item: { ...item, pushActors: ['claude-code/fable-5', 'gemini-cli/gemini-3'] } }), /no reviewer/);
  assert.throws(() => suggestReviewer({ ...input, item: { ...item, owner: 'codex/unknown-model' } }), /not recognised/);
});
test("a task's words do not ask a frontier reviewer; a protected change does", () => {
  const sensitive = { ...item, title: 'Security gate changes' };
  assert.equal(suggestReviewer({ ...input, item: sensitive }).actor, suggestReviewer(input).actor);
  assert.equal(suggestReviewer({ ...input, frontierRequired: true }).actor, 'claude-code/fable-5');
});
test('finding verdict precision orders independent reviewers', () => {
  const events = Array.from({ length: 5 }, (_, i) => ({ ...event(i + 1, 'review.finding', 'owner', { by: 'gemini-cli/gemini-3', head: 'a', index: i, finding: { severity: 'blocking' }, verdict: 'confirmed' }), at: '2026-10-08T00:00:00Z' }));
  assert.equal(suggestReviewer({ ...input, sources: [{ project: 'p', events }] }, [], new Date('2026-10-09')).actor, 'gemini-cli/gemini-3');
});
test('constraints and refused providers fail closed', () => {
  assert.throws(() => suggestBuilder(input, { to: 'cloud' }), /No eligible/);
  assert.equal(suggestBuilder(input, { model: 'gpt-6.1-sol' }).actor, item.owner);
  assert.throws(() => suggestBuilder({ ...input, pool: [{ ...pool[0], status: { state: 'refused' } }] }), /provider refused/);
});

// A refused status never ages out on its own (the 2026-11-06 finding read 12
// days old), so the dispatch candidates stop counting one older than
// RECENT_MS (7 days) and say when the model was last checked instead.
test('a refused status older than seven days refuses nothing, and the candidates say when it was last checked', () => {
  const days = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
  const refusedAt = (at) => ({ ...pool[0], status: { state: 'refused', at, by: 'home:studio', detail: 'refused, served gpt-6-astra' } });
  // Fresh, it refuses in both readers, as before.
  assert.equal(suggestModule.builderCandidates({ ...input, pool: [refusedAt(days(1))] })[0].refusal, 'provider refused');
  assert.throws(() => suggestBuilder({ ...input, pool: [refusedAt(days(1))] }), /provider refused/);
  // Older than seven days, it refuses nothing: the candidate is eligible, and
  // its line and the suggestion's reasons say when it was last checked.
  const at = days(8);
  const [candidate] = suggestModule.builderCandidates({ ...input, pool: [refusedAt(at)] });
  assert.equal(candidate.refusal, null);
  assert.ok(candidate.line.includes(`Last checked ${at.slice(0, 10)}.`), candidate.line);
  const chosen = suggestBuilder({ ...input, pool: [refusedAt(at)] });
  assert.equal(chosen.actor, item.owner);
  assert.ok(chosen.reasons.includes(`Last checked ${at.slice(0, 10)}.`), chosen.reasons.join(' '));
  // A status with no date cannot be called old, so it still refuses.
  assert.equal(suggestModule.builderCandidates({ ...input, pool: [refusedAt(undefined)] })[0].refusal, 'provider refused');
});

// t394: under single-family mode the dispatch suggestion picks within the
// company, whatever the ranking, and says so; with none of the company's
// models in the pool it refuses rather than proposing another company's.
test('single-family mode keeps the suggested builder within the company', () => {
  // A merge ranks codex/gpt-6.1-sol first; the mode passes it over all the same.
  const sources = [{ project: 'p', events: [event(1, 'item.claimed', item.owner), event(2, 'item.merged', 'owner')] }];
  const single = { ...input, sources, policy: { ...input.policy, familyMode: { single: 'anthropic', by: 'owner', at: '2026-10-09T10:00:00Z' } } };
  assert.equal(suggestBuilder({ ...input, sources }).actor, item.owner);
  const pick = suggestBuilder(single);
  assert.equal(pick.actor, 'claude-code/fable-5');
  assert.match(pick.reasons[0], /single-family mode \(anthropic\), so only anthropic's models are considered/);
  assert.ok(pick.reasons.some((r) => r === "Passed over codex/gpt-6.1-sol: not one of anthropic's models (single-family mode)."));
  assert.ok(pick.reasons.every((r) => !/Passed over claude-code/.test(r)));
  assert.throws(() => suggestBuilder({ ...single, pool: pool.filter((m) => m.harness !== 'claude-code') }), /No eligible builder in the pool.*gemini-cli\/gemini-3: not one of anthropic's models \(single-family mode\)/);
  assert.equal(suggestBuilder({ ...single, policy: { ...single.policy, familyMode: { single: null, by: 'owner', at: '2026-10-09T11:00:00Z' } } }).actor, item.owner);
});

test('record loading pages past 1000 events and fails on unreadable projects', async () => {
  const { suggestionRecords } = await import('../src/models/suggestion-records.ts');
  const index = { projects: async () => [{ name: 'p' }], runs: async (limit) => { assert.equal(limit, Number.MAX_SAFE_INTEGER); return [run(1)]; } };
  const page = Array.from({ length: 1000 }, (_, i) => ({ ...event(1, 'item.claimed', item.owner), seq: 1001 - i }));
  const calls = [];
  const records = await suggestionRecords(index, () => ({ events: async (_id, limit, before) => {
    calls.push({ limit, before });
    return before === undefined ? page : [event(1, 'item.submitted', item.owner)];
  } }));
  assert.equal(records.sources[0].events.length, 1001);
  assert.deepEqual(calls, [{ limit: 1000, before: undefined }, { limit: 1000, before: 2 }]);
  await assert.rejects(suggestionRecords(index, () => ({ events: async () => { throw new Error('unreadable'); } })), /unreadable/);
});

test('measured protected changes require frontier even without title keywords', () => {
  assert.throws(() => suggestReviewer({ ...input, frontierRequired: true, pool: [pool[0], pool[3]] }), /frontier reviewer/);
});

test('the reviewer is never of a company that contributed, whoever is first by record', () => {
  // gpt-6.1-sol has the best record, but codex built the task with it.
  const sources = [{ project: 'p', events: [event(1, 'item.claimed', item.owner), event(2, 'item.merged', 'owner')] }];
  const result = suggestReviewer({ ...input, sources, item: { ...item, pushActors: ['codex/gpt-6-astra'] } });
  assert.notEqual(result.actor.split('/')[0], 'codex');
  assert.match(result.reasons.join(' '), /another family|recorded outcomes/);
});
test('a re-review goes to the previous reviewer and a protected change to the review tier first, within the rules', () => {
  assert.equal(suggestReviewer({ ...input, previous: 'gemini-cli/gemini-3' }).actor, 'gemini-cli/gemini-3');
  assert.equal(suggestReviewer({ ...input, frontierRequired: true, tier: ['claude-code/fable-5'] }).actor, 'claude-code/fable-5');
  // A previous reviewer outside the frontier is not asked of sensitive work.
  assert.equal(suggestReviewer({ ...input, frontierRequired: true, previous: 'gemini-cli/gemini-3' }).actor, 'claude-code/fable-5');
});
