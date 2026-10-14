// The port check a build's runner makes after the harness ports an edit to
// code main moved to another file (t435, unportedEdits in cli/runner.mjs):
// the comparison made again at the revisions it compared, and each
// finding's edit required at its destination in the workspace's head. Real
// git: a base, main moving a block out of lib.txt into moved.txt, a task
// editing the block in lib.txt, and a head holding the merge and a port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unportedEdits } from './runner.mjs';

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
const run = (cwd, ...args) => execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// Git as the runner binds it for the check: the landing's signature, with
// allowFail answering git's own result and raw the untrimmed output.
const bound = (cwd) => async (args, { allowFail = false, raw = false, env = null } = {}) => {
  const r = spawnSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...(env ?? {}) } });
  if (allowFail) return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stderr}`);
  return raw ? r.stdout : r.stdout.trim();
};

const LIB = 'a\nb\nc\nd\ne\nf\ng\nh\n';
const LIB_ON_MAIN = 'a\nd\ne\nh\n', MOVED_ON_MAIN = 'b\nc\nd\ne\nf\ng\n';

// A repository with the base, main's move on branch main, and the task's
// edit of lib.txt on branch task, forked from the base. Answers a function
// that commits a head on the task branch holding main merged (ours, so the
// merge's tree is exactly the files given) and checks the port there.
function repo(t, taskFiles) {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-runner-port-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  run(dir, 'init', '-qb', 'main');
  const commit = (files, message) => {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) run(dir, 'rm', '-q', '--ignore-unmatch', file);
      else { writeFileSync(join(dir, file), text); run(dir, 'add', file); }
    }
    run(dir, 'commit', '-qm', message);
    return run(dir, 'rev-parse', 'HEAD');
  };
  commit({ 'lib.txt': LIB, 'other.txt': 'other\n' }, 'base');
  run(dir, 'checkout', '-qb', 'task');
  const task = commit(taskFiles, 'task');
  run(dir, 'checkout', '-q', 'main');
  const main = commit({ 'lib.txt': LIB_ON_MAIN, 'moved.txt': MOVED_ON_MAIN }, 'main moves the block');
  run(dir, 'checkout', '-q', 'task');
  return async (headFiles) => {
    run(dir, 'merge', '-q', '--no-commit', '-s', 'ours', main);
    commit(headFiles, 'merge and port');
    return unportedEdits(bound(dir), { task, main });
  };
}

test('an insertion ported into the moved code is at its destination; left out of it, it is not', async (t) => {
  const check = repo(t, { 'lib.txt': 'a\nb\nc\nd\nx\ne\nf\ng\nh\n' });
  const unported = await check({ 'lib.txt': LIB_ON_MAIN, 'moved.txt': 'b\nc\nd\nx\ne\nf\ng\n' });
  assert.deepEqual(unported, []);
  const left = await check({ 'lib.txt': 'a\nd\nx\ne\nh\n', 'moved.txt': MOVED_ON_MAIN });
  assert.equal(left.length, 1);
  assert.equal(left[0].finding.destination.path, 'moved.txt');
  assert.equal(left[0].why, "moved.txt at the build's head does not hold the moved code with the task's edit made");
});

test('a change is ported whatever the surrounding whitespace and blank lines, and a copy of the block left beside the port is found', async (t) => {
  const check = repo(t, { 'lib.txt': 'a\nb\nC\nd\ne\nf\ng\nh\n' });
  assert.deepEqual(await check({ 'lib.txt': LIB_ON_MAIN, 'moved.txt': 'before\n  b\n\n  C\n  d\n  e\n\n  f\n  g\nafter\n' }), []);
  const beside = await check({ 'lib.txt': LIB_ON_MAIN, 'moved.txt': 'b\nC\nd\ne\nf\ng\n\nb\nc\nd\ne\nf\ng\n' });
  assert.equal(beside.length, 1);
  assert.equal(beside[0].why, "moved.txt at the build's head still holds the moved code as main had it, beside the port");
});

test('an edit that only removes lines at the edge of the block is ported only where they are gone from the destination', async (t) => {
  // The task deletes b and c: what remains of the block, d e f g, is in
  // main's copy as it stands, so the block as main had it must be gone.
  const check = repo(t, { 'lib.txt': 'a\nd\ne\nf\ng\nh\n' });
  assert.deepEqual(await check({ 'lib.txt': LIB_ON_MAIN, 'moved.txt': 'd\ne\nf\ng\n' }), []);
  const kept = await check({ 'lib.txt': LIB_ON_MAIN, 'moved.txt': MOVED_ON_MAIN });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].why, "moved.txt at the build's head still holds the moved code as main had it, beside the port");
});

test('a file the task deleted is ported where the moved code is gone from its destination, the destination file included', async (t) => {
  const check = repo(t, { 'lib.txt': null });
  const kept = await check({ 'moved.txt': MOVED_ON_MAIN });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].why, "moved.txt at the build's head still holds the moved code as main had it, without the task's edit");
  assert.deepEqual(await check({ 'moved.txt': 'unrelated\n' }), []);
  assert.deepEqual(await check({ 'moved.txt': null }), []);
});

test('the task\'s lines are read at the task\'s path where it renamed the source file', async (t) => {
  const check = repo(t, { 'lib.txt': null, 'renamed.txt': 'a\nb\nc\nd\nx\ne\nf\ng\nh\n' });
  assert.deepEqual(await check({ 'renamed.txt': LIB_ON_MAIN, 'moved.txt': 'b\nc\nd\nx\ne\nf\ng\n' }), []);
  assert.equal((await check({ 'renamed.txt': 'a\nd\nx\ne\nh\n', 'moved.txt': MOVED_ON_MAIN })).length, 1);
});

test('a comparison with no finding has nothing to check', async (t) => {
  const check = repo(t, { 'other.txt': 'changed\n' });
  assert.deepEqual(await check({ 'lib.txt': LIB_ON_MAIN, 'moved.txt': MOVED_ON_MAIN }), []);
});
