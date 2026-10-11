import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaField } from './area-commands.ts';
import { args, areaCommand, boardCommand, fieldsArg, parseArgs } from '../cli/atelier.mjs';
import { boardText } from './board.ts';

test('new and edit parse --area, explicit clearing, omission and conflicts', () => {
  assert.deepEqual(areaField(parseArgs(['new', 'Title', '--area', 'a1']), 'new'), { area: 'a1' });
  assert.deepEqual(areaField(parseArgs(['edit', 't1', '--clear-area']), 'edit'), { area: null });
  assert.deepEqual(areaField(parseArgs(['edit', 't1']), 'edit'), {});
  assert.throws(() => areaField({ area: 'Core' }, 'new'), /area ID/);
  assert.throws(() => areaField({ area: 'a1', 'clear-area': true }, 'edit'), /alone/);
  assert.throws(() => areaField({ 'clear-area': true }, 'new'), /edit ID/);
});

test('area CLI sends stable IDs, preserves purpose on rename, removes, and board prints the shared view', async t => {
  const originalArgs = { ...args }, originalFetch = globalThis.fetch, originalLog = console.log;
  const oldServer = process.env.ATELIER_SERVER, oldToken = process.env.ATELIER_TOKEN;
  process.env.ATELIER_SERVER = 'https://area-test.invalid';
  process.env.ATELIER_TOKEN = 'test-only';
  const calls = [], output = [];
  const area = { id: 'a1', name: 'Core', purpose: 'Shared foundations' };
  const snapshot = { areas: [area], items: [], facts: {} };
  globalThis.fetch = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    calls.push({ path: new URL(url).pathname, method: options.method, body });
    const data = url.endsWith('/board') ? snapshot : options.method === 'GET' ? [area] : options.method === 'DELETE' ? { removed: 'a1' } : { ...area, ...body };
    return new Response(JSON.stringify(data));
  };
  console.log = s => output.push(s);
  t.after(() => {
    globalThis.fetch = originalFetch; console.log = originalLog;
    for (const key of Object.keys(args)) delete args[key]; Object.assign(args, originalArgs);
    if (oldServer === undefined) delete process.env.ATELIER_SERVER; else process.env.ATELIER_SERVER = oldServer;
    if (oldToken === undefined) delete process.env.ATELIER_TOKEN; else process.env.ATELIER_TOKEN = oldToken;
  });
  const setArgs = words => { for (const key of Object.keys(args)) delete args[key]; Object.assign(args, parseArgs([...words, '--project', 'demo'])); };
  setArgs(['new', 'Title', '--area', 'a1']); assert.deepEqual(fieldsArg('new'), { area: 'a1' });
  setArgs(['edit', 't1', '--clear-area']); assert.deepEqual(fieldsArg('edit'), { area: null });
  setArgs(['area', 'create', 'Core', '--purpose', 'Shared foundations']); await areaCommand();
  assert.deepEqual(calls.at(-1), { path: '/api/projects/demo/areas', method: 'POST', body: { name: 'Core', purpose: 'Shared foundations' } });
  setArgs(['area', 'rename', 'a1', 'Engine']); await areaCommand();
  assert.deepEqual(calls.at(-1), { path: '/api/projects/demo/areas/a1', method: 'POST', body: { name: 'Engine', purpose: 'Shared foundations' } });
  setArgs(['area', 'remove', 'a1']); await areaCommand();
  assert.equal(calls.at(-1).method, 'DELETE');
  assert.match(output.at(-1), /Unsorted/);
  setArgs(['board']); await boardCommand(); assert.equal(output.at(-1), boardText(snapshot));
  setArgs(['board', '--json']); await boardCommand(); assert.deepEqual(JSON.parse(output.at(-1)), snapshot);
});
