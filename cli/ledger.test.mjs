import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HANDLERS } from './atelier.mjs';
import ledgerCommand, { formatBookmark, formatDump, formatImport, formatRestore } from './commands/ledger.mjs';
import { collectDump, importDump, IMPORT_CHUNK_BYTES, manifestOf, parseDump } from './ledger-dump.mjs';
import { LEDGER_DUMP_FORMAT } from '../src/rules.ts';
import { commandUsage, helpText } from '../src/usage.ts';
import { requiredForCommand } from '../src/route-level.ts';

// atelier ledger (t342): the pages it reads and sends, and what it prints.
// The routes themselves are tested in test/ledger-way-back.spec.ts.

// A Ledger of `n` rows in one table, served `size` rows a page as the route does.
const served = (n, size, grow = false) => {
  const rows = Array.from({ length: n }, (_, i) => [i + 1, `row ${i + 1}`]);
  let reads = 0;
  const read = async (table, after) => {
    if (table === undefined) return { format: LEDGER_DUMP_FORMAT, project: 'demo', schemaVersion: 'abc', tables: [{ name: 'events', columns: [{ name: 'seq' }, { name: 'data' }], count: n + (grow && reads++ ? 1 : 0) }] };
    const page = rows.filter((r) => r[0] > after).slice(0, size);
    return { rows: page, next: page.length === size && page.at(-1)[0] < n ? page.at(-1)[0] : null, redacted: 0 };
  };
  return { rows, read };
};

test('ledger registers its handler, forms and capability', () => {
  assert.equal(HANDLERS.get('ledger'), ledgerCommand);
  assert.match(helpText(), /ledger bookmark \[--project P\] · ledger restore --bookmark ID/);
  assert.match(commandUsage('ledger'), /ledger import --file F/);
  assert.deepEqual(requiredForCommand('ledger', 'dump'), ['projects.ledger-backup.v1']);
});

test('a dump reads every page of every table and swaps each count for the rows', async () => {
  const { rows, read } = served(1234, 500);
  const dump = await collectDump(read);
  assert.deepEqual(dump.tables[0].rows, rows);
  assert.equal(dump.tables[0].count, undefined);
  assert.equal(dump.schemaVersion, 'abc');
  assert.deepEqual(manifestOf(dump).tables[0].count, 1234);
});

test('a dump fails when a table changed while it was read', async () => {
  await assert.rejects(collectDump(served(10, 3, true).read), /events changed while the dump read it; stop the runners/);
});

test('an import begins, sends each table in chunks under the limit, and finishes', async () => {
  const big = 'x'.repeat(400_000);
  const dump = { format: LEDGER_DUMP_FORMAT, project: 'demo', tables: [
    { name: 'events', columns: [{ name: 'seq' }, { name: 'data' }], rows: Array.from({ length: 12 }, (_, i) => [i + 1, big]) },
    { name: 'plans', columns: [{ name: 'seq' }], rows: [] },
  ] };
  const sent = [];
  const done = await importDump(dump, async (body) => {
    sent.push(body);
    if (body.step === 'begin') return { import: 'i1' };
    if (body.step === 'rows') return { inserted: body.rows.length };
    return { counts: { events: 12 }, registered: false };
  });
  assert.equal(sent[0].step, 'begin');
  assert.equal(sent[0].manifest.tables[0].rows, undefined);
  assert.equal(sent[0].manifest.tables[0].count, 12);
  const chunks = sent.filter((b) => b.step === 'rows');
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((b) => b.import === 'i1' && b.table === 'events' && JSON.stringify(b.rows).length <= IMPORT_CHUNK_BYTES + 100));
  assert.equal(chunks.reduce((n, b) => n + b.rows.length, 0), 12);
  assert.deepEqual(sent.at(-1), { step: 'finish', import: 'i1' });
  assert.deepEqual(done, { counts: { events: 12 }, registered: false });
});

test('a file that is not a dump is refused before anything is sent', () => {
  assert.throws(() => parseDump('not json', LEDGER_DUMP_FORMAT), /not JSON/);
  assert.throws(() => parseDump(JSON.stringify({ format: 'other', tables: [] }), LEDGER_DUMP_FORMAT), /not a Ledger dump/);
  assert.throws(() => parseDump(JSON.stringify({ format: LEDGER_DUMP_FORMAT, tables: [{ name: 'x', columns: [] }] }), LEDGER_DUMP_FORMAT), /not a Ledger dump/);
});

test('bookmark prints each Ledger with the command that restores them', () => {
  const text = formatBookmark({ id: 'b1', project: 'demo', at: '2026-10-27T10:00:00Z', ledgers: [{ name: 'project:demo', bookmark: '0000-0001' }, { name: '__index', bookmark: '0000-0002' }] });
  assert.match(text, /demo: bookmark b1 recorded/);
  assert.match(text, /project:demo +0000-0001/);
  assert.match(text, /__index +0000-0002/);
  assert.match(text, /atelier ledger restore --bookmark b1 --project demo/);
});

test('restore says each Ledger restores on its next start and how to undo it', () => {
  const text = formatRestore({ project: 'demo', bookmark: 'b1', recordedAt: '2026-10-27T10:00:00Z', undo: 'b2', restoring: [{ name: 'project:demo', bookmark: '0000-0001' }, { name: '__index', bookmark: '0000-0002' }] });
  assert.match(text, /project:demo restores to 0000-0001 on its next start/);
  assert.match(text, /__index restores to 0000-0002 on its next start/);
  assert.match(text, /atelier ledger restore --bookmark b2 --project demo/);
});

test('dump and import report the rows, the schema version and any token replaced', () => {
  const dump = { project: 'demo', schemaVersion: 'abc', deployed: 'f'.repeat(40), redacted: 1, tables: [{ name: 'items', rows: [[1], [2]] }] };
  assert.match(formatDump(dump, 'x.json'), /wrote 1 tables, 2 rows, to x\.json\.\nSchema version abc, written by ffffffffffff\.\n1 token pasted into text was replaced/);
  assert.match(formatImport(dump, { counts: { items: 2, meta: 3 }, registered: true }, 'demo'), /imported 2 rows of 1 tables .* now holds 5 rows[\s\S]*demo was not registered on this server and is now/);
});

test('a stored value dumps as JSON and imports back as it was, a pasted token apart', async () => {
  const { dumpValue, importValue, dumpableTable } = await import('../src/rules.ts');
  const count = { redacted: 0 };
  const token = `atl_${'ab'.repeat(32)}`;
  assert.equal(dumpValue(`see ${token} here`, count), 'see [redacted] here');
  assert.equal(count.redacted, 1);
  assert.equal(dumpValue('f'.repeat(64), count), 'f'.repeat(64));
  assert.equal(dumpValue('atl_config', count), 'atl_config');
  assert.equal(dumpValue(7, count), 7);
  assert.equal(dumpValue(null, count), null);
  const blob = dumpValue(new Uint8Array([0, 1, 255]).buffer, count);
  assert.deepEqual(new Uint8Array(importValue(JSON.parse(JSON.stringify(blob)))), new Uint8Array([0, 1, 255]));
  assert.throws(() => importValue({}), /a dumped value/);
  assert.ok(dumpableTable('items'));
  assert.ok(!dumpableTable('sqlite_sequence') && !dumpableTable('_cf_METADATA') && !dumpableTable('x"; DROP'));
});
