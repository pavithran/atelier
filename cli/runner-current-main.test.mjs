import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { prepareBuildSubmission, runTask, mergeMainArgs } from './runner.mjs';

const actor = 'codex/gpt-6-astra';
const config = { agents: [{ agent: 'codex', models: ['gpt-6-astra'], command: ['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '{brief_file}'] }] };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file, text) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-qm', 'change');
  return git(cwd, 'rev-parse', 'HEAD');
};

function fixture(t, { conflict = false, rework = false, resumed = false, unresolved = false, discardWork = false, failFetch = false, advanceDuringResolution = false, mergeJob = false } = {}) {
  const root = mkdtempSync(join(process.cwd(), '.runner-main-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main'), workspace = join(root, 'work');
  mkdirSync(main);
  git(main, 'init', '-qb', 'main');
  const base = commit(main, 'shared.txt', 'base\n');
  git(root, 'clone', '-q', main, workspace);
  const prior = rework || resumed ? commit(workspace, 'prior.txt', 'previous work\n') : base;
  const job = { project: 'atelier', actor, agent: 'codex', model: 'gpt-6-astra', item: {
    id: 't435', kind: 'task', title: 'build', scope: ['shared.txt', 'work.txt'], base, head: prior,
    ...(resumed ? { state: 'claimed', owner: actor, head: base } : {}),
  } };
  const calls = [], briefs = [];
  let latest, harnessCalls = 0, finished = false, tokenCount = 0;
  const fetchedTokens = new Set();
  const advanceMain = () => { latest = commit(main, conflict ? 'shared.txt' : 'main.txt', 'new main\n'); };
  if (resumed || mergeJob) advanceMain();
  if (mergeJob) job.item.dispatch = { job: 'merge-main', head: base };
  const io = {
    env: {}, ownerTokens: () => [], stopped: () => false, log: () => {}, workspacePath: () => workspace,
    head: async (cwd, { ref = 'HEAD' } = {}) => git(cwd, 'rev-parse', ref), reset: async () => {},
    revParse: async (cwd, ref) => git(cwd, 'rev-parse', ref),
    mergeBase: async (cwd, a, b) => git(cwd, 'merge-base', a, b),
    mergePending: async (cwd) => existsSync(join(cwd, '.git', 'MERGE_HEAD')),
    fetch: async (cwd, remote, token, ref) => {
      if (failFetch) throw new Error('fetch unavailable');
      assert.ok(!fetchedTokens.has(token), 'each refresh obtains a fresh read token');
      fetchedTokens.add(token);
      git(cwd, 'fetch', '-q', remote, ref);
    },
    mergeMain: async (cwd, head, message) => {
      try { git(cwd, ...mergeMainArgs(head, message).slice(1)); return { code: 0 }; }
      catch (error) { return { code: error.status, output: error.stdout }; }
    },
    conflicts: async (cwd) => git(cwd, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean),
    jobBrief: async () => ({ text: 'Review findings: fix the behavior.' }),
    brief: async (cwd, text) => { briefs.push(text); return { file: join(root, `brief-${briefs.length}`) }; },
    removeBrief: async () => {},
    harness: async (argv, cwd) => {
      harnessCalls++;
      assert.deepEqual(argv, ['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', join(root, `brief-${briefs.length}`)]);
      assert.equal(cwd, workspace, 'resolution stays in the build workspace');
      if (existsSync(join(cwd, '.git', 'MERGE_HEAD'))) {
        assert.match(briefs.at(-1), /Resolve the merge of main/);
        assert.match(briefs.at(-1), /shared.txt/);
        if (discardWork) {
          git(cwd, 'merge', '--abort');
          git(cwd, 'reset', '--hard', latest);
        } else if (!unresolved) {
          writeFileSync(join(cwd, 'shared.txt'), 'work and new main\n');
          git(cwd, 'add', 'shared.txt');
          git(cwd, 'commit', '-q', '--no-edit');
          if (advanceDuringResolution) latest = commit(main, 'later.txt', 'main advanced during resolution\n');
        }
      } else {
        commit(cwd, conflict ? 'shared.txt' : 'work.txt', 'work\n');
        advanceMain(); // Main advances while the builder is running.
      }
      return { code: 0 };
    },
    cli: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'base-token') return JSON.stringify({ remote: main, token: `read-${++tokenCount}`, defaultBranch: 'main' });
      if (argv[0] === 'finish') {
        // The finish boundary runs checks and submits this merged revision.
        assert.equal(git(workspace, 'merge-base', latest, 'HEAD'), latest);
        assert.equal(git(workspace, 'status', '--porcelain'), '');
        assert.match(argv.at(-1), new RegExp(latest));
        finished = true;
      }
      return '';
    },
  };
  io.prepareSubmission = (assignment, cwd, resolve) => prepareBuildSubmission(assignment, cwd, io, resolve);
  return { job, io, workspace, calls, briefs, get latest() { return latest; }, get harnessCalls() { return harnessCalls; }, get finished() { return finished; } };
}

for (const rework of [false, true]) test(`a ${rework ? 'fix after findings' : 'first build'} submits merged with main advanced after its fork`, async (t) => {
  const f = fixture(t, { rework });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'submitted', JSON.stringify(state));
  assert.equal(state.mainHead, f.latest);
  assert.equal(state.head, git(f.workspace, 'rev-parse', 'HEAD'));
  assert.equal(readFileSync(join(f.workspace, 'main.txt'), 'utf8'), 'new main\n');
  assert.match(git(f.workspace, 'log', '-1', '--format=%B'), /Agent: codex\/gpt-6-astra$/);
  assert.equal(f.harnessCalls, 1);
  assert.ok(f.finished);
  assert.deepEqual(f.calls.find((args) => args[0] === 'finish').slice(-2),
    ['--summary', `Built t435 with main at ${f.latest} merged`]);
  if (rework) assert.match(f.briefs[0], /Review findings/);
});

test('conflicting current main returns to the same harness in the same run', async (t) => {
  const f = fixture(t, { conflict: true });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'submitted', JSON.stringify(state));
  assert.equal(f.harnessCalls, 2);
  assert.equal(f.calls.filter((a) => a[0] === 'claim').length, 1);
  assert.equal(readFileSync(join(f.workspace, 'shared.txt'), 'utf8'), 'work and new main\n');
  assert.equal(state.mainHead, f.latest);
});

test('resumed work refreshes main before submission without rebuilding', async (t) => {
  const f = fixture(t, { resumed: true });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'submitted', JSON.stringify(state));
  assert.equal(f.harnessCalls, 0);
  assert.equal(state.mainHead, f.latest);
});

for (const options of [{ conflict: true, unresolved: true }, { failFetch: true }]) test(`no submission when ${options.unresolved ? 'resolution is uncommitted' : 'main cannot be fetched'}`, async (t) => {
  const f = fixture(t, options);
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'failed');
  assert.equal(f.finished, false);
});

test('main advancing during conflict resolution is refreshed before submission', async (t) => {
  const f = fixture(t, { conflict: true, advanceDuringResolution: true });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'submitted', JSON.stringify(state));
  assert.equal(state.mainHead, f.latest);
  assert.equal(readFileSync(join(f.workspace, 'later.txt'), 'utf8'), 'main advanced during resolution\n');
});

test('a clean explicit merge job also records current main before finishing', async (t) => {
  const f = fixture(t, { mergeJob: true });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'submitted', JSON.stringify(state));
  assert.equal(state.mainHead, f.latest);
  assert.equal(f.harnessCalls, 0);
  assert.deepEqual(f.calls.find((args) => args[0] === 'finish').slice(-2),
    ['--summary', `Merged main at ${f.latest}`]);
});

test('a resolver cannot submit main by discarding the committed build', async (t) => {
  const f = fixture(t, { conflict: true, discardWork: true });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'failed');
  assert.match(state.reason, /discarded the build's committed work/);
  assert.equal(f.finished, false);
});

test('a part refreshes the baseline through its plan before submission', async (t) => {
  const f = fixture(t);
  Object.assign(f.job.item, { kind: 'part', plan: 't400' });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'submitted', JSON.stringify(state));
  assert.equal(state.mainHead, f.latest);
  assert.deepEqual(f.calls.find((args) => args[0] === 'base-token'),
    ['base-token', 't400', '--project', 'atelier', '--as', actor]);
});

for (const stage of ['fetch', 'merge']) test(`stopping after ${stage} prevents further merge work`, async (t) => {
  const f = fixture(t, { conflict: true });
  let stopped = false;
  f.io.stopped = () => stopped;
  const method = stage === 'fetch' ? 'fetch' : 'mergeMain';
  const original = f.io[method];
  f.io[method] = async (...args) => {
    const result = await original(...args);
    stopped = true;
    return result;
  };
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'failed');
  assert.match(state.reason, /interrupted/);
  assert.equal(f.harnessCalls, 1, 'no resolution harness starts after stopping');
  assert.equal(await f.io.mergePending(f.workspace), stage === 'merge');
  assert.equal(f.finished, false);
});
