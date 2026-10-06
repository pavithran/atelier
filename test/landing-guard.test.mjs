// What a landing must not run or follow. `atelier merge` checks out accepted
// agent code in the owner's checkout and commits it there, so a hook or a
// script that the checkout's Git configuration runs, changed by the accepted
// head, would run during the landing and stay to run at the owner's next Git
// command; and a symlink in the accepted tree where the landing reads or
// writes its ControlPlane receipt would take that read or write outside the
// checkout. Each landing here is the real CLI against a fake ledger on
// 127.0.0.1, in scratch repositories with their own Git configuration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { commandWords, executablePaths, hooksOff, landingDir, landingJournalFile, landingSymlinks, touchedExecutables, treeEntries } from '../cli/landing.mjs';

// The client hooks a landing's Git commands could start.
const HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-merge-commit', 'post-merge', 'post-checkout', 'pre-push', 'reference-transaction', 'post-index-change', 'post-rewrite', 'pre-auto-gc'];
// ControlPlane's protected paths, as the ledger records them at acceptance.
const PROTECTED = ['AGENTS.md', 'CLAUDE.md', 'GLM.md', 'docs/control-plane/**', 'tools/control-plane/**'];

// The process environment without any Git setting the caller's own shell
// passes, with this test's own HOME and global configuration.
function isolated(p) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, HOME: join(p, 'home'), GIT_CONFIG_GLOBAL: join(p, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
}

// The owner's checkout, its baseline, and a task's fork with the accepted
// head, served by a fake ledger. `setup` shapes the checkout before its first
// commit; `change` makes the accepted head in the task's workspace. Every
// hook or script a test plants appends a line to `log`, outside the checkout,
// so `ran()` says what ran.
async function landFixture(t, { setup = () => {}, change, controlPlane = false, failLandingOnce = false }) {
  const p = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-guard-')));
  t.after(() => rmSync(p, { recursive: true, force: true }));
  const env = isolated(p), home = env.HOME, outside = join(p, 'outside'), log = join(outside, 'exec.log');
  for (const dir of [home, outside]) mkdirSync(dir, { recursive: true });
  writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Owner\n\temail = owner@example.invalid\n[init]\n\tdefaultBranch = main\n');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (base, path, text, exec = false) => { const file = join(base, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); if (exec) chmodSync(file, 0o755); };
  const script = (name) => `#!/bin/sh\necho "${name} $*" >> "${log}"\n`;
  const tools = { git, write, script, p, home, outside, log };

  const checkout = join(p, 'checkout');
  mkdirSync(checkout);
  git(checkout, 'init', '-q', '-b', 'main');
  write(checkout, 'README.md', 'demo\n');
  if (controlPlane) {
    write(checkout, 'docs/control-plane/execution-policy.v1.json', JSON.stringify({ allowed_classes: ['direct', 'coordinated', 'protected'], direct: { enabled: false, allowed_path_patterns: [] }, protected_path_patterns: [] }) + '\n');
    write(checkout, 'docs/control-plane/landing-receipt.v1.json', JSON.stringify({ project_id: 'demo-from-template' }) + '\n');
    write(checkout, 'docs/control-plane/landing-receipts/.gitkeep', '');
  }
  setup({ ...tools, checkout });
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-q', '-m', 'Initial');
  const base = git(checkout, 'rev-parse', 'HEAD');

  // A bare clone runs none of the checkout's hooks.
  const baseline = join(p, 'baseline.git'), fork = join(p, 'fork.git'), ws = join(p, 'workspace');
  git(p, 'clone', '-q', '--bare', checkout, baseline);
  git(p, 'clone', '-q', '--bare', baseline, fork);
  git(p, 'clone', '-q', fork, ws);
  change({ ...tools, ws });
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'Task t1\n\nAgent: codex/test');
  git(ws, 'push', '-q', 'origin', 'HEAD:main');
  const head = git(ws, 'rev-parse', 'HEAD');

  const box = { state: 'accepted', failLanding: failLandingOnce, requests: [] };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {}, path = new URL(req.url, 'http://x').pathname;
    box.requests.push(`${req.method} ${path}`);
    const item = { id: 't1', title: 'Task one', scope: [], state: box.state, owner: 'codex/test', head, acceptedHead: head, base };
    let answer = {};
    if (path === '/api/projects/proj' && req.method === 'GET') answer = { project: { name: 'proj', policy: { protected: PROTECTED, eligible: [], refuseOverlap: false } }, items: [], events: [] };
    else if (path === '/api/projects/proj/items/t1') answer = { item, policy: { checks: [], protected: [] }, gate: { ready: true, blockers: [], changeClass: 'coordinated' }, evidence: [], reviews: [], acceptanceProtected: PROTECTED, events: [{ kind: 'item.claimed', actor: 'codex/test', at: '2026-10-06T00:00:00Z', data: {} }] };
    else if (path.endsWith('/baseline-token')) answer = { remote: baseline, token: 'fixture', defaultBranch: 'main' };
    else if (path.endsWith('/read-token')) answer = { remote: fork, token: 'fixture', defaultBranch: 'main', head, base };
    else if (path.endsWith('/landing') && body.cancel !== true && box.failLanding) {
      box.failLanding = false;
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'temporary', detail: 'retry' }));
    } else if (path.endsWith('/merged')) box.state = 'merged';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`, config = join(p, 'config'), cache = join(p, 'cache');
  mkdirSync(config);
  writeFileSync(join(config, 'config.json'), JSON.stringify({ server: url, owner: 'owner', projects: { proj: { path: checkout, branch: 'main' } } }));

  // What the fixture's own commits and pushes ran is not the landing's.
  rmSync(log, { force: true });
  const run = async (...args) => {
    const child = spawn(process.execPath, [resolve('cli/atelier.mjs'), ...args, '--project', 'proj'], { cwd: checkout, env: { ...env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: 'fixture', ATELIER_CACHE: cache, ATELIER_SERVER: url } });
    let output = '';
    child.stdout.on('data', (s) => { output += s; });
    child.stderr.on('data', (s) => { output += s; });
    const status = await new Promise((ok) => child.on('close', ok));
    return { status, output };
  };
  const ran = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  // A refused landing leaves the checkout, the baseline and the ledger as they were.
  const assertUntouched = () => {
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), base);
    assert.equal(git(checkout, '-c', 'core.hooksPath=/dev/null', 'status', '--porcelain', '--untracked-files=all'), '');
    assert.ok(!existsSync(join(checkout, '.git', 'MERGE_HEAD')), 'MERGE_HEAD');
    assert.ok(!existsSync(landingJournalFile(landingDir(cache, join(checkout, '.git')))), 'journal');
    assert.equal(git(p, '--git-dir', baseline, 'rev-parse', 'main'), base);
    assert.ok(!box.requests.some((r) => r.endsWith('/landing') || r.endsWith('/merged')), box.requests.join(' '));
  };
  return { ...tools, checkout, baseline, base, head, box, run, ran, assertUntouched };
}

// ── hooks and scripts the checkout's Git configuration runs ─────────────────

// ourai's checkout sets core.hooksPath=scripts/hooks, a tracked folder. An
// accepted head that rewrites its pre-commit and adds every other client
// hook would run them during the landing's merge, commit and push, and again
// at each of the owner's later commits.
test('merge refuses an accepted change to a hooks folder inside the tree, and no hook runs', async (t) => {
  const f = await landFixture(t, {
    setup: ({ checkout, git, write }) => { write(checkout, 'scripts/hooks/pre-commit', '#!/bin/sh\nexit 0\n', true); git(checkout, 'config', 'core.hooksPath', 'scripts/hooks'); },
    change: ({ ws, write, script }) => {
      write(ws, 'scripts/hooks/pre-commit', `${script('pre-commit')}printf compromised > "$HOME/atelier-hook-proof"\n`, true);
      for (const hook of HOOKS.slice(1)) write(ws, `scripts/hooks/${hook}`, script(hook), true);
      write(ws, 'README.md', 'task\n');
    },
  });
  const r = await f.run('merge', 't1');
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /the accepted change touches files that this checkout's Git configuration runs: scripts\/hooks\/[^;]*, which reach scripts\/hooks, the hooks folder named by core\.hooksPath\./);
  for (const hook of HOOKS) assert.ok(r.output.includes(`scripts/hooks/${hook}`), hook);
  assert.ok(!r.output.includes('README.md'), 'only the paths that run are named');
  assert.match(r.output, /Nothing was merged; review those files in the accepted change and land it by hand/);
  assert.equal(f.ran(), '');
  assert.ok(!existsSync(join(f.home, 'atelier-hook-proof')));
  f.assertUntouched();
});

// Each setting names a script inside the tree that the accepted head
// rewrites. The filter's smudge script would run inside the merge itself,
// since z.txt is checked out after tools/; the others would run at a later
// merge, diff or commit, or define a new hook (the included file).
const SETTINGS = [
  {
    name: 'a filter driver',
    setup: ({ checkout, git, write }) => {
      write(checkout, '.gitattributes', '*.txt filter=demo\n');
      write(checkout, 'tools/clean.sh', 'cat\n');
      write(checkout, 'tools/smudge.sh', 'cat\n');
      write(checkout, 'a.txt', 'a\n');
      git(checkout, 'config', 'filter.demo.clean', 'sh tools/clean.sh');
      git(checkout, 'config', 'filter.demo.smudge', 'sh tools/smudge.sh');
    },
    change: ({ ws, write, log }) => {
      write(ws, 'tools/smudge.sh', `echo smudge >> "${log}"\ncat\n`);
      write(ws, 'z.txt', 'z\n');
    },
    named: 'tools/smudge.sh, named by filter.demo.smudge',
  },
  {
    name: 'a merge driver',
    setup: ({ checkout, git, write }) => {
      write(checkout, '.gitattributes', '*.dat merge=demo\n');
      write(checkout, 'tools/merge.sh', '#!/bin/sh\nexit 1\n', true);
      git(checkout, 'config', 'merge.demo.driver', 'tools/merge.sh %O %A %B');
    },
    change: ({ ws, write, script }) => write(ws, 'tools/merge.sh', script('merge driver'), true),
    named: 'tools/merge.sh, named by merge.demo.driver',
  },
  {
    name: 'a textconv command that finds the top of the tree itself',
    setup: ({ checkout, git, write }) => {
      write(checkout, 'tools/conv.sh', '#!/bin/sh\ncat "$1"\n', true);
      git(checkout, 'config', 'diff.demo.textconv', '"$(git rev-parse --show-toplevel)/tools/conv.sh"');
    },
    change: ({ ws, write, script }) => write(ws, 'tools/conv.sh', script('textconv'), true),
    named: 'tools/conv.sh, named by diff.demo.textconv',
  },
  {
    name: 'a hook defined in configuration',
    setup: ({ checkout, git, write }) => {
      write(checkout, 'tools/lint.sh', '#!/bin/sh\nexit 0\n', true);
      git(checkout, 'config', 'hook.lint.command', './tools/lint.sh');
      git(checkout, 'config', 'hook.lint.event', 'pre-commit');
    },
    change: ({ ws, write, script }) => write(ws, 'tools/lint.sh', script('hook.lint'), true),
    named: 'tools/lint.sh, named by hook.lint.command',
  },
  {
    name: 'a configuration file included from the tree',
    setup: ({ checkout, git, write }) => {
      write(checkout, 'repo.gitconfig', '[core]\n\tautocrlf = false\n');
      git(checkout, 'config', 'include.path', '../repo.gitconfig');
    },
    change: ({ ws, write, script }) => {
      write(ws, 'tools/evil.sh', script('included hook'), true);
      write(ws, 'repo.gitconfig', '[hook "evil"]\n\tcommand = ./tools/evil.sh\n\tevent = pre-commit\n\tevent = post-commit\n');
    },
    named: 'repo.gitconfig, a Git configuration file this checkout includes',
  },
  {
    name: 'a hook in .git/hooks that links into the tree',
    setup: ({ checkout, write }) => {
      write(checkout, 'scripts/pre-commit', '#!/bin/sh\nexit 0\n', true);
      symlinkSync('../../scripts/pre-commit', join(checkout, '.git', 'hooks', 'pre-commit'));
    },
    change: ({ ws, write, script }) => write(ws, 'scripts/pre-commit', script('linked pre-commit'), true),
    named: 'scripts/pre-commit, the file the hook .git/hooks/pre-commit links to',
  },
];
for (const setting of SETTINGS) {
  test(`merge refuses an accepted change to ${setting.name}'s script, and nothing runs`, async (t) => {
    const f = await landFixture(t, setting);
    const r = await f.run('merge', 't1');
    assert.equal(r.status, 1, r.output);
    assert.ok(r.output.includes(`runs: ${setting.named}.`), r.output);
    assert.equal(f.ran(), '');
    f.assertUntouched();
  });
}

// A landing that touches no such file goes ahead, and none of its Git
// commands runs a hook in the checkout: not the merge, the commit, the
// notes, the push, the reset of merge --cancel --discard-local, nor the merge
// that follows it. The hooks are in .git/hooks, outside the tree, and in
// configuration, local and global (a hook whose name holds a dot and
// capitals): Git 2.54 runs the configured ones under core.hooksPath=/dev/null
// alone. Each hook logs the folder it runs in. A push to a baseline that is a
// bare repository on this machine, as here, runs the global hooks inside that
// repository, as the side receiving the push; in use the baseline is
// Artifacts over https, so only what ran in the checkout counts. After the
// landing the owner's own commit still runs every hook, so nothing was
// switched off for good.
test('every Git command of a landing runs with hooks off, in a hooks folder or defined in configuration', async (t) => {
  const f = await landFixture(t, {
    failLandingOnce: true,
    setup: ({ checkout, git, write, outside, log }) => {
      const logged = (name) => `#!/bin/sh\necho "${name} $(pwd)" >> "${log}"\n`;
      for (const hook of HOOKS) write(checkout, `.git/hooks/${hook}`, logged(`.git/hooks/${hook}`), true);
      write(outside, 'audit.sh', logged('configured $1'), true);
      git(checkout, 'config', 'hook.audit.command', `${join(outside, 'audit.sh')} local`);
      git(checkout, 'config', '--global', 'hook.Global.Audit.command', `${join(outside, 'audit.sh')} global`);
      for (const hook of HOOKS) {
        git(checkout, 'config', '--add', 'hook.audit.event', hook);
        git(checkout, 'config', '--global', '--add', 'hook.Global.Audit.event', hook);
      }
    },
    change: ({ ws, write }) => write(ws, 'README.md', 'task\n'),
  });
  const inCheckout = () => f.ran().split('\n').filter((line) => line.endsWith(` ${f.checkout}`)).join('\n');
  // The landing lease fails once, after the merge commit is made.
  const first = await f.run('merge', 't1');
  assert.equal(first.status, 4, first.output);
  assert.notEqual(f.git(f.checkout, 'rev-parse', 'HEAD'), f.base);
  assert.equal(inCheckout(), '', 'the merge and its commit');
  const cancel = await f.run('merge', 't1', '--cancel', '--discard-local');
  assert.equal(cancel.status, 0, cancel.output);
  assert.equal(f.git(f.checkout, 'rev-parse', 'HEAD'), f.base);
  assert.equal(inCheckout(), '', 'the reset of merge --cancel');
  const landed = await f.run('merge', 't1');
  assert.equal(landed.status, 0, landed.output);
  assert.equal(inCheckout(), '', 'the merge, its commit, notes and push');
  assert.equal(f.box.state, 'merged');
  assert.equal(f.git(f.p, '--git-dir', f.baseline, 'rev-parse', 'main'), f.git(f.checkout, 'rev-parse', 'HEAD'));
  // The owner's next commit, outside Atelier, runs every hook as before.
  f.write(f.checkout, 'later.md', 'later\n');
  f.git(f.checkout, 'add', 'later.md');
  f.git(f.checkout, 'commit', '-q', '-m', 'Later');
  const after = inCheckout();
  for (const name of ['.git/hooks/pre-commit', 'configured local', 'configured global']) assert.ok(after.includes(`${name} ${f.checkout}`), `${name} in ${after}`);
});

// ── symlinks where the landing reads or writes its receipt ──────────────────

// The accepted head replaces the receipts folder with a symlink to a folder
// outside the checkout, or the receipt template with a symlink to a JSON file
// outside it. Followed, the first writes the receipt out there and leaves the
// merge half done; the second copies the outside file's project_id into the
// receipt the landing commits and pushes.
for (const [what, path] of [['receipts folder', 'docs/control-plane/landing-receipts'], ['receipt template', 'docs/control-plane/landing-receipt.v1.json']]) {
  test(`merge refuses a symlink in place of the ${what} before the checkout changes`, async (t) => {
    const f = await landFixture(t, {
      controlPlane: true,
      change: ({ ws, git, outside }) => {
        if (path.endsWith('.json')) {
          writeFileSync(join(outside, 'private.json'), JSON.stringify({ project_id: 'PRIVATE-VALUE-FROM-OUTSIDE' }) + '\n');
          rmSync(join(ws, path));
          symlinkSync(join(outside, 'private.json'), join(ws, path));
        } else {
          git(ws, 'rm', '-q', '-r', path);
          symlinkSync(outside, join(ws, path));
        }
      },
    });
    const r = await f.run('merge', 't1');
    assert.equal(r.status, 1, r.output);
    assert.ok(r.output.includes(`the merge would put a symlink where the landing reads or writes its ControlPlane files: ${path}. `), r.output);
    assert.match(r.output, /Nothing was merged/);
    assert.deepEqual(readdirSync(f.outside).filter((name) => name !== 'private.json'), [], 'nothing was written outside');
    assert.ok(!lstatSync(join(f.checkout, path)).isSymbolicLink());
    f.assertUntouched();
  });
}

test('merge writes the receipt into the real receipts folder, from the real template', async (t) => {
  const f = await landFixture(t, { controlPlane: true, change: ({ ws, write }) => write(ws, 'README.md', 'task\n') });
  const r = await f.run('merge', 't1');
  assert.equal(r.status, 0, r.output);
  const receipts = f.git(f.checkout, 'diff', '--name-only', 'HEAD^1', 'HEAD').split('\n').filter((name) => name.startsWith('docs/control-plane/landing-receipts/'));
  assert.equal(receipts.length, 1, receipts.join(' '));
  const receipt = JSON.parse(readFileSync(join(f.checkout, receipts[0]), 'utf8'));
  assert.equal(receipt.kind, 'control-plane.landing-receipt');
  assert.equal(receipt.project_id, 'demo-from-template');
  assert.equal(receipt.implementation_commit, f.head);
});

// ── the parts ───────────────────────────────────────────────────────────────

test('commandWords keeps the words that can name a file and drops programs on PATH, options and placeholders', () => {
  assert.deepEqual(commandWords('sh tools/clean.sh'), ['tools/clean.sh']);
  assert.deepEqual(commandWords('tools/merge.sh %O %A %B'), ['tools/merge.sh']);
  assert.deepEqual(commandWords('git-lfs filter-process'), ['filter-process']);
  assert.deepEqual(commandWords('code --wait'), []);
  assert.deepEqual(commandWords('node --config=tools/x.json'), ['tools/x.json']);
  assert.deepEqual(commandWords('"$(git rev-parse --show-toplevel)/tools/conv.sh"'), ['./tools/conv.sh']);
  assert.deepEqual(commandWords('"my tools/run me.sh"'), ['my tools/run me.sh', 'tools/run', 'me.sh']);
  assert.deepEqual(commandWords("!sh -c 'cd sub && ./run.sh'"), ['cd sub && ./run.sh', 'sub', './run.sh']);
  assert.deepEqual(commandWords('true'), []);
});

test('touchedExecutables matches a path, a path inside a folder, and a folder or symlink above one, in any case or Unicode form', () => {
  const executables = [{ path: 'scripts/hooks', setting: 'hooks' }, { path: 'tools/smudge.sh', setting: 'filter' }, { path: 'café.sh', setting: 'nfc' }];
  assert.deepEqual(touchedExecutables(['scripts/hooks/pre-commit', 'README.md', 'scripts/other.sh', 'Tools', 'café.sh'], executables), [
    { path: 'scripts/hooks', setting: 'hooks', changed: ['scripts/hooks/pre-commit'] },
    { path: 'tools/smudge.sh', setting: 'filter', changed: ['Tools'] },
    { path: 'café.sh', setting: 'nfc', changed: ['café.sh'] },
  ]);
  assert.deepEqual(touchedExecutables(['scripts/hooksmith', 'tools/smudge.sh.bak'], executables), []);
});

test('landingSymlinks names symlinks where a landing reads or writes, in any case, and nowhere else', () => {
  const tree = ['120000 blob a\tDocs', '100644 blob a\tdocs/control-plane/execution-policy.v1.json', '120000 blob a\tdocs/control-plane/agent-policy.v1.json',
    '120000 blob a\tdocs/control-plane/landing-receipts/2026-10-06-atelier-t1-abcdef12.json', '120000 blob a\tdocs/control-plane/landing-receipts/old/x.json', '120000 blob a\tdocs/guide.md'].join('\0') + '\0';
  assert.deepEqual(landingSymlinks(treeEntries(tree)), ['Docs', 'docs/control-plane/agent-policy.v1.json', 'docs/control-plane/landing-receipts/2026-10-06-atelier-t1-abcdef12.json']);
});

test('executablePaths and hooksOff read the checkout as its Git commands do', (t) => {
  const p = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-guard-')));
  t.after(() => rmSync(p, { recursive: true, force: true }));
  const env = isolated(p), repo = join(p, 'repo');
  writeFileSync(env.GIT_CONFIG_GLOBAL, '[hook "Global.Lint"]\n\tcommand = /usr/bin/true\n\tevent = pre-commit\n[filter "lfs"]\n\tprocess = git-lfs filter-process\n');
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'core.hooksPath', 'scripts/hooks');
  // A command that names the checkout through a symlink still names its paths.
  symlinkSync(repo, join(p, 'alias'));
  git('config', 'filter.demo.clean', `sh ${join(p, 'alias', 'tools', 'clean.sh')}`);
  git('config', 'hook.lint.command', '~/bin/lint');
  git('config', 'hook.lint.event', 'pre-commit');
  assert.deepEqual(executablePaths(repo, env), [
    { path: 'filter-process', setting: 'named by filter.lfs.process' },
    { path: 'tools/clean.sh', setting: 'named by filter.demo.clean' },
    { path: 'scripts/hooks', setting: 'the hooks folder named by core.hooksPath' },
  ]);
  assert.deepEqual(hooksOff(repo, env), [['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'], ['hook.Global.Lint.enabled', 'false'], ['hook.lint.enabled', 'false']]);
});
