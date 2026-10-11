// A build job merges current main before it submits (t435,
// prepareBuildSubmission): a first build or a fix after findings whose fork
// predates main's head is submitted merged, the submission records the main
// commit merged, a conflicting merge goes back to the same harness in the
// same run, the project's regenerate command runs as the landing's merge
// runs it, and a baseline that cannot be fetched is an infrastructure
// failure, not the model's. Real git in a baseline and a workspace cloned
// from it; the harness, the CLI and the server are stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { prepareBuildSubmission, runTask, mergeMainArgs } from './runner.mjs';

const actor = 'codex/gpt-6-astra';
const config = { agents: [{ agent: 'codex', models: ['gpt-6-astra'], command: ['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '{brief_file}'] }] };
const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
const git = (cwd, ...args) => execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, files, message = 'change') => {
  for (const [file, text] of Object.entries(files)) writeFileSync(join(cwd, file), text);
  git(cwd, 'add', ...Object.keys(files));
  git(cwd, 'commit', '-qm', message);
  return git(cwd, 'rev-parse', 'HEAD');
};
// Git as the runner's io.git runs it for the landing's merge (cli/land.mjs):
// the landing's signature, with allowFail answering git's own result.
const landingGit = (cwd, args, { token, allowFail = false, raw = false } = {}) => {
  const r = spawnSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (allowFail) return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stderr}`);
  return raw ? r.stdout : r.stdout.trim();
};

function fixture(t, { conflict = false, generatedConflict = false, regenerate = null, rework = false, resumed = false, unresolved = false, discardWork = false, failFetch = false, advanceDuringResolution = false, mergeJob = false } = {}) {
  const root = mkdtempSync(join(process.cwd(), '.runner-main-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main'), workspace = join(root, 'work');
  mkdirSync(main);
  git(main, 'init', '-qb', 'main');
  const base = commit(main, { 'shared.txt': 'base\n', ...(generatedConflict ? { 'gen.txt': 'base gen\n' } : {}) });
  git(root, 'clone', '-q', main, workspace);
  const prior = rework || resumed ? commit(workspace, { 'prior.txt': 'previous work\n' }) : base;
  const job = { project: 'atelier', actor, agent: 'codex', model: 'gpt-6-astra', item: {
    id: 't435', kind: 'task', title: 'build', scope: ['shared.txt', 'work.txt'], base, head: prior,
    ...(resumed ? { state: 'claimed', owner: actor, head: base } : {}),
  } };
  const calls = [], briefs = [], gitCalls = [], logs = [];
  let latest, harnessCalls = 0, finished = false, tokenCount = 0;
  const fetchedTokens = new Set();
  const advanceMain = () => { latest = commit(main, { [conflict ? 'shared.txt' : 'main.txt']: 'new main\n', ...(generatedConflict ? { 'gen.txt': 'gen from main\n' } : {}) }); };
  if (resumed || mergeJob) advanceMain();
  if (mergeJob) job.item.dispatch = { job: 'merge-main', head: base };
  const io = {
    env: {}, ownerTokens: () => [], stopped: () => false, log: (line) => logs.push(line), workspacePath: () => workspace,
    head: async (cwd, { ref = 'HEAD' } = {}) => git(cwd, 'rev-parse', ref), reset: async () => {},
    isAncestor: async (cwd, a, b) => landingGit(cwd, ['merge-base', '--is-ancestor', a, b], { allowFail: true }).status === 0,
    git: async (args, { cwd, ...opts } = {}) => {
      assert.equal(cwd, workspace, 'the merge runs in the build workspace');
      gitCalls.push(args);
      if (args[0] === 'fetch') {
        if (failFetch) throw new Error('fetch unavailable');
        assert.ok(!fetchedTokens.has(opts.token), 'each refresh obtains a fresh read token');
        fetchedTokens.add(opts.token);
      }
      const result = landingGit(cwd, args, opts);
      // The runner's adapter stops after the command a stop interrupted.
      if (io.stopped()) throw new Error('interrupted');
      return result;
    },
    // The merge-main job's own merge at claim time (startMergeMain).
    fetch: async (cwd, remote, token, ref) => { git(cwd, 'fetch', '-q', remote, ref); },
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
          if (advanceDuringResolution) latest = commit(main, { 'later.txt': 'main advanced during resolution\n' });
        }
      } else {
        commit(cwd, { [conflict ? 'shared.txt' : 'work.txt']: 'work\n', ...(generatedConflict ? { 'gen.txt': 'gen from work\n' } : {}) });
        advanceMain(); // Main advances while the builder is running.
      }
      return { code: 0 };
    },
    cli: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'base-token') return JSON.stringify({ remote: main, token: 'claim-read', defaultBranch: 'main' });
      if (argv[0] === 'baseline-token') return JSON.stringify({ remote: main, token: `read-${++tokenCount}`, defaultBranch: 'main', regenerate });
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
  return { job, io, workspace, main, calls, briefs, gitCalls, logs, get latest() { return latest; }, get harnessCalls() { return harnessCalls; }, get finished() { return finished; } };
}

const finishSummary = (f) => f.calls.find((args) => args[0] === 'finish').slice(-2);

for (const rework of [false, true]) test(`a ${rework ? 'fix after findings' : 'first build'} whose fork predates main's head submits merged with main`, async (t) => {
  const f = fixture(t, { rework });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'submitted', JSON.stringify(state));
  assert.equal(state.mainHead, f.latest);
  assert.equal(state.head, git(f.workspace, 'rev-parse', 'HEAD'));
  assert.equal(readFileSync(join(f.workspace, 'main.txt'), 'utf8'), 'new main\n');
  // The merge is no-ff, its message ends with the builder's Agent line, and
  // the build's own commit is its first parent.
  assert.match(git(f.workspace, 'log', '-1', '--format=%B'), new RegExp(`^Merge main at ${f.latest.slice(0, 8)} into t435\\n\\nAgent: codex/gpt-6-astra$`));
  assert.equal(git(f.workspace, 'rev-parse', 'HEAD^2'), f.latest);
  assert.equal(f.harnessCalls, 1);
  assert.ok(f.finished);
  // The submission records the main commit merged.
  assert.deepEqual(finishSummary(f), ['--summary', `Built t435 with main at ${f.latest} merged`]);
  if (rework) assert.match(f.briefs[0], /Review findings/);
  // Main is read through the project's baseline token, never an item's
  // base token: a runner token may call the former for any project it
  // serves, and the latter only for the job it holds.
  assert.deepEqual(f.calls.filter((args) => args[0] === 'base-token'), []);
  assert.deepEqual(f.calls.filter((args) => args[0] === 'baseline-token'), [['baseline-token', '--project', 'atelier', '--as', actor]]);
});

test('the merge regenerates the project\'s fixtures and commits what changed, as a landing does', async (t) => {
  const f = fixture(t, { regenerate: 'cat main.txt > gen.txt' });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'submitted', JSON.stringify(state));
  assert.equal(state.mainHead, f.latest);
  assert.equal(readFileSync(join(f.workspace, 'gen.txt'), 'utf8'), 'new main\n');
  assert.equal(git(f.workspace, 'log', '-1', '--format=%s'), 'Regenerate after merging main into t435');
  assert.equal(git(f.workspace, 'rev-parse', 'HEAD~1^2'), f.latest, 'the regenerate commit follows the merge of main');
  assert.equal(state.head, git(f.workspace, 'rev-parse', 'HEAD'));
  assert.equal(f.harnessCalls, 1);
  assert.ok(f.finished);
  assert.ok(f.logs.some((line) => /Regenerating with `cat main.txt > gen.txt`/.test(line)), f.logs.join('\n'));
});

test('a conflict only in files the regenerate command rewrites is settled by regenerating, with no second harness run', async (t) => {
  const f = fixture(t, { generatedConflict: true, regenerate: 'cat main.txt work.txt > gen.txt' });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'submitted', JSON.stringify(state));
  assert.equal(f.harnessCalls, 1, 'the builder is not asked to resolve what the command rewrites');
  assert.equal(readFileSync(join(f.workspace, 'gen.txt'), 'utf8'), 'new main\nwork\n');
  assert.equal(state.mainHead, f.latest);
  assert.equal(git(f.workspace, 'status', '--porcelain'), '');
  assert.ok(f.finished);
});

test('conflicting current main returns to the same harness in the same run', async (t) => {
  const f = fixture(t, { conflict: true });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'submitted', JSON.stringify(state));
  assert.equal(f.harnessCalls, 2);
  assert.equal(f.calls.filter((a) => a[0] === 'claim').length, 1);
  assert.equal(readFileSync(join(f.workspace, 'shared.txt'), 'utf8'), 'work and new main\n');
  assert.equal(state.mainHead, f.latest);
  // The resolver commits the runner's message as it stands, so the merge
  // records who resolved it (the stub's --no-edit keeps git's conflict note).
  assert.match(git(f.workspace, 'log', '-1', '--format=%B'), new RegExp(`^Merge main at ${f.latest.slice(0, 8)} into t435\\n\\nAgent: codex/gpt-6-astra\\n`));
  assert.ok(f.logs.some((line) => line.includes('merged with conflicts in shared.txt')), f.logs.join('\n'));
  assert.deepEqual(finishSummary(f), ['--summary', `Built t435 with main at ${f.latest} merged`]);
});

test('a committed conflict resolution with blocked validation is not submitted or resumed as verified', async (t) => {
  const f = fixture(t, { conflict: true });
  const harness = f.io.harness;
  let saved;
  f.io.writeValidationBlock = async (cwd, block) => {
    assert.equal(cwd, f.workspace);
    saved = block;
  };
  f.io.harness = async (argv, cwd, env, options) => {
    assert.deepEqual(options, { capture: true, stream: true });
    const result = await harness(argv, cwd, env, options);
    return f.harnessCalls === 2
      ? { ...result, output: 'validation_blocked: tests could not run because listen EPERM' }
      : result;
  };
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'failed');
  assert.equal(state.validationBlocked, true);
  assert.equal(state.taskFailure, false);
  assert.equal(f.finished, false);
  assert.equal(f.harnessCalls, 2);
  assert.equal(existsSync(join(f.workspace, '.git', 'MERGE_HEAD')), false);
  assert.equal(saved.actor, actor);
  assert.equal(saved.head, git(f.workspace, 'rev-parse', 'HEAD'));
  assert.match(saved.detail, /listen EPERM/);
});

test('resumed work refreshes main before submission without rebuilding', async (t) => {
  const f = fixture(t, { resumed: true });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'submitted', JSON.stringify(state));
  assert.equal(f.harnessCalls, 0);
  assert.equal(state.mainHead, f.latest);
});

test('an uncommitted resolution is the model\'s failure and nothing is submitted', async (t) => {
  const f = fixture(t, { conflict: true, unresolved: true });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'failed');
  assert.match(state.reason, /still unresolved or uncommitted/);
  assert.equal(state.taskFailure, true);
  assert.equal(f.finished, false);
});

test('a baseline that cannot be fetched is an infrastructure failure, not the model\'s, and nothing is submitted', async (t) => {
  const f = fixture(t, { failFetch: true });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'failed');
  assert.match(state.reason, /fetch unavailable/);
  assert.equal(state.taskFailure, false, 'the fetch failure is not counted against the model');
  assert.equal(f.finished, false);
  assert.equal(f.harnessCalls, 1);
});

test('main advancing during conflict resolution is refreshed before submission', async (t) => {
  const f = fixture(t, { conflict: true, advanceDuringResolution: true });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'submitted', JSON.stringify(state));
  assert.equal(state.mainHead, f.latest);
  assert.equal(readFileSync(join(f.workspace, 'later.txt'), 'utf8'), 'main advanced during resolution\n');
  assert.equal(f.gitCalls.filter((args) => args[0] === 'fetch').length, 2, 'main is read again after the resolver ran');
});

test('a clean explicit merge job also records current main before finishing', async (t) => {
  const f = fixture(t, { mergeJob: true });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'submitted', JSON.stringify(state));
  assert.equal(state.mainHead, f.latest);
  assert.equal(f.harnessCalls, 0);
  assert.deepEqual(finishSummary(f), ['--summary', `Merged main at ${f.latest}`]);
});

test('a resolver cannot submit main by discarding the committed build', async (t) => {
  const f = fixture(t, { conflict: true, discardWork: true });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'failed');
  assert.match(state.reason, /discarded the build's committed work/);
  assert.equal(f.finished, false);
});

test('a part refreshes the baseline through the project\'s baseline token, not its plan\'s base token', async (t) => {
  const f = fixture(t);
  Object.assign(f.job.item, { kind: 'part', plan: 't400' });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'submitted', JSON.stringify(state));
  assert.equal(state.mainHead, f.latest);
  assert.deepEqual(f.calls.filter((args) => args[0] === 'base-token'), [], 'the plan\'s base token is not the part\'s runner\'s to read');
  assert.deepEqual(f.calls.find((args) => args[0] === 'baseline-token'), ['baseline-token', '--project', 'atelier', '--as', actor]);
});

for (const stage of ['fetch', 'merge']) test(`stopping after ${stage} prevents further merge work`, async (t) => {
  const f = fixture(t, { conflict: true });
  let stopped = false;
  f.io.stopped = () => stopped;
  const original = f.io.git;
  f.io.git = async (args, opts) => {
    const after = args[0] === stage;
    // The stop lands while the command runs; the adapter sees it after.
    const result = await original(args, opts).catch((error) => { if (after) return null; throw error; });
    if (after) { stopped = true; throw new Error('interrupted'); }
    return result;
  };
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'failed');
  assert.match(state.reason, /interrupted/);
  assert.equal(f.harnessCalls, 1, 'no resolution harness starts after stopping');
  assert.equal(existsSync(join(f.workspace, '.git', 'MERGE_HEAD')), stage === 'merge');
  assert.equal(f.finished, false);
});
