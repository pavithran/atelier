import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HANDLERS, parseArgs } from './atelier.mjs';
import eventsCommand, { bound, collectEvents, filterOf } from './commands/events.mjs';
import { commandUsage, helpText } from '../src/usage.ts';

// A ledger of `total` events, served newest first in pages of `size`, as the route does.
const ledger = (total, size) => {
  const all = Array.from({ length: total }, (_, i) => ({ seq: i + 1, kind: i % 2 ? 'item.merged' : 'item.pushed', at: new Date(Date.UTC(2026, 9, 1 + (i % 28))).toISOString(), data: {} }));
  const calls = [];
  const read = async (before) => {
    calls.push(before);
    const page = all.filter((e) => before === undefined || e.seq < before).reverse().slice(0, size);
    return { events: page, next: page.length === size ? page.at(-1).seq : null };
  };
  return { all, calls, read };
};

test('events registers its handler, flags and help', () => {
  assert.equal(HANDLERS.get('events'), eventsCommand);
  assert.deepEqual(parseArgs(['events', '--kind', 'a', '--kind', 'b']).multi.kind, ['a', 'b']);
  assert.match(helpText(), /events \[--from DATE\] \[--to DATE\] \[--kind K\]\.\.\./);
  assert.match(commandUsage('events'), /--kind K/);
});

test('events pages through more than one page and returns every event oldest first', async () => {
  const { all, calls, read } = ledger(1234, 500);
  const got = await collectEvents(read);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls, [undefined, 735, 235]);
  assert.deepEqual(got.map((e) => e.seq), all.map((e) => e.seq));
});

test('events ends at an exact multiple of the page size and on a ledger of one page', async () => {
  assert.equal((await collectEvents(ledger(1000, 500).read)).length, 1000);
  assert.equal((await collectEvents(ledger(3, 500).read)).length, 3);
  assert.deepEqual(await collectEvents(ledger(0, 500).read), []);
});

test('events filters by kind and by date, a bare --to date covering that day', async () => {
  const { read } = ledger(200, 50);
  const merged = await collectEvents(read, filterOf({ kinds: ['item.merged'] }));
  assert.equal(merged.length, 100);
  assert.ok(merged.every((e) => e.kind === 'item.merged'));
  const day = await collectEvents(read, filterOf({ from: bound('2026-10-05', 'from', false), to: bound('2026-10-05', 'to', true), kinds: [] }));
  assert.ok(day.length > 0 && day.every((e) => e.at.startsWith('2026-10-05')));
});
