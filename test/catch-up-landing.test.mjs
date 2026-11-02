import { test } from 'node:test';
import assert from 'node:assert/strict';
import { landingWorld } from './land-node-shared.mjs';
import { writeFileSync } from 'node:fs';
import { criteriaOf } from '../src/criteria.ts';

for (const extra of [false, true]) test(extra ? 'landing refuses commits beyond the accepted head' : 'landing publishes the accepted head already in the checkout', async t => {
  const w = await landingWorld(t);
  const { id, head, work } = await w.task({ files: { 'task.txt': 'direct commit\n' } });
  w.git(w.checkout, 'fetch', '-q', work, head);
  w.git(w.checkout, 'merge', '--ff-only', head);
  if (extra) w.git(w.checkout, 'commit', '--allow-empty', '-qm', 'Unreviewed');
  const before = w.git(w.checkout, 'rev-parse', 'HEAD'), baseline = await w.tip();
  const r = await w.cli(['land', id]);
  const d = await w.detail(id);
  if (extra) {
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /tip alone/);
    assert.equal(await w.tip(), baseline);
    assert.equal(d.item.state, 'accepted');
  } else {
    assert.equal(r.status, 0, r.output);
    assert.equal(await w.tip(), head);
    assert.equal(d.item.state, 'merged');
  }
  assert.equal(w.git(w.checkout, 'rev-parse', 'HEAD'), before);
});

test('one catch-up command carries direct commits through checks, review and landing', async t => {
  const w = await landingWorld(t);
  writeFileSync(`${w.checkout}/direct.txt`, 'direct commit\n');
  w.git(w.checkout, 'add', 'direct.txt');
  w.git(w.checkout, 'commit', '-qm', 'Direct work');
  const head = w.git(w.checkout, 'rev-parse', 'HEAD');
  let approved = false, busy = false;
  const timer = setInterval(async () => {
    if (approved || busy) return;
    busy = true;
    try {
      const r = await w.api('GET', '/projects/demo/items/t1');
      if (r.json?.item?.state !== 'submitted') return;
      const item = r.json.item;
      await w.L().addReview({ itemId: item.id, by: 'claude-code/opus-5.5', head: item.head, approve: true, criteria: criteriaOf(item), note: 'Direct work meets the criterion', at: new Date().toISOString() }, undefined, true);
      approved = true;
    } finally { busy = false; }
  }, 10);
  t.after(() => clearInterval(timer));
  const r = await w.cli(['catch-up', '--builder', 'codex/gpt-6', '--reviewer', 'claude-code/opus-5.5', '--accept', 'Direct work is present and checks pass']);
  assert.equal(r.status, 0, r.output);
  assert.ok(approved, r.output);
  assert.equal(await w.tip(), head);
  assert.equal(w.git(w.checkout, 'rev-parse', 'HEAD'), head);
  assert.equal((await w.detail('t1')).item.state, 'merged');
  assert.match(r.output, /t1 caught up and landed/);
});
