import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { prepareRecordedWorkspace } from '../cli/landing.mjs';
import { recordedHeadStillStands } from '../cli/land.mjs';

function fixture(t) {
  mkdirSync('.scratch', { recursive: true });
  const root = mkdtempSync(resolve('.scratch/recorded-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (args, opts = {}) => {
    const r = spawnSync('git', args, { cwd: opts.cwd ?? root, encoding: 'utf8' });
    if (opts.allowFail) return r;
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const source = join(root, 'source'), dir = join(root, 'workspace');
  git(['init', '-q', '-b', 'main', source]);
  const g = (...args) => git(args, { cwd: source });
  g('config', 'user.name', 'Fixture'); g('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(source, 'work'), 'base'); g('add', '.'); g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  writeFileSync(join(source, 'work'), 'recorded'); g('commit', '-qam', 'recorded');
  const head = g('rev-parse', 'HEAD');
  git(['clone', '-q', source, dir]);
  writeFileSync(join(source, 'work'), 'newer fork tip'); g('commit', '-qam', 'unrecorded');
  const detail = { item: { head, owner: 'codex/test', state: 'submitted' }, policy: { commitIdentity: { name: 'Project', email: 'project@example.invalid' }, prepare: { command: 'npm ci' } } };
  const calls = [], lines = [];
  const io = { git, name: 'proj', id: 't1', owner: 'owner', p: { path: source, branch: 'main' }, print: s => lines.push(s), request: async (method, path, body) => {
    calls.push({ method, path, body });
    return method === 'POST' ? { remote: source, token: 'SECRET-READ', defaultBranch: 'main' } : detail;
  } };
  const ctx = { dir, itemPath: '/projects/proj/items/t1', detail };
  const local = (...args) => git(args, { cwd: dir });
  const backup = () => join(root, readdirSync(root).find(s => s.startsWith('workspace.backup-')), 'workspace');
  return { root, source, dir, base, head, detail, io, ctx, local, calls, lines, backup };
}

for (const state of ['missing', 'behind', 'ahead', 'dirty', 'conflicted']) test(`recorded head recovery preserves ${state} workspace and ignores newer fork tip`, async t => {
  const f = fixture(t);
  if (state === 'missing') rmSync(f.dir, { recursive: true });
  else {
    f.local('reset', '--hard', f.base);
    if (state === 'ahead') {
      f.local('config', 'user.name', 'Local'); f.local('config', 'user.email', 'local@example.invalid');
      writeFileSync(join(f.dir, 'local-only'), 'unpublished'); f.local('add', '.'); f.local('commit', '-qm', 'local-only');
    }
    if (state === 'dirty') writeFileSync(join(f.dir, 'work'), 'dirty bytes');
    if (state === 'conflicted') {
      f.local('config', 'user.name', 'Local'); f.local('config', 'user.email', 'local@example.invalid');
      writeFileSync(join(f.dir, 'work'), 'conflicting'); f.local('commit', '-qam', 'conflicting');
      assert.equal(f.io.git(['merge', f.head], { cwd: f.dir, allowFail: true }).status, 1);
    }
  }
  const oldHead = state === 'missing' ? null : f.local('rev-parse', 'HEAD');
  const oldStatus = state === 'missing' ? null : f.local('status', '--porcelain');
  await prepareRecordedWorkspace(f.io, f.ctx);
  assert.equal(f.local('rev-parse', 'HEAD'), f.head);
  assert.equal(f.local('config', 'user.name'), 'Project');
  assert.equal(f.local('config', 'atelier.actor'), 'codex/test');
  assert.deepEqual(JSON.parse(f.local('config', 'atelier.prepare')), f.detail.policy.prepare);
  assert.ok(f.lines.some(s => s.includes(f.head)));
  assert.doesNotMatch(readFileSync(join(f.dir, '.git/config'), 'utf8') + f.lines.join(''), /SECRET-READ/);
  assert.deepEqual(f.calls[0].body, { scope: 'read' });
  assert.ok(f.calls.every(c => !c.path.endsWith('/claim')));
  if (oldHead) {
    const backup = f.backup();
    assert.ok(f.lines.some(s => s.includes(backup)));
    assert.equal(f.io.git(['rev-parse', 'HEAD'], { cwd: backup }), oldHead);
    assert.equal(f.io.git(['status', '--porcelain'], { cwd: backup }), oldStatus);
    if (state === 'conflicted') assert.ok(existsSync(join(backup, '.git/MERGE_HEAD')));
    if (state === 'dirty') assert.equal(readFileSync(join(backup, 'work'), 'utf8'), 'dirty bytes');
  }
});

for (const failure of ['unavailable', 'wrong fetched head', 'configuration', 'race', 'owner race', 'state race', 'backup', 'install']) test(`failed ${failure} stops recovery without losing the original`, async t => {
  const f = fixture(t); f.local('reset', '--hard', f.base);
  writeFileSync(join(f.dir, 'precious'), 'keep');
  const git = f.io.git, request = f.io.request;
  if (failure === 'unavailable') f.io.git = (args, opts) => { if (args[0] === 'fetch') throw new Error('SECRET-READ'); return git(args, opts); };
  if (failure === 'wrong fetched head') f.io.git = (args, opts) => git(args[0] === 'fetch' ? [...args.slice(0, -1), 'main'] : args, opts);
  if (failure === 'configuration') f.io.git = (args, opts) => { if (args[0] === 'config') throw new Error('configuration failed'); return git(args, opts); };
  if (failure === 'race') f.io.request = async (...args) => args[0] === 'GET' ? { item: { ...f.detail.item, head: f.base } } : request(...args);
  if (failure === 'owner race') f.io.request = async (...args) => args[0] === 'GET' ? { item: { ...f.detail.item, owner: 'another/builder' } } : request(...args);
  if (failure === 'state race') f.io.request = async (...args) => args[0] === 'GET' ? { item: { ...f.detail.item, state: 'abandoned' } } : request(...args);
  if (failure === 'backup') f.io.renameWorkspace = () => { throw new Error('backup failed'); };
  if (failure === 'install') {
    const { renameSync } = await import('node:fs');
    f.io.renameWorkspace = (from, to) => { if (from === f.dir) renameSync(from, to); else throw new Error('install failed'); };
  }
  await assert.rejects(prepareRecordedWorkspace(f.io, f.ctx), e => !e.message.includes('SECRET-READ'));
  const preserved = failure === 'install' ? f.backup() : f.dir;
  assert.equal(readFileSync(join(preserved, 'precious'), 'utf8'), 'keep');
  assert.equal(git(['rev-parse', 'HEAD'], { cwd: preserved }), f.base);
  assert.ok(!readdirSync(f.root).some(s => s.startsWith('workspace.prepare-')));
});

test('recovery fetches the exact recorded object using only the read credential', async t => {
  const f = fixture(t), git = f.io.git, fetches = [];
  f.local('reset', '--hard', f.base);
  f.io.git = (args, opts) => {
    if (args[0] === 'fetch') fetches.push({ args, token: opts.token, cwd: opts.cwd });
    return git(args, opts);
  };
  await prepareRecordedWorkspace(f.io, f.ctx);
  assert.equal(fetches.length, 1);
  assert.deepEqual(fetches[0].args, ['fetch', '--quiet', '--no-tags', f.source, f.head]);
  assert.equal(fetches[0].token, 'SECRET-READ');
  assert.notEqual(fetches[0].cwd, f.dir);
});

test('a recorded object absent from the fork leaves the workspace untouched', async t => {
  const f = fixture(t);
  f.detail.item.head = '0'.repeat(40);
  writeFileSync(join(f.dir, 'precious'), 'keep');
  await assert.rejects(prepareRecordedWorkspace(f.io, f.ctx), /recorded commit .* is unavailable/);
  assert.equal(f.local('rev-parse', 'HEAD'), f.head);
  assert.equal(readFileSync(join(f.dir, 'precious'), 'utf8'), 'keep');
  assert.equal(readdirSync(f.root).some(s => s.startsWith('workspace.backup-')), false);
});

test('dry run leaves an absent workspace absent and requests no token', async t => {
  const f = fixture(t); rmSync(f.dir, { recursive: true });
  await prepareRecordedWorkspace(f.io, { ...f.ctx, dryRun: true });
  assert.equal(existsSync(f.dir), false); assert.deepEqual(f.calls, []);
});

test('head guard refuses a ledger race before advancing', async t => {
  const f = fixture(t);
  await recordedHeadStillStands(f.io, f.ctx.itemPath, f.head);
  await assert.rejects(recordedHeadStillStands(f.io, f.ctx.itemPath, f.base), /recorded head changed/);
});


test('a blank actor at the recorded head is repaired only after successful preparation', async t => {
  const f = fixture(t);
  f.local('config', 'atelier.actor', '');
  await prepareRecordedWorkspace(f.io, f.ctx);
  assert.equal(f.local('config', 'atelier.actor'), 'codex/test');
  assert.equal(f.io.git(['rev-parse', 'HEAD'], { cwd: f.backup() }), f.head);
});

test('repeated replacements use different preserved paths', async t => {
  const f = fixture(t);
  f.local('reset', '--hard', f.base);
  await prepareRecordedWorkspace(f.io, f.ctx);
  f.local('reset', '--hard', f.base);
  await prepareRecordedWorkspace(f.io, f.ctx);
  assert.equal(readdirSync(f.root).filter(s => s.startsWith('workspace.backup-')).length, 2);
});
