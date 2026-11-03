import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catchUp, landingStartsAtAcceptedHead } from '../cli/catch-up.mjs';

function fixture(overrides = {}) {
  const calls = [];
  const io = {
    project: { path: '/checkout', branch: 'main' }, builder: 'codex/test', reviewer: 'other/test', accept: ['Works'],
    inspect: async () => ({ head: 'head', baseline: 'base', branch: 'main', clean: true, descendant: true }),
    create: async () => { calls.push('create'); return { id: 't1' }; },
    claim: async () => { calls.push('claim'); return '/workspace'; },
    carry: async () => calls.push('carry'),
    finish: async () => calls.push('checks'),
    land: async () => { calls.push('land'); return true; },
    pause: async () => {}, print: () => {}, ...overrides,
  };
  return { io, calls };
}
test('carries direct commits through checks and landing in one invocation', async () => {
  const { io, calls } = fixture();
  assert.equal(await catchUp(io), 't1');
  assert.deepEqual(calls, ['create', 'claim', 'carry', 'checks', 'land']);
});
test('waits for review before declaring completion', async () => {
  let attempts = 0;
  const lines = [];
  const { io } = fixture({ land: async () => ++attempts === 2, print: line => lines.push(line) });
  await catchUp(io);
  assert.equal(attempts, 2);
  assert.equal(lines.length, 1);
});
for (const [label, overrides] of [
  ['missing criteria', { accept: [] }], ['same reviewer', { reviewer: 'codex/test' }],
  ['partial history', { project: { path: '/checkout', fresh: true } }],
  ...[{ clean: false }, { descendant: false }, { head: 'base' }, { branch: 'other' }].map(state => ['unsafe checkout ' + JSON.stringify(state), { inspect: async () => ({ head: 'head', baseline: 'base', branch: 'main', clean: true, descendant: true, ...state }) }]),
]) test(`refuses ${label} before creating a task`, async () => {
  const { io, calls } = fixture(overrides);
  await assert.rejects(catchUp(io));
  assert.deepEqual(calls, []);
});
for (const step of ['create', 'claim', 'carry', 'finish', 'land']) test(`a crash at ${step} leaves completion unset`, async () => {
  const lines = [];
  const { io } = fixture({ [step]: async () => { throw Error('crash'); }, print: line => lines.push(line) });
  await assert.rejects(catchUp(io), /crash/);
  assert.deepEqual(lines, []);
});
test('only the exact accepted head may start ahead of the baseline', () => {
  assert.equal(landingStartsAtAcceptedHead('head', 'head'), true);
  assert.equal(landingStartsAtAcceptedHead('extra', 'head'), false);
  assert.equal(landingStartsAtAcceptedHead('unrelated', 'head'), false);
});

test('a crash while waiting for review leaves completion unset', async () => {
  const lines = [];
  const { io, calls } = fixture({
    land: async () => { calls.push('land'); return false; },
    pause: async () => { throw Error('crash while waiting'); },
    print: line => lines.push(line),
  });
  await assert.rejects(catchUp(io), /crash while waiting/);
  assert.deepEqual(calls, ['create', 'claim', 'carry', 'checks', 'land']);
  assert.deepEqual(lines, []);
});
