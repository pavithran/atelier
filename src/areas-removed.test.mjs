import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { agentRoute } from './tokens.ts';
import { renderBoard } from './board-html.ts';
import { boardText } from './board.ts';

// Function areas were removed in t769. A ledger written while they existed
// still has the areas table, the items.area column and the area events; they
// must read and render without the area. The real Ledger runs against SQLite,
// with only the Worker base class and the storage cursor API replaced.
const bundle = await build({ entryPoints: ['src/ledger.ts'], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'durable-object', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'test' }));
  b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }' }));
} }] });
const { Ledger } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const storage = {
    sql: { exec(query, ...bindings) {
      let rows;
      if (query.trim().split(';').filter(s => s.trim()).length > 1) { db.exec(query); rows = []; }
      else rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; }, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    } },
    transactionSync(fn) { db.exec('SAVEPOINT test'); try { const r = fn(); db.exec('RELEASE test'); return r; } catch (e) { db.exec('ROLLBACK TO test'); db.exec('RELEASE test'); throw e; } },
  };
  const ledger = new Ledger({ storage }, {});
  ledger.setProject({ name: 'demo', repo: 'demo--baseline', policy: { checks: ['npm test'], protected: [] }, createdAt: '2026-10-01' }, 'owner');
  return { ledger, db, storage };
}
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

test('a new ledger keeps no areas table or area column', t => {
  const { db } = setup(t);
  assert.ok(!columns(db, 'items').includes('area'));
  assert.deepEqual(columns(db, 'areas'), []);
});

test('a ledger written with areas still reads, edits and shows its tasks without the area', t => {
  const { ledger: first, db, storage } = setup(t);
  first.newItem('Recorded in an area', [], 'owner');
  first.newItem('Recorded in a removed area', [], 'owner');
  db.exec(`ALTER TABLE items ADD COLUMN area TEXT; CREATE TABLE areas (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, purpose TEXT NOT NULL)`);
  db.exec(`INSERT INTO areas (id, name, purpose) VALUES ('a1', 'Core', 'Foundations'); UPDATE items SET area = 'a1' WHERE id = 't1'; UPDATE items SET area = 'a9' WHERE id = 't2'`);
  first.log(null, 'owner', 'area.saved', { id: 'a1', name: 'Core', purpose: 'Foundations' }, '2026-10-02T00:00:00.000Z');
  first.log('t1', 'owner', 'item.edited', { area: 'a1' }, '2026-10-02T00:00:00.000Z');
  db.prepare("UPDATE items SET state = 'merged' WHERE id = 't2'").run();

  const l = new Ledger({ storage }, {});
  assert.deepEqual(l.items().map(i => i.title), ['Recorded in an area', 'Recorded in a removed area']);
  for (const i of [...l.items(), l.item('t1'), l.item('t2')]) assert.ok(!('area' in i), `${i.id} carries no area`);
  assert.deepEqual(l.board().areas, []);
  assert.ok(l.events('t1').some(e => e.kind === 'item.edited'));
  assert.ok(l.events().some(e => e.kind === 'area.saved'));
  l.editItem('t1', 'owner', { nextGate: 'review' });
  assert.equal(l.item('t1').nextGate, 'review');
  assert.equal(db.prepare("SELECT area FROM items WHERE id = 't1'").get().area, 'a1', 'the recorded column is left as it was');
  // The board page and the board command show both, as plain tasks.
  const snapshot = l.board();
  const html = renderBoard('demo', snapshot), text = boardText(snapshot);
  for (const output of [html, text]) {
    assert.ok(output.includes('Recorded in an area') && output.includes('Recorded in a removed area'));
    assert.doesNotMatch(output, /Unsorted|Core|Foundations|\ba1\b|\ba9\b/);
  }
});

test('the board snapshot uses actual gates and only active landing leases', t => {
  const { ledger: l, db } = setup(t);
  l.newItem('Submitted with no evidence', [], 'owner');
  l.claim('t1', 'codex/gpt-6-astra');
  db.prepare("UPDATE items SET state = 'submitted', head = 'abc'").run();
  assert.equal(l.board().facts.t1.ready, false);
  db.prepare("INSERT INTO meta (key, value) VALUES ('landing-lease', ?)").run(JSON.stringify({ item: 't1', holder: 'owner', at: '2020-01-01' }));
  assert.equal(l.board().facts.t1.landing, false);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'landing-lease'").run(JSON.stringify({ item: 't1', holder: 'owner', at: new Date().toISOString() }));
  assert.equal(l.board().facts.t1.landing, true);
  assert.equal(l.board().items[0].owner, 'codex/gpt-6-astra');
  assert.deepEqual(l.board().areas, [], 'an older CLI reads this list');
});

// An agent reads the area paths only to be told they are gone (410), not
// refused (403); no write by an agent was ever allowed there.
test('an agent token still reaches the area paths so that they answer 410', () => {
  assert.equal(agentRoute('GET', ['projects', 'demo', 'areas']), true);
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal(agentRoute(method, ['projects', 'demo', 'areas']), false, method);
  assert.equal(agentRoute('GET', ['projects', 'demo', 'areas', 'a1']), false);
});
