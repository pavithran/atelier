import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { taskStage, projectBoard, boardText } from './board.ts';
import { renderBoard } from './board-html.ts';
import { gate } from './rules.ts';

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

test('all tasks in creation order, plans and parts included, are deterministic and immutable', () => {
  const snapshot = { items: [item({ id: 't2', area: 'a1', kind: 'part', plan: 't1', state: 'integrated' }), item({ kind: 'plan', area: 'a1' }), item({ id: 't3', area: 'removed' }), item({ id: 't4', state: 'merged' })], facts: {} };
  const before = structuredClone(snapshot);
  const board = projectBoard(snapshot);
  assert.deepEqual(board.tasks.map(t => t.item.id), ['t1', 't2', 't3', 't4']);
  assert.deepEqual(board.tasks.map(t => t.kind), ['plan', 'part', 'task', 'task']);
  assert.equal(board.merged, 1);
  assert.deepEqual(projectBoard({ ...snapshot, items: [...snapshot.items].reverse() }), board);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(projectBoard({ items: [], facts: {} }), { tasks: [], merged: 0 });
  assert.equal(boardText({ items: [], facts: {} }), 'Tasks: 0/0 merged\n  No tasks.');
});

test('web and board share membership, stages, holder and counts; links are keyboard accessible', () => {
  const snapshot = { areas: [{ id: 'a1', name: 'Core', purpose: 'Make things work' }], items: ['open', 'claimed', 'submitted', 'accepted', 'blocked', 'integrated', 'merged', 'abandoned'].map((state, i) => item({ id: `t${i + 1}`, title: `Title ${i}`, state, owner: 'codex/gpt-6-astra', area: i % 2 ? 'a1' : null })), facts: {} };
  const html = renderBoard('demo', snapshot), text = boardText(snapshot), board = projectBoard(snapshot);
  for (const output of [html, text]) assert.ok(output.includes(`${board.merged}/${board.tasks.length} merged`));
  for (const task of board.tasks) {
    assert.ok(text.includes(`[${task.stage}]  holder: ${task.holder}`));
    assert.ok(html.includes(`data-stage="${task.stage}"`));
    assert.equal(html.split(`href="/p/demo/${task.item.id}"`).length, 2);
    assert.ok(html.includes(task.item.title));
    assert.ok(text.includes(task.item.title));
  }
  assert.doesNotMatch(html, /tabindex="-1"|onclick=/);
  assert.match(html, /aria-labelledby="board-h"/);
  assert.doesNotMatch(html + text, /Core|Make things work|Unsorted/, 'a recorded area is not shown');
});

test('narrow layout stacks fields and wraps long titles and holders; focus remains visible', () => {
  const css = readFileSync(new URL('./layout.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 700px\)\s*\{\s*\.task-board \.task-list li \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.board-task-title[^}]*overflow-wrap: break-word/);
  assert.match(css, /\.board-holder[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.board-task-title:focus-visible[^}]*outline: 2px/);
  assert.doesNotMatch(css, /\.area-(board|task|holder|purpose)|\.task-area/);
  const html = renderBoard('a/b', { items: [item({ title: '<script>bad</script>' })], facts: {} });
  assert.match(html, /href="\/p\/a%2Fb\/t1"/);
  assert.doesNotMatch(html, /<script>/);
});
