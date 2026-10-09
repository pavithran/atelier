import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestBuilder, suggestReviewer, stalledBuilder } from '../src/models/suggest.ts';
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
test('sensitive work and two rejections require frontier builders', () => {
  for (const title of ['Fix security checks', 'Repair concurrency', 'Change gate rules']) {
    assert.notEqual(suggestBuilder({ ...input, item: { ...item, title } }).actor, item.owner);
  }
  const sources = [{ project: 'p', events: [event(1, 'review.rejected', 'claude-code/fable-5', { head: 'a' }), event(2, 'review.rejected', 'claude-code/fable-5', { head: 'b' })] }];
  assert.match(suggestBuilder({ ...input, sources }).reasons[0], /Two rejections/);
  assert.throws(() => suggestBuilder({ ...input, sources, pool: [pool[0]] }), /frontier/);
  assert.equal(suggestBuilder({ ...input, sources: sources.map(s => ({ ...s, project: 'other' })), pool: [pool[0]] }).actor, item.owner);
});
test('two stalled builds latch exclusion through other failures until success', () => {
  const records = { sources: [], runs: [run(1), run(2), run(3, 'refused')] };
  assert.equal(stalledBuilder(pool[0], records), true);
  assert.notEqual(suggestBuilder({ ...input, ...records }).actor, item.owner);
  assert.equal(stalledBuilder(pool[0], { sources: [], runs: [run(1), run(2, 'refused'), run(3)] }), false);
  assert.equal(stalledBuilder(pool[0], { sources: [], runs: [run(1), run(2, 'stalled', 'review')] }), false);
  records.sources.push({ project: 'p', events: [event(4, 'item.submitted', item.owner)] });
  assert.equal(stalledBuilder(pool[0], records), false);
});
test('review excludes every contributor company and refuses unknown or exhausted companies', () => {
  const result = suggestReviewer({ ...input, item: { ...item, pushActors: ['claude-code/fable-5'] } });
  assert.equal(result.actor, 'gemini-cli/gemini-3');
  assert.throws(() => suggestReviewer({ ...input, item: { ...item, pushActors: ['claude-code/fable-5', 'gemini-cli/gemini-3'] } }), /no reviewer/);
  assert.throws(() => suggestReviewer({ ...input, item: { ...item, owner: 'codex/unknown-model' } }), /not recognised/);
});
test('sensitive reviews cannot fall back outside frontier', () => {
  const sensitive = { ...item, title: 'Security gate changes' };
  assert.equal(suggestReviewer({ ...input, item: sensitive }).actor, 'claude-code/fable-5');
  assert.throws(() => suggestReviewer({ ...input, item: { ...sensitive, pushActors: ['claude-code/fable-5'] } }), /frontier reviewer/);
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

test('stall history spans projects, harnesses and registered aliases', () => {
  const aliased = { ...pool[0], aliases: ['sol-alias'] };
  const runs = [run(1), { ...run(2), actor: 'opencode/sol-alias', project: 'another-project' }];
  assert.equal(stalledBuilder(aliased, { sources: [], runs }), true);
  assert.throws(() => suggestBuilder({ ...input, pool: [aliased], runs }), /two consecutive stalled builds/);
});
test('a successful build clears the latch but a fresh pair stalls it again', () => {
  const sources = [{ project: 'p', events: [event(3, 'item.submitted', item.owner)] }];
  assert.equal(stalledBuilder(pool[0], { sources, runs: [run(1), run(2), run(4)] }), false);
  assert.equal(stalledBuilder(pool[0], { sources, runs: [run(5), run(2), run(4), run(1)] }), true);
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

// Scope is src/** and cli/**; run these alongside npm test with
// node --test cli/suggest.test.mjs.
test('measured protected changes require frontier even without title keywords', () => {
  assert.throws(() => suggestReviewer({ ...input, frontierRequired: true, pool: [pool[0], pool[3]] }), /frontier reviewer/);
});
