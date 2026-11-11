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

// 950 events, one a minute from 2026-10-01T00:00Z, seq 1..1000, in pages of 100 (newest first).
const minute = (n) => Date.UTC(2026, 9, 1) + (n - 1) * 60_000;
const timed = () => {
  const all = Array.from({ length: 950 }, (_, i) => ({ seq: i + 1, kind: 'item.pushed', at: new Date(minute(i + 1)).toISOString(), data: {} }));
  const calls = [];
  const read = async (before) => {
    calls.push(before);
    const page = all.filter((e) => before === undefined || e.seq < before).reverse().slice(0, 100);
    return { events: page, next: page.length === 100 ? page.at(-1).seq : null };
  };
  return { all, calls, read };
};
const pagesRead = async (from) => {
  const { calls, read } = timed();
  const got = await collectEvents(read, filterOf({ from, kinds: [] }), from);
  const { read: readAll } = timed();
  const full = await collectEvents(readAll, filterOf({ from, kinds: [] }));
  assert.deepEqual(got.map((e) => e.seq), full.map((e) => e.seq));
  return calls.length;
};

test('events --from reads one page when the time is inside page 1', async () => {
  assert.equal(await pagesRead(minute(900)), 1);
});

test('events --from reads three pages when the time is inside page 3', async () => {
  assert.equal(await pagesRead(minute(700)), 3);
});

test('events --from older than every event reads every page', async () => {
  assert.equal(await pagesRead(minute(1) - 1), 10);
});

test('events without --from reads every page', async () => {
  const { calls, read } = timed();
  await collectEvents(read, filterOf({ kinds: [] }), undefined);
  assert.equal(calls.length, 10);
});

test('events --from on an empty record reads one page', async () => {
  const { calls, read } = ledger(0, 500);
  assert.deepEqual(await collectEvents(read, filterOf({ from: 5, kinds: [] }), 5), []);
  assert.equal(calls.length, 1);
});

test('events --from equal to a page\'s oldest event reads the next page and keeps events at that time', async () => {
  // Page 1 holds seq 851..950; its oldest is seq 851. T = that time is not strictly older, so page 2 is read.
  assert.equal(await pagesRead(minute(851)), 2);
  const { read } = timed();
  const got = await collectEvents(read, filterOf({ from: minute(851), kinds: [] }), minute(851));
  assert.equal(got.length, 100);
  // Events sharing T across the page boundary are both kept.
  const same = (n) => ({ seq: n, kind: 'k', at: new Date(minute(5)).toISOString(), data: {} });
  const pages = [{ events: [same(3), same(2)], next: 2 }, { events: [same(1)], next: null }];
  let i = 0;
  const out = await collectEvents(async () => pages[i++], filterOf({ from: minute(5), kinds: [] }), minute(5));
  assert.deepEqual(out.map((e) => e.seq), [1, 2, 3]);
});
