// t688: review.sh found no fork point for a task of a --history-since baseline
// project (t686's review, 2026-10-15) and exited 1 with nothing on standard
// error. fork_point (lib.sh) reads the fork point from the checkout's baseline
// map, or says why it cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const lib = resolve('bin/orchestrate/lib.sh');
const zsh = ['/bin/zsh', '/usr/bin/zsh'].find(existsSync);
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const commit = (cwd, name) => { writeFileSync(join(cwd, name), name); git(cwd, 'add', '.'); git(cwd, 'commit', '-q', '-m', name); return git(cwd, 'rev-parse', 'HEAD'); };
const init = (dir) => { mkdirSync(dir); git(dir, 'init', '-q', '-b', 'main'); };
function forkPoint(ws, main) {
  git(ws, 'fetch', '-q', main, 'main');
  return spawnSync(zsh, ['-c', `source "${lib}"; fork_point "$1" "$2" atelier`, 'x', ws, main], { env, encoding: 'utf8' });
}

test('a fresh-history workspace forks at the newest baseline commit the map lists', { skip: !zsh && 'zsh is not installed' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-forkpoint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = join(dir, 'main'), ws = join(dir, 'ws');
  init(main); const c1 = commit(main, 'one'); const c2 = commit(main, 'two'); commit(main, 'three');
  init(ws); const b1 = commit(ws, 'one'); const b2 = commit(ws, 'two'); commit(ws, 'task');
  writeFileSync(join(main, '.git/atelier-baseline-map.json'), JSON.stringify({ atelier: { [b1]: c1, [b2]: c2 }, other: {} }));
  const r = forkPoint(ws, main);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), b2);
});

test('a workspace that shares history with main forks at the merge base', { skip: !zsh && 'zsh is not installed' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-forkpoint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = join(dir, 'main'), ws = join(dir, 'ws');
  init(main); const c1 = commit(main, 'one'); commit(main, 'two');
  git(dir, 'clone', '-q', main, ws); git(ws, 'reset', '-q', '--hard', c1); commit(ws, 'task');
  const r = forkPoint(ws, main);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), c1);
});

test('no shared commit and no pairing fails with a message naming the cause', { skip: !zsh && 'zsh is not installed' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-forkpoint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = join(dir, 'main'), ws = join(dir, 'ws');
  init(main); commit(main, 'one'); init(ws); commit(ws, 'task');
  const r = forkPoint(ws, main);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /shares no commit with atelier's main/);
  assert.match(r.stderr, /history-since/);
});
