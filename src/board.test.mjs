import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { taskStage, projectBoard, boardText } from './board.ts';
import { renderBoard } from './board-html.ts';
import { itemFields, gate } from './rules.ts';

const item = (extra = {}) => ({ id: 't1', title: 'Build this', state: 'open', owner: null, scope: [], fork: null, base: null, head: null, acceptedHead: null, createdAt: '2026-10-01', updatedAt: '2026-10-01', lastPushAt: null, ...extra });
const queued = { job: 'build', actor: 'codex/gpt-6-astra' };

test('every stage and competing higher-priority fact', () => {
  for (const state of ['merged', 'abandoned', 'integrated']) {
    assert.equal(taskStage(item({ state, blocked: {}, owner: 'holder', dispatch: queued }), { ready: true, landing: true, planBlocked: true }), state);
  }
  for (const extra of [{ state: 'blocked' }, { blocked: {} }]) assert.equal(taskStage(item({ ...extra, owner: 'holder', dispatch: queued }), { ready: true, landing: true }), 'blocked');
  assert.equal(taskStage(item(), { planBlocked: true, landing: true, ready: true }), 'blocked');
  assert.equal(taskStage(item({ state: 'submitted', owner: 'holder', dispatch: queued }), { landing: true, ready: true }), 'landing');
  for (const state of ['submitted', 'accepted']) {
    assert.equal(taskStage(item({ state, owner: 'holder', dispatch: queued }), { ready: true }), 'ready');
    assert.equal(taskStage(item({ state, owner: 'holder', dispatch: queued }), { ready: false }), state);
    assert.equal(taskStage(item({ state })), state);
  }
  assert.equal(taskStage(item({ owner: 'holder', dispatch: queued }), { ready: true }), 'building');
  assert.equal(taskStage(item({ state: 'claimed' })), 'building');
  assert.equal(taskStage(item({ dispatch: queued })), 'queued');
  assert.equal(taskStage(item(), { ready: true }), 'open');
});

test('failing landing gates cannot mark a submitted task ready', () => {
  const submitted = item({ state: 'submitted', head: 'abc' });
  const g = gate(submitted, { checks: ['npm test'], protected: [] }, [], []);
  assert.equal(g.ready, false);
  assert.equal(taskStage(submitted, g), 'submitted');
});

test('all membership including legacy tasks, empty areas and zero merged is deterministic and immutable', () => {
  const snapshot = { areas: [{ id: 'a2', name: 'Zebra', purpose: 'Z work' }, { id: 'a1', name: 'Alpha', purpose: 'A work' }], items: [item({ id: 't2', area: 'a1', kind: 'part', plan: 't1', state: 'integrated' }), item({ kind: 'plan', area: 'a1' }), item({ id: 't3', area: 'removed' }), item({ id: 't4', state: 'merged' })], facts: {} };
  const before = structuredClone(snapshot);
  const groups = projectBoard(snapshot);
  assert.deepEqual(groups.map(g => [g.name, g.tasks.length, g.merged]), [['Alpha', 2, 0], ['Zebra', 0, 0], ['Unsorted', 2, 1]]);
  assert.deepEqual(groups.flatMap(g => g.tasks.map(t => t.item.id)), ['t1', 't2', 't3', 't4']);
  assert.deepEqual(projectBoard({ ...snapshot, areas: [...snapshot.areas].reverse(), items: [...snapshot.items].reverse() }), groups);
  assert.deepEqual(snapshot, before);
  assert.equal(projectBoard({ areas: [], items: [], facts: {} })[0].merged, 0);
  assert.deepEqual(groups[0].tasks.map(t => t.kind), ['plan', 'part']);
});

test('web and board share membership, stages, holder, purposes and counts; links are keyboard accessible', () => {
  const snapshot = { areas: [{ id: 'a1', name: 'Core', purpose: 'Make things work' }], items: ['open', 'claimed', 'submitted', 'accepted', 'blocked', 'integrated', 'merged', 'abandoned'].map((state, i) => item({ id: `t${i + 1}`, title: `Title ${i}`, state, owner: 'codex/gpt-6-astra', area: i % 2 ? 'a1' : null })), facts: {} };
  const html = renderBoard('demo', snapshot), text = boardText(snapshot);
  for (const group of projectBoard(snapshot)) {
    for (const output of [html, text]) { assert.ok(output.includes(group.purpose)); assert.ok(output.includes(`${group.merged}/${group.tasks.length} merged`)); }
    for (const task of group.tasks) {
      assert.ok(text.includes(`[${task.stage}]  holder: ${task.holder}`));
      assert.ok(html.includes(`data-stage="${task.stage}"`));
      assert.equal(html.split(`href="/p/demo/${task.item.id}"`).length, 2);
      assert.ok(html.includes(task.item.title));
      assert.ok(text.includes(task.item.title));
    }
  }
  assert.doesNotMatch(html, /tabindex="-1"|onclick=/);
  assert.match(html, /aria-labelledby="area-0"/);
});

test('narrow layout stacks fields and wraps long titles and holders; focus remains visible', () => {
  const css = readFileSync(new URL('./layout.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 700px\)\s*\{\s*\.area-board \.task-list li \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.area-task-title[^}]*overflow-wrap: break-word/);
  assert.match(css, /\.area-holder[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.area-task-title:focus-visible[^}]*outline: 2px/);
  const html = renderBoard('a/b', { areas: [], items: [item({ title: '<script>bad</script>' })], facts: {} });
  assert.match(html, /href="\/p\/a%2Fb\/t1"/);
  assert.doesNotMatch(html, /<script>/);
});

test('area fields accept IDs or explicit null and reject names and blank IDs', () => {
  assert.deepEqual(itemFields({ area: 'a12' }), { area: 'a12' });
  assert.deepEqual(itemFields({ area: null }), { area: null });
  assert.deepEqual(itemFields({}), {});
  for (const area of ['', 'Core', 'a0', 'a01', true, 3]) assert.throws(() => itemFields({ area }), /bad_area/);
});
