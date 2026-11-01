import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as server from '../src/index.ts';
import { openReader } from '../src/git/reader.mjs';
import { RuleError } from '../src/rules.ts';

const root = mkdtempSync(join(tmpdir(), 'atelier-overlap-advice-'));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.test' } }).trim();

test('server reads branch scope from merge base, excluding later main changes', async () => {
  assert.equal(typeof server.changedSinceBase, 'function');
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'base.txt'), 'base');
  git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 't/157');
  writeFileSync(join(root, 'task file.txt'), 'task');
  git('add', '.'); git('commit', '-qm', 'task');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  writeFileSync(join(root, 'main.txt'), 'main');
  git('add', '.'); git('commit', '-qm', 'main');
  const env = { REPOS: { get: async (name) => openReader(join(root, '.git'), { head: name === 'task' ? 't/157' : 'main' }) } };
  assert.deepEqual(await server.changedSinceBase(env, 'task', head, 'main'), ['task file.txt']);
  assert.equal(await server.changedSinceBase(env, 'task', 'f'.repeat(40), 'main'), null);
});

test('claim refusal reads only unscoped overlapping branches, keeps fallback on unreadable history', async () => {
  assert.equal(typeof server.claimWithOverlapAdvice, 'function');
  const old = '2026-10-29T12:00:00Z';
  const holder = { id: 't157', scope: [], owner: 'codex/gpt-6', state: 'submitted', workspace: 'task', head: 'a'.repeat(40), updatedAt: old, createdAt: old, lastPushAt: old };
  const want = { ...holder, id: 't9', scope: ['src/**'], owner: null, state: 'open' };
  const calls = [];
  const L = { claimOverlaps: async () => ({ item: want, holders: [holder, { ...holder, id: 't159', workspace: 'missing' }] }), project: async () => ({ repo: 'main', policy: { refuseOverlap: true } }) };
  // The real claim's overlap refusal is preserved, with its recovery commands enriched.
  const claim = async () => { throw new RuleError('overlap', 'original overlap', 409, 'generic'); };
  const read = async (_env, workspace) => { calls.push(workspace); if (workspace === 'missing') throw Error('unreadable'); return ['src/a.ts']; };
  await assert.rejects(server.claimWithOverlapAdvice({}, L, want, 'claude-code/opus-5.5', claim, read), (err) => {
    assert.equal(err.detail, 'original overlap');
    assert.match(err.next, /atelier edit t157 --scope 'src\/a.ts'/);
    assert.match(err.next, /atelier edit t159 --scope GLOB/);
    return true;
  });
  assert.deepEqual(calls, ['task', 'missing']);
  calls.length = 0;
  await assert.rejects(server.claimWithOverlapAdvice({}, L, want, 'a', async () => { throw new RuleError('not_owner', 'denied', 403); }, read), /denied/);
  assert.deepEqual(calls, []);
});
