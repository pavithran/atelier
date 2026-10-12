import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

// Exercise the real Ledger against SQLite, replacing only the Worker base
// class and storage cursor API. No Cloudflare or owner credentials required.
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

test('stable area IDs, unique names, single-line purposes and owner-only mutations', t => {
  const { ledger: l } = setup(t);
  const a = l.saveArea('owner', 'Core', 'Shared foundations');
  assert.equal(a.id, 'a1');
  assert.throws(() => l.saveArea('owner', 'core', 'Duplicate'), /duplicate_area/);
  assert.throws(() => l.saveArea('owner', 'Unsorted', 'Reserved'), /duplicate_area/);
  for (const purpose of ['', 'two\nlines', 'x'.repeat(301)]) assert.throws(() => l.saveArea('owner', 'Invalid', purpose), /bad_area/);
  assert.throws(() => l.saveArea('agent', 'No', 'No'), /not_project_owner/);
  assert.throws(() => l.removeArea(a.id, 'agent'), /not_project_owner/);
  assert.equal(l.saveArea('owner', 'Engine', a.purpose, a.id).id, a.id);
  l.removeArea(a.id, 'owner');
  assert.equal(l.saveArea('owner', 'Core', 'Recreated').id, 'a2');
  assert.throws(() => l.saveArea('owner', 'Missing', 'None', 'a3'), /bad_area/);
});

test('assign, edit, clear and remove areas, including closed tasks and legacy tasks', t => {
  const { ledger: l, db, storage } = setup(t);
  l.newItem('Legacy', [], 'owner');
  const area = l.saveArea('owner', 'Core', 'Foundations');
  assert.throws(() => l.newItem('Wrong ID', [], 'owner', { area: 'a99' }), /bad_area/);
  assert.equal(l.items().length, 1);
  const task = l.newItem('New', [], 'owner', { area: area.id });
  assert.equal(task.area, area.id);
  assert.throws(() => l.editItem(task.id, 'owner', { area: 'a99' }), /bad_area/);
  l.editItem(task.id, 'owner', { area: null });
  assert.equal(l.item(task.id).area, null);
  l.editItem(task.id, 'owner', { area: area.id });
  db.prepare("UPDATE items SET state = 'merged' WHERE id = ?").run(task.id);
  l.editItem(task.id, 'owner', { area: null });
  l.editItem(task.id, 'owner', { area: area.id });
  assert.throws(() => l.editItem(task.id, 'owner', { area: null, title: 'Changed' }), /closed/);
  l.removeArea(area.id, 'owner');
  assert.ok(l.items().every(i => i.area === null));
  assert.equal(l.item(task.id).state, 'merged');
  const restored = new Ledger({ storage }, {});
  assert.deepEqual(restored.areas(), []);
  assert.ok(restored.items().every(i => i.area === null));
  assert.equal(restored.board().items.length, 2);
});

test('board snapshot uses actual gates and only active landing leases', t => {
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
});
