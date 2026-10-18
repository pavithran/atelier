import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve('.');
const post = join(root, 'bin/orchestrate/post-merge.sh');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-orchestrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const env = { ...process.env, ATELIER_CACHE: dir, ATELIER_PROJECT: 'fixture',
    PATH: `${bin}:${process.env.PATH}` };
  const script = (name, content) => { const path = join(bin, name); writeFileSync(path, `#!/bin/sh\n${content}\n`, { mode: 0o755 }); return path; };
  return { dir, env, script };
}
function run(file, args, env, cwd = root) {
  return spawnSync(file, args, { env, cwd, encoding: 'utf8', timeout: 20000 });
}

function repository(t) {
  const f = fixture(t);
  const repo = join(f.dir, 'repo'); mkdirSync(repo);
  const git = (...args) => {
    const r = run('git', args, f.env, repo);
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'public@example.invalid');
  writeFileSync(join(repo, 'file'), 'base\n'); git('add', 'file'); git('commit', '-m', 'base');
  git('init', '--bare', join(f.dir, 'mirror'));
  git('remote', 'add', 'public', join(f.dir, 'mirror')); git('push', 'public', 'main');
  git('config', 'branch.main.remote', 'public'); git('config', 'branch.main.merge', 'refs/heads/main');
  // Stub only checks/deploy; git and its history inspection remain real.
  f.script('npm', `echo "npm $*" >> "$ATELIER_CACHE/steps"`);
  f.env.NOREPLY = 'public@example.invalid';
  const invoke = () => run('/bin/sh', [post, 't1'], f.env, repo);
  return { ...f, repo, git, invoke };
}

for (const role of ['author', 'committer']) {
  test(`publishing rejects a private ${role} even when the other identity is public`, (t) => {
    const f = repository(t);
    f.env[role === 'author' ? 'GIT_AUTHOR_EMAIL' : 'GIT_COMMITTER_EMAIL'] = 'private@example.invalid';
    f.git('commit', '--allow-empty', '-m', 'mixed identities');
    f.env.PUBLIC_AUDIT_HEAD = f.git('rev-parse', 'HEAD');
    const r = f.invoke();
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /Repair outgoing commit identities/);
  });
}

test('publishing catches a private path added and removed despite an empty net diff', (t) => {
  const f = repository(t);
  writeFileSync(join(f.repo, '.env'), 'placeholder\n'); f.git('add', '.env'); f.git('commit', '-m', 'add');
  f.git('rm', '.env'); f.git('commit', '-m', 'remove');
  f.env.PUBLIC_AUDIT_HEAD = f.git('rev-parse', 'HEAD');
  assert.equal(f.git('diff', 'public/main', 'HEAD'), '');
  const r = f.invoke();
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /Remove private files from outgoing history/);
});

test('full history audit preserves reverted content and requires approval of the exact head', (t) => {
  const f = repository(t);
  writeFileSync(join(f.repo, 'file'), 'sensitive fixture\n'); f.git('commit', '-am', 'add');
  writeFileSync(join(f.repo, 'file'), 'base\n'); f.git('commit', '-am', 'remove');
  assert.equal(f.git('diff', 'public/main', 'HEAD'), '');
  let r = f.invoke();
  assert.equal(r.status, 1, r.stderr);
  assert.match(readFileSync(join(f.repo, '.git/public-audit/history.patch'), 'utf8'), /\+sensitive fixture/);
  f.env.PUBLIC_AUDIT_HEAD = f.git('rev-parse', 'HEAD');
  r = f.invoke();
  assert.equal(r.status, 0, r.stderr);
  const steps = readFileSync(join(f.dir, 'steps'), 'utf8').trim().split('\n');
  assert.deepEqual(steps.slice(0, 3), ['npm run typecheck', 'npm test', 'npm run deploy']);
  f.git('commit', '--allow-empty', '-m', 'new head');
  r = f.invoke();
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /After clearing every private detail/);
});

for (const failing of ['typecheck', 'test', 'deploy']) {
  test(`post-merge stops on ${failing} failure before publishing`, (t) => {
    const f = repository(t);
    f.git('commit', '--allow-empty', '-m', 'outgoing');
    const mirror = f.git('rev-parse', 'public/main');
    f.env.PUBLIC_AUDIT_HEAD = f.git('rev-parse', 'HEAD');
    f.script('npm', `case "$*" in "${failing === 'test' ? 'test' : `run ${failing}`}") exit 9;; esac`);
    const r = f.invoke();
    assert.equal(r.status, 9, r.stderr);
    f.git('fetch', 'public');
    assert.equal(f.git('rev-parse', 'public/main'), mirror);
    assert.ok(!existsSync(join(f.repo, '.git/public-audit/history.patch')));
  });
}

test('remote smoke checks bracket deployment and a failed after check holds publication', (t) => {
  const f = repository(t);
  f.git('commit', '--allow-empty', '-m', 'outgoing');
  const mirror = f.git('rev-parse', 'public/main');
  f.env.PUBLIC_AUDIT_HEAD = f.git('rev-parse', 'HEAD');
  f.env.POST_MERGE_SMOKE = f.script('smoke', `echo "smoke $1" >> "$ATELIER_CACHE/steps"\n[ "$1" = before ]`);
  const r = f.invoke();
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(readFileSync(join(f.dir, 'steps'), 'utf8').trim().split('\n').slice(-3), ['smoke before', 'npm run deploy', 'smoke after']);
  f.git('fetch', 'public'); assert.equal(f.git('rev-parse', 'public/main'), mirror);
});
