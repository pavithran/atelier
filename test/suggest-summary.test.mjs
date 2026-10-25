import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/models/suggest.ts';
import { suggestReviewer } from '../src/review/suggest.ts';
import { cleanEntry } from '../src/models/pool.ts';
import { reviewerRecords } from '../src/models/suggestion-records.ts';

const entry = (id, harness = 'codex') => cleanEntry({ id, harness, where: 'home' }, 'owner', '2026-10-01');
const pool = [entry('gpt-6.1-sol'), entry('gpt-6-astra'), entry('fable-5', 'claude-code'), entry('gemini-3', 'gemini-cli')];
const item = { id: 't1', title: 'Improve formatting', scope: ['docs/**'], owner: 'gemini-cli/gemini-3', pushActors: [] };
const base = { item, project: 'p', pool, policy: { eligible: ['codex', 'claude-code', 'gemini-cli'], checks: [], protected: [] }, owner: 'owner' };
const NOW = new Date('2026-10-20T00:00:00Z');

// A long history: many tasks claimed, submitted, rejected and merged by the
// pool's models, each with a note long enough to make the events heavy.
function history(tasks) {
  const events = [];
  const builders = ['codex/gpt-6.1-sol', 'claude-code/fable-5', 'codex/gpt-6-astra'];
  let seq = 0;
  for (let n = 0; n < tasks; n++) {
    const id = `t${n + 10}`, who = builders[n % builders.length];
    const at = '2026-10-10T00:00:00Z';
    const add = (kind, actor, data = {}) => events.push({ seq: ++seq, kind, actor, itemId: id, at, data: { ...data, note: 'x'.repeat(200) } });
    add('item.claimed', who);
    add('item.submitted', who, { head: 'a'.repeat(40) });
    if (n % 4 === 0) add('review.rejected', 'codex/gpt-6-astra', { head: 'a'.repeat(40), note: 'no' });
    add('item.merged', 'owner');
  }
  return events;
}
const runs = [1, 2, 3].map((d) => ({ actor: 'codex/gpt-6.1-sol', role: 'build', outcome: 'stalled', at: `2026-10-1${d}T00:00:00Z`, project: 'p', item: 't10', detail: '', runner: 'home:test' }));

test('the summary yields the same reviewer and reasons as the events', () => {
  const sources = [{ project: 'p', events: history(300) }];
  const whole = suggestReviewer({ ...base, sources, runs }, [], NOW);
  const summarized = suggestReviewer({ ...base, summary: summarize({ sources, runs }, 'owner', NOW) }, [], NOW);
  assert.deepEqual(summarized, whole);
});

test('a large event history sends the ledger under 1 MiB', async () => {
  const events = history(40000);
  assert.ok(JSON.stringify(events).length > 20 * 1024 * 1024);
  const index = { projects: async () => [{ name: 'p' }], runs: async () => runs };
  const ledger = () => ({ events: async (_id, limit, before) => events.filter((e) => before === undefined || e.seq < before).slice(-limit).reverse() });
  const records = await reviewerRecords(index, ledger, 'owner', NOW);
  assert.ok(JSON.stringify({ ...records, project: 'p' }).length < 1024 * 1024);
  assert.equal(records.sources, undefined);
  assert.equal(records.summary.models['gpt-6.1-sol'] !== undefined, true);
});
