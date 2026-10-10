import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { prepareWorkspace, preparationMarker, prepareTimeout, execute, runRunner } from '../cli/runner.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(process.cwd(), '.prepare-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const gitDir = join(cwd, '.git'), cache = join(cwd, 'cache');
  mkdirSync(gitDir);
  writeFileSync(join(cwd, 'input'), 'one');
  const spec = { command: 'printf ready > output && printf compound', inputs: ['input'], outputs: ['output'] };
  return { cwd, spec, options: { gitDir, cache }, marker: preparationMarker(cache, gitDir) };
}

test('preparation runs compound shell commands and caches only matching content and runtime with outputs', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const run = (spec = f.spec, options = {}) => prepareWorkspace(f.cwd, spec, { ...f.options, executeChild: (...args) => { calls++; return execute(...args); }, ...options });
  await run(); await run(); assert.equal(calls, 1);
  writeFileSync(join(f.cwd, 'input'), 'two'); await run(); assert.equal(calls, 2);
  await run({ ...f.spec, inputs: ['input', 'output'] }); assert.equal(calls, 3);
  await run(); assert.equal(calls, 4);
  await run(f.spec, { runtime: ['different'] }); assert.equal(calls, 5);
  await run(); assert.equal(calls, 6);
  rmSync(join(f.cwd, 'output')); await run(); assert.equal(calls, 7);
  writeFileSync(f.marker, '{invalid'); await run(); assert.equal(calls, 8);
  await run({ ...f.spec, command: f.spec.command + ' changed' }); assert.equal(calls, 9);
  rmSync(join(f.cwd, 'input')); await run(); await run(); assert.equal(calls, 11);
  assert.equal(existsSync(f.marker), false);
});

test('conflicted preparation inputs defer the command and explain resolution', async (t) => {
  const f = fixture(t);
  const result = await prepareWorkspace(f.cwd, f.spec, { ...f.options, conflicts: ['input'], executeChild: () => assert.fail('must not execute') });
  assert.match(result.deferred, /resolve the merge conflicts/);
  assert.ok(result.deferred.includes(f.spec.command));
  assert.equal(existsSync(f.marker), false);
});

test('failed commands, spawn errors and missing outputs never cache success, and bound diagnostic tails', async (t) => {
  const f = fixture(t);
  for (const executeChild of [async () => ({ code: 2, output: 'x'.repeat(10000), stderr: 'tail' }), async () => { throw new Error('spawn ENOENT'); }]) {
    await assert.rejects(prepareWorkspace(f.cwd, f.spec, { ...f.options, executeChild }), (e) => e.infrastructure && e.message.length < 4200);
    assert.equal(existsSync(f.marker), false);
  }
  await assert.rejects(prepareWorkspace(f.cwd, { ...f.spec, command: 'true' }, f.options), /outputs are missing/);
});

test('timeout and cancellation await process group cleanup and never cache', async (t) => {
  const f = fixture(t);
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const pending = prepareWorkspace(f.cwd, { ...f.spec, command: 'sleep 30' }, { ...f.options, signal: controller.signal, timeoutMs: cancel ? 30000 : 20, executeChild: (args, options) => execute(args, { ...options, graceMs: 20 }) });
    if (cancel) setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, cancel ? /interrupted/ : /timed out/);
    assert.equal(existsSync(f.marker), false);
  }
});

test('preparation timeout is bounded positive integer milliseconds', () => {
  assert.equal(prepareTimeout(), 600000);
  assert.equal(prepareTimeout('17'), 17);
  for (const value of ['', '0', '-1', '1.2', ' 10', 'wat', 'Infinity', '2147483648']) assert.throws(() => prepareTimeout(value), /positive integer/);
});

test('markers use the resolved Git directory in the local cache', (t) => {
  const f = fixture(t);
  const alias = join(f.cwd, 'git-alias');
  symlinkSync(f.options.gitDir, alias);
  assert.equal(preparationMarker(f.options.cache, alias), f.marker);
  assert.ok(f.marker.startsWith(join(f.options.cache, 'prepare')));
  const other = join(f.cwd, 'other-git');
  mkdirSync(other);
  assert.notEqual(preparationMarker(f.options.cache, other), f.marker);
});

test('the real runner reads preparation from its claimed Git directory before starting the harness', async (t) => {
  const f = fixture(t);
  rmSync(f.options.gitDir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  git('add', 'input'); git('commit', '-qm', 'initial');
  git('config', 'atelier.prepare', JSON.stringify(f.spec));
  const config = join(f.options.gitDir, 'runner.json');
  writeFileSync(config, JSON.stringify({ agents: [{ agent: 'opencode', models: ['model'], command: ['test-harness', '{model}', '{brief_file}', '{workspace}'] }] }));
  const previousCache = process.env.ATELIER_CACHE, previousCode = process.exitCode;
  process.env.ATELIER_CACHE = f.options.cache;
  t.after(() => { if (previousCache === undefined) delete process.env.ATELIER_CACHE; else process.env.ATELIER_CACHE = previousCache; process.exitCode = previousCode; });
  const calls = [];
  let heads = 0;
  await runRunner({ _: ['runner'], multi: {}, name: 'home:test', config, once: true }, {
    workspacePath: () => f.cwd, load: () => 0, cores: () => 4,
    queue: async () => [{ project: 'demo', item: { id: 't1', title: 'Build', scope: ['input'] }, agent: 'opencode', model: 'model', actor: 'opencode/model' }],
    taskIO: { log: () => {}, head: async () => ++heads === 1 ? 'before' : 'after', dataHome: async () => null },
    executeChild: async (argv, options) => {
      if (argv[1]?.endsWith('atelier.mjs')) { calls.push(argv[2]); return { code: 0 }; }
      if (argv[0] === 'test-harness') {
        assert.ok(existsSync(join(f.cwd, 'output')));
        calls.push('harness'); return { code: 0 };
      }
      return execute(argv, options);
    },
  });
  assert.deepEqual(calls, ['claim', 'harness', 'finish']);
  assert.ok(existsSync(f.marker));
});
