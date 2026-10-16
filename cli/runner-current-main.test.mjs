// A build job merges current main before it submits (t435,
// prepareBuildSubmission): a first build or a fix after findings whose fork
// predates main's head is submitted merged, the submission records the main
// commit merged, a conflicting merge goes back to the same harness in the
// same run, the project's regenerate command runs as the landing's merge
// runs it, a baseline that cannot be fetched is an infrastructure failure,
// not the model's, and an edit of the build's in code main moved to another
// file (t471's comparison) goes back to the same harness to port, after a
// clean merge or with a conflicting one, and the port is checked after the
// harness, so an exit without the port submits nothing. Real git in a
// baseline and a workspace cloned from it; the harness, the CLI and the
// server are stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareBuildSubmission, runTask, mergeMainArgs } from './runner.mjs';
import { readMovedCodeRecords } from './landing.mjs';

// A file main moves a block out of (lib.txt lines 2-7 to moved.txt lines
// 1-6, keeping d and e in place, which bridges the block for the detector):
// an insertion between d and e merges cleanly, since Git keeps a line on
// each side; a change to c conflicts, since main deleted it.
const LIB = 'a\nb\nc\nd\ne\nf\ng\nh\n';
const LIB_ON_MAIN = 'a\nd\ne\nh\n', MOVED_ON_MAIN = 'b\nc\nd\ne\nf\ng\n';
const EDITED = { clean: 'a\nb\nc\nd\nx\ne\nf\ng\nh\n', conflict: 'a\nb\nC\nd\ne\nf\ng\nh\n' };
const PORTED = { clean: 'b\nc\nd\nx\ne\nf\ng\n', conflict: 'b\nC\nd\ne\nf\ng\n' };

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
const landingGit = (cwd, args, { token, allowFail = false, raw = false, env = null } = {}) => {
  const r = spawnSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(env ?? {}) } });
  if (allowFail) return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stderr}`);
  return raw ? r.stdout : r.stdout.trim();
};

function fixture(t, { conflict = false, generatedConflict = false, regenerate = null, rework = false, resumed = false, unresolved = false, discardWork = false, failFetch = false, advanceDuringResolution = false, mergeJob = false, moved = null, failPort = false, noPort = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'atelier-runner-main-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main'), workspace = join(root, 'work');
  mkdirSync(main);
  git(main, 'init', '-qb', 'main');
  const base = commit(main, { 'shared.txt': 'base\n', ...(generatedConflict ? { 'gen.txt': 'base gen\n' } : {}), ...(moved ? { 'lib.txt': LIB } : {}) });
  git(root, 'clone', '-q', main, workspace);
  const prior = rework || resumed ? commit(workspace, { 'prior.txt': 'previous work\n' }) : base;
  const job = { project: 'atelier', actor, agent: 'codex', model: 'gpt-6-astra', item: {
    id: 't435', kind: 'task', title: 'build', scope: ['shared.txt', 'work.txt'], base, head: prior,
    ...(resumed ? { state: 'claimed', owner: actor, head: base } : {}),
  } };
  const calls = [], briefs = [], gitCalls = [], logs = [];
  let latest, harnessCalls = 0, finished = false, tokenCount = 0;
  const fetchedTokens = new Set();
  const advanceMain = () => { latest = commit(main, { [conflict ? 'shared.txt' : 'main.txt']: 'new main\n', ...(generatedConflict ? { 'gen.txt': 'gen from main\n' } : {}), ...(moved ? { 'lib.txt': LIB_ON_MAIN, 'moved.txt': MOVED_ON_MAIN } : {}) }); };
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
    // The builder's commit identity (t451): the policy allows it here.
    identityRefusals: async () => [],
    harness: async (argv, cwd) => {
      harnessCalls++;
      assert.deepEqual(argv, ['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', join(root, `brief-${briefs.length}`)]);
      assert.equal(cwd, workspace, 'resolution stays in the build workspace');
      const merging = existsSync(join(cwd, '.git', 'MERGE_HEAD'));
      if (moved && harnessCalls > 1) {
        // The builder ports the edit the brief names to the moved code and
        // takes it out of the source, which main emptied of that code; a
        // conflicted merge is committed as it stands, a clean one is already.
        assert.match(briefs.at(-1), /lib\.txt lines 2-7 moved to moved\.txt lines 1-6/);
        assert.equal(merging, moved === 'conflict', 'a clean merge is committed before the builder ports');
        if (failPort) return { code: 1 };
        if (noPort) {
          // Exit 0 without porting: the conflict is resolved to main's side
          // and committed, the clean merge is left as the runner committed
          // it, so the merge is complete and holds both heads, and the
          // moved code never got the edit.
          if (merging) {
            writeFileSync(join(cwd, 'lib.txt'), LIB_ON_MAIN);
            git(cwd, 'add', 'lib.txt');
            git(cwd, 'commit', '-q', '--no-edit');
          }
          return { code: 0 };
        }
        writeFileSync(join(cwd, 'moved.txt'), PORTED[moved]);
        writeFileSync(join(cwd, 'lib.txt'), LIB_ON_MAIN);
        git(cwd, 'add', 'moved.txt', 'lib.txt');
        if (merging) git(cwd, 'commit', '-q', '--no-edit');
        else git(cwd, 'commit', '-qm', `Port the edit to moved.txt\n\nAgent: ${actor}`);
      } else if (merging) {
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
        commit(cwd, { [conflict ? 'shared.txt' : 'work.txt']: 'work\n', ...(generatedConflict ? { 'gen.txt': 'gen from work\n' } : {}), ...(moved ? { 'lib.txt': EDITED[moved] } : {}) });
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

// The merge runs the landing's moved-code comparison (t471): an edit of the
// build's in code main moved to another file goes back to the same harness
// in the same run, with main merged first, cleanly or in conflict, and a
// brief naming the source and destination; the port is submitted merged.
for (const kind of ['clean', 'conflict']) test(`an edit in code main moved to another file goes back to the same harness to port, after a ${kind} merge of main`, async (t) => {
  const f = fixture(t, { moved: kind });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'submitted', JSON.stringify(state));
  assert.equal(state.mainHead, f.latest);
  assert.equal(state.head, git(f.workspace, 'rev-parse', 'HEAD'));
  assert.equal(f.harnessCalls, 2, 'the builder ports the edit in the same run');
  assert.equal(f.calls.filter((a) => a[0] === 'claim').length, 1);
  const brief = f.briefs[1];
  if (kind === 'clean') assert.match(brief, /## Port this task's edits to the code main moved\n\nThe runner has merged main at [0-9a-f]{8} into this workspace before you start, and committed the merge/);
  else assert.match(brief, /## Resolve the merge of main[\s\S]*### Port this task's edits to the code main moved\n\nBesides the conflicts/);
  assert.match(brief, kind === 'clean'
    ? /- lib\.txt lines 2-7 moved to moved\.txt lines 1-6: the task inserted 1 line between base lines 4 and 5 there \(its line 5 at the task's head\); 6 lines match/
    : /- lib\.txt lines 2-7 moved to moved\.txt lines 1-6: the task changed base line 3 there \(its line 3 at the task's head\); 6 lines match/);
  assert.match(brief, /Make each edit again at its destination/);
  assert.match(brief, kind === 'clean' ? /The workspace already holds main at [0-9a-f]{8}; no merge was left in progress/ : /left conflicts in this file:\n```\nlib\.txt\n```/);
  assert.match(brief, /Run each test command through the host slot wrapper/);
  // The port: the moved code holds the edit, the source holds what main has.
  assert.equal(readFileSync(join(f.workspace, 'moved.txt'), 'utf8'), PORTED[kind]);
  assert.equal(readFileSync(join(f.workspace, 'lib.txt'), 'utf8'), LIB_ON_MAIN);
  assert.equal(git(f.workspace, 'status', '--porcelain'), '');
  assert.equal(existsSync(join(f.workspace, '.git', 'MERGE_HEAD')), false);
  if (kind === 'clean') {
    assert.match(git(f.workspace, 'log', '-1', '--format=%B'), /^Port the edit to moved\.txt\n\nAgent: codex\/gpt-6-astra/);
    assert.match(git(f.workspace, 'log', '-1', '--format=%B', 'HEAD~1'), new RegExp(`^Merge main at ${f.latest.slice(0, 8)} into t435\\n\\nAgent: codex/gpt-6-astra$`));
  } else {
    assert.match(git(f.workspace, 'log', '-1', '--format=%B'), new RegExp(`^Merge main at ${f.latest.slice(0, 8)} into t435\\n\\nAgent: codex/gpt-6-astra\\n`));
  }
  assert.ok(f.logs.some((line) => /1 of the build's edits lies in code main moved to another file; codex\/gpt-6-astra (ports|resolves) them in this run$/.test(line)), f.logs.join('\n'));
  assert.ok(f.logs.some((line) => /lib\.txt lines 2-7 moved to moved\.txt lines 1-6/.test(line) && /ports each edit to its destination in this run/.test(line)), f.logs.join('\n'));
  // The workspace's moved-code log says the findings were handed to the
  // builder; main read again after the port is already merged, so nothing
  // is compared a second time.
  const records = readMovedCodeRecords(join(f.workspace, '.git'));
  assert.deepEqual(records.map((r) => r.kind), ['handed']);
  assert.equal(records[0].resolver, actor);
  assert.equal(records[0].findings.length, 1);
  assert.equal(records[0].main, f.latest);
  assert.equal(f.gitCalls.filter((args) => args[0] === 'fetch').length, 2, 'main is read again after the port');
  assert.ok(f.logs.some((line) => line === 'the port is verified: the edit is at its destination'), f.logs.join('\n'));
  assert.ok(f.finished);
  assert.deepEqual(finishSummary(f), ['--summary', `Built t435 with main at ${f.latest} merged`]);
});

// A harness exit is no evidence of the port: the comparison is made again
// after the harness and each edit is required at its destination, so a
// harness that exits 0 without porting ends failed, the model's failure,
// with nothing submitted — after a clean merge, which the runner committed
// and the harness left as it was, and after a conflicting one the harness
// resolved to main's side, so the merge is complete and holds both heads.
for (const kind of ['clean', 'conflict']) test(`a harness that exits 0 without porting the moved edit, after a ${kind} merge of main, is the model's failure and nothing is submitted`, async (t) => {
  const f = fixture(t, { moved: kind, noPort: true });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'failed', JSON.stringify(state));
  assert.match(state.reason, /^an edit of the build's in code main moved to another file was not ported to its destination: lib\.txt lines 2-7 moved to moved\.txt lines 1-6: the task /);
  assert.match(state.reason, /; moved\.txt at the build's head does not hold the moved code with the task's edit made$/);
  assert.equal(state.taskFailure, true);
  assert.equal(f.harnessCalls, 2);
  assert.equal(f.finished, false);
  // The merge itself was complete: the failure is the port's alone.
  assert.equal(existsSync(join(f.workspace, '.git', 'MERGE_HEAD')), false);
  assert.equal(git(f.workspace, 'merge-base', f.latest, 'HEAD'), f.latest);
  assert.equal(readFileSync(join(f.workspace, 'moved.txt'), 'utf8'), MOVED_ON_MAIN);
  assert.ok(!f.logs.some((line) => /the port is verified/.test(line)), f.logs.join('\n'));
});

test('a harness that fails to port the moved edit is the model\'s failure, like an unresolved conflict, and nothing is submitted', async (t) => {
  const f = fixture(t, { moved: 'clean', failPort: true });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'failed');
  assert.match(state.reason, /harness exited 1 resolving main/);
  assert.equal(state.taskFailure, true);
  assert.equal(f.harnessCalls, 2);
  assert.equal(f.finished, false);
});

test('a finding is not the model\'s failure: the comparison and the port count no failure of their own', async (t) => {
  const f = fixture(t, { moved: 'conflict' });
  const state = await runTask(f.job, config, 'home', f.io);
  assert.equal(state.phase, 'submitted', JSON.stringify(state));
  assert.equal(state.taskFailure, undefined);
  assert.equal(state.validationBlocked, undefined);
});
