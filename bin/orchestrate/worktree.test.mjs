// t731: the worktrees the orchestrator made with a bare `git worktree add`
// committed as the registered checkout's own address (dev@atelier.zone on
// 2026-10-16: 61 builder commits the push scan refused at the very end).
// worktree.sh sets the project's identity in the worktree's own config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const script = resolve('bin/orchestrate/worktree.sh');
const zsh = ['/bin/zsh', '/usr/bin/zsh'].find(existsSync);
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

// A checkout that commits as a private address, a config naming it, and a
// stand-in `atelier` that answers `identity --json` with `identity` (or fails).
function setup(identity, shared) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-worktree-')));
  const main = join(dir, 'main');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.name', 'Checkout Dev'); git(main, 'config', 'user.email', 'dev@atelier.zone');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'start');
  mkdirSync(join(dir, 'config'));
  writeFileSync(join(dir, 'config', 'config.json'), JSON.stringify({ projects: { atelier: { path: main } } }));
  const bin = join(dir, 'atelier');
  writeFileSync(bin, identity ? `#!/bin/sh\necho '${JSON.stringify(identity)}'\n` : '#!/bin/sh\necho "no commit identity" >&2\nexit 1\n');
  chmodSync(bin, 0o755);
  const run = () => spawnSync(zsh, [script, 't9'], { encoding: 'utf8', env: { ...process.env, ATELIER_CONFIG_DIR: join(dir, 'config'), ATELIER_BIN: bin, ATELIER_WORKTREES: join(shared ?? dir, 'wt'), ATELIER_PROJECT: 'atelier' } });
  return { dir, main, wt: join(shared ?? dir, 'wt', 't9'), run };
}

test('a worktree commits as the project, and the checkout keeps its own identity (t731)', { skip: !zsh && 'zsh is not installed' }, (t) => {
  const { dir, main, wt, run } = setup({ name: 'Project Owner', email: '1+owner@users.noreply.github.com', agentEmails: [] });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  git(wt, 'commit', '-q', '--allow-empty', '-m', 'work');
  assert.equal(git(wt, 'log', '-1', '--format=%an <%ae> %cn <%ce>'), 'Project Owner <1+owner@users.noreply.github.com> Project Owner <1+owner@users.noreply.github.com>');
  assert.equal(git(main, 'config', 'user.email'), 'dev@atelier.zone');
  assert.equal(run().status, 0, 'a second run on the same worktree sets it again');
});

test('a project with no identity gets no worktree (t731)', { skip: !zsh && 'zsh is not installed' }, (t) => {
  const { dir, wt, run } = setup(null);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no worktree was made/);
  assert.equal(existsSync(wt), false);
});

// Finding it would have caught (astra, t731 round 1): the folder is keyed by
// the task id alone, so project B's t9 overwrote project A's identity.
test('another project\'s worktree of the same task id is refused and left as it was (t731)', { skip: !zsh && 'zsh is not installed' }, (t) => {
  const a = setup({ name: 'Owner A', email: '1+a@users.noreply.github.com', agentEmails: [] });
  const b = setup({ name: 'Owner B', email: '2+b@users.noreply.github.com', agentEmails: [] }, a.dir);
  t.after(() => { rmSync(a.dir, { recursive: true, force: true }); rmSync(b.dir, { recursive: true, force: true }); });
  assert.equal(a.run().status, 0);
  const r = b.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a worktree of/);
  assert.equal(git(a.wt, 'config', 'user.email'), '1+a@users.noreply.github.com');
});
