// The states of a landing, and the way out of each. `atelier merge ID`
// lands an accepted task in the owner's checkout: it writes a journal under
// the CLI's cache (cli/landing.mjs), merges and commits in the checkout,
// takes the landing lease on the server, publishes the merge commit to the
// baseline, and records the merge. Each state says what is true in the
// checkout and on the server, and what each command does from it.
//
// none: no journal. merge starts a landing. merge --cancel ends any lease
//   the item holds. sync and wrap go ahead.
// prepared: the journal names the accepted revision, the commit the merge
//   starts from and the baseline's head; the checkout is on that start. The
//   item is accepted at the revision, with no lease. merge goes on; merge
//   --cancel removes the journal and ends any lease; sync and wrap refuse.
// merging: stopped inside the Git merge, which is in progress on the start
//   with the accepted revision's tree incoming. merge refuses the
//   uncommitted changes. merge --cancel keeps the Git merge unless
//   --discard-local, which aborts it.
// committed: the merge commit is made and the journal names it, or the
//   process stopped first and the commit is found by its parents and its
//   line `Atelier: PROJECT/ID accepted at REVISION`. Until the lease is
//   taken, a push or a review on the server can withdraw the acceptance,
//   and another revision can then be accepted. merge takes the lease while
//   the item is accepted at the journal's revision, and otherwise refuses,
//   naming the cancel. merge --cancel keeps the commit unless
//   --discard-local, which puts the branch back on the start while it is
//   still on the commit with nothing uncommitted, and otherwise changes
//   nothing and says how to get there; a branch already back on the start
//   needs no flag. It ends the lease only while the item is accepted at the
//   journal's revision: a lease is taken for the accepted revision alone and
//   nothing moves the acceptance while one is held, so after a change of
//   acceptance there is no lease of this landing's to end.
// leased: as committed, and the server holds the lease, so no push or
//   review moves the acceptance. merge publishes. merge --cancel ends the
//   lease, which the server refuses once the merge is on the baseline.
// published: the baseline holds the merge commit (or, for a baseline that
//   holds part of the history, its rebuilt twin), and the journal says so
//   once the push returns. merge records the merge, with the branch on the
//   merge commit, and otherwise names the commit to put it back on. merge
//   --cancel refuses, with or without --discard-local, and the checkout
//   keeps the merge: it reads the journal, and the baseline's whole history
//   for a push that returned just before the process stopped. When the item
//   is no longer accepted at the journal's revision, so that the server
//   cannot record the merge, merge --cancel removes the journal and keeps the
//   merge, as the baseline does.
// recorded: the server says merged, and the journal is still there. merge
//   and merge --cancel remove the journal and keep the merge.
//
// Every test runs the real CLI against a stand-in ledger on 127.0.0.1, in
// scratch repositories, and leaves the landing in one of these states the
// way an interrupted process or a change on the server would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildHistory, savePairs } from '../cli/fresh.mjs';
import { landingDir, landingJournal, landingJournalFile } from '../cli/landing.mjs';

// The owner's checkout, its baseline and a task's fork with the task's first
// revision, served by a stand-in ledger whose answers come from `box`: the
// item's state, head and accepted revision, the landing lease, and one-shot
// failures. `withdraw` makes the next lease request find the acceptance
// withdrawn by a push, as the server's recordPush does in that window. With
// `fresh`, the baseline holds the checkout's history rebuilt from its last
// commit, as atelier init --history-since makes it.
async function landing(t, { fresh = false } = {}) {
  const p = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-states-')));
  t.after(() => rmSync(p, { recursive: true, force: true }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), HOME: join(p, 'home'), GIT_CONFIG_GLOBAL: join(p, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  mkdirSync(env.HOME);
  writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[init]\n\tdefaultBranch = main\n');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const checkout = join(p, 'checkout'), baseline = join(p, 'baseline.git'), fork = join(p, 'fork.git'), workspace = join(p, 'workspace'), config = join(p, 'config'), cache = join(p, 'cache');
  mkdirSync(checkout); mkdirSync(config);
  git(checkout, 'init', '-q');
  writeFileSync(join(checkout, 'work.txt'), 'base\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-q', '-m', 'Initial');
  const start = git(checkout, 'rev-parse', 'HEAD');
  if (fresh) {
    const built = buildHistory((args, { cwd }) => git(cwd, ...args), checkout, start, start);
    savePairs(join(checkout, '.git'), 'proj', built.pairs);
    git(p, 'init', '-q', '--bare', baseline);
    git(checkout, 'push', '-q', baseline, `${built.head}:refs/heads/main`);
  } else git(p, 'clone', '-q', '--bare', checkout, baseline);
  git(p, 'clone', '-q', '--bare', baseline, fork); git(p, 'clone', '-q', fork, workspace);
  // A new revision of the task, pushed to its fork.
  const revise = (text) => { writeFileSync(join(workspace, 'work.txt'), text); git(workspace, 'commit', '-q', '-am', `Task: ${text.trim()}`); git(workspace, 'push', '-q', 'origin', 'main'); return git(workspace, 'rev-parse', 'HEAD'); };
  const H1 = revise('changed\n');
  const box = { state: 'accepted', head: H1, acceptedHead: H1, lease: null, withdraw: false, failLanding: false, failMerge: false, requests: [] };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {}, path = new URL(req.url, 'http://x').pathname;
    box.requests.push({ method: req.method, path, body });
    const reply = (status, answer) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer)); };
    const item = () => ({ id: 't1', title: 'Fixture task', state: box.state, owner: 'codex/test', head: box.head, acceptedHead: box.acceptedHead });
    if (path === '/api/projects/proj/items/t1' && req.method === 'GET') return reply(200, { item: item(), policy: { checks: [], protected: [] }, gate: { ready: true, outOfScope: [], blockers: [] }, evidence: [], reviews: [], events: [] });
    if (path.endsWith('/baseline-token')) return reply(200, { remote: baseline, token: 'fixture', defaultBranch: 'main' });
    if (path.endsWith('/read-token')) return reply(200, { remote: fork, token: 'fixture', head: box.head, defaultBranch: 'main' });
    // The stand-in lets every cancel through, so what refuses one here is the CLI.
    if (path.endsWith('/landing') && body.cancel === true) { box.lease = null; return reply(200, item()); }
    if (path.endsWith('/landing')) {
      if (box.withdraw) { box.withdraw = false; box.state = 'claimed'; box.acceptedHead = null; }
      if (box.failLanding) { box.failLanding = false; return reply(503, { error: 'temporary', detail: 'retry' }); }
      if (box.state !== 'accepted' || box.acceptedHead !== body.head) return reply(409, { error: 'acceptance_changed', detail: `t1 is no longer accepted at ${String(body.head).slice(0, 8)}; review it again before merging` });
      box.lease = body.head;
      return reply(200, item());
    }
    if (path.endsWith('/merged')) {
      if (box.failMerge) { box.failMerge = false; return reply(503, { error: 'temporary', detail: 'retry' }); }
      box.state = 'merged'; box.lease = null;
      return reply(200, item());
    }
    return reply(404, { error: 'not_found', detail: `${req.method} ${path}` });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(config, 'config.json'), JSON.stringify({ server: url, owner: 'owner', projects: { proj: { path: checkout, branch: 'main', ...(fresh ? { fresh: true } : {}) } } }));
  const run = async (...args) => {
    const child = spawn(process.execPath, [resolve('cli/atelier.mjs'), ...args, '--project', 'proj'], { cwd: checkout, env: { ...env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: 'fixture', ATELIER_CACHE: cache, ATELIER_SERVER: url } });
    let output = '';
    child.stdout.on('data', (s) => { output += s; });
    child.stderr.on('data', (s) => { output += s; });
    const status = await new Promise((ok) => child.on('close', ok));
    return { status, output };
  };
  const dir = landingDir(cache, join(checkout, '.git')), journalFile = landingJournalFile(dir);
  const journal = () => (existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) : null);
  // Rewrite the journal as a process stopped at another step would have left it.
  const rewrite = (fields) => writeFileSync(journalFile, JSON.stringify({ ...journal(), ...fields }, null, 2) + '\n');
  const at = () => git(checkout, 'rev-parse', 'HEAD');
  const tip = () => git(p, '--git-dir', baseline, 'rev-parse', 'main');
  // Whether a request reached the server, by its path's end and, for the lease, whether it cancels.
  const asked = (end, cancel) => box.requests.some((r) => r.path.endsWith(end) && (cancel === undefined || (r.body.cancel === true) === cancel));
  // A journal for t1 at a revision, as the merge saves it before it touches the checkout.
  const begin = (head) => landingJournal(dir, { project: 'proj', item: 't1', head }).save({ start: at(), phase: 'prepared', baselineStart: tip() });
  return { p, git, baseline, fork, checkout, workspace, box, run, revise, H1, start, at, tip, journal, journalFile, rewrite, asked, begin };
}

// ── a merge on the baseline ─────────────────────────────────────────────────

// The merge is pushed and the server fails to record it: the journal says
// published. A cancel, with or without --discard-local, refuses and keeps
// the checkout on the merge, whatever the server would allow. The same holds
// when the process stopped after the push returned and before the journal
// said so: the merge commit is found in the baseline's history. merge then
// records the merge.
for (const fresh of [false, true]) {
  test(`a published merge is never cancelled, and merge records it${fresh ? ', on a baseline that holds part of the history' : ''}`, async (t) => {
    const f = await landing(t, { fresh });
    f.box.failMerge = true;
    const first = await f.run('merge', 't1');
    assert.equal(first.status, 4, first.output);
    const merged = f.at();
    assert.equal(f.journal().phase, 'published');
    // A baseline with part of the history holds the merge's rebuilt twin.
    const sent = f.tip();
    if (fresh) assert.notEqual(sent, merged); else assert.equal(sent, merged);
    const refusal = `t1's merge ${sent.slice(0, 8)} is already on the baseline, so the landing cannot be cancelled, and the checkout keeps it.\nRecord the merge with: atelier merge t1\n`;

    for (const step of ['committed', 'published']) {
      f.rewrite({ phase: step });
      for (const flags of [['--discard-local'], []]) {
        f.box.requests.length = 0;
        const cancel = await f.run('merge', 't1', '--cancel', ...flags);
        assert.equal(cancel.status, 1, `${step} ${flags}: ${cancel.output}`);
        assert.ok(cancel.output.includes(refusal), cancel.output);
        assert.equal(f.at(), merged);
        assert.equal(f.journal().phase, step);
        assert.ok(!f.asked('/landing', true), 'the lease stays');
      }
    }

    const recorded = await f.run('merge', 't1');
    assert.equal(recorded.status, 0, recorded.output);
    assert.equal(f.box.state, 'merged');
    assert.equal(f.at(), merged);
    assert.equal(f.tip(), sent);
    assert.equal(f.journal(), null);
  });
}

// The server recorded the merge and the process stopped before it removed
// the journal. merge --cancel removes it and keeps the merge.
test('a recorded merge whose journal is left: cancel removes the journal and keeps the merge', async (t) => {
  const f = await landing(t);
  f.box.failMerge = true;
  assert.equal((await f.run('merge', 't1')).status, 4);
  const left = readFileSync(f.journalFile, 'utf8'), merged = f.at();
  assert.equal((await f.run('merge', 't1')).status, 0);
  writeFileSync(f.journalFile, left);
  f.box.requests.length = 0;
  const cancel = await f.run('merge', 't1', '--cancel', '--discard-local');
  assert.equal(cancel.status, 0, cancel.output);
  assert.equal(cancel.output, `t1 is already merged as ${merged.slice(0, 8)}. The landing journal is removed; the checkout keeps the merge.\n`);
  assert.equal(f.at(), merged);
  assert.equal(f.journal(), null);
  assert.ok(!f.asked('/landing'));
});

// A merge commit that never reached the baseline is still cancelled: the
// lease ends and the checkout goes back to the start.
test('an unpublished merge is cancelled after the baseline is read', async (t) => {
  const f = await landing(t);
  f.box.failLanding = true;
  assert.equal((await f.run('merge', 't1')).status, 4);
  assert.equal(f.journal().phase, 'committed');
  f.box.requests.length = 0;
  const kept = await f.run('merge', 't1', '--cancel');
  assert.equal(kept.status, 1, kept.output);
  assert.match(kept.output, /the checkout holds this merge's unpublished commit/);
  const cancelled = await f.run('merge', 't1', '--cancel', '--discard-local');
  assert.equal(cancelled.status, 0, cancelled.output);
  assert.equal(f.at(), f.start);
  assert.equal(f.journal(), null);
  assert.ok(f.asked('/baseline-token') && f.asked('/landing', true));
});

// The checkout as the merge found it: on its start, with nothing uncommitted and no Git merge in progress.
function assertRestored(f) {
  assert.equal(f.at(), f.start);
  assert.equal(f.git(f.checkout, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.ok(!existsSync(join(f.checkout, '.git', 'MERGE_HEAD')), 'MERGE_HEAD');
  assert.equal(f.journal(), null);
}

// A merge pushed and not recorded, whose checkout the owner moved back to
// the start by hand. Cancel still refuses and says which commit the branch
// needs; merge names it too, and records the merge once the branch is back.
test('a published merge with the branch moved off it: cancel and merge name the commit to put it back on', async (t) => {
  const f = await landing(t);
  f.box.failMerge = true;
  assert.equal((await f.run('merge', 't1')).status, 4);
  const merged = f.at();
  f.git(f.checkout, 'reset', '-q', '--hard', f.start);
  const cancel = await f.run('merge', 't1', '--cancel', '--discard-local');
  assert.equal(cancel.status, 1, cancel.output);
  assert.ok(cancel.output.includes(`t1's merge ${merged.slice(0, 8)} is already on the baseline, so the landing cannot be cancelled, and the checkout keeps it.\nRecord the merge with: atelier merge t1\nmain no longer holds the merge commit ${merged.slice(0, 8)}; put it back on that commit before the next merge.\n`), cancel.output);
  const retry = await f.run('merge', 't1');
  assert.equal(retry.status, 1, retry.output);
  assert.ok(retry.output.includes(`the checkout moved after the merge: main is at ${f.start.slice(0, 8)}, not at the merge commit ${merged.slice(0, 8)}. Put main back on ${merged.slice(0, 8)}, moving any commits of yours off it, then run atelier merge t1 again, or cancel the landing with: atelier merge t1 --cancel\n`), retry.output);
  f.git(f.checkout, 'merge', '-q', '--ff-only', merged);
  const recorded = await f.run('merge', 't1');
  assert.equal(recorded.status, 0, recorded.output);
  assert.equal(f.box.state, 'merged');
  assert.equal(f.journal(), null);
});

// The merge is pushed, and the task is abandoned before the merge is
// recorded, which the server allows under a lease: the merge can no longer
// be recorded. merge refuses the landing and names the cancel, which removes
// the journal and keeps the merge, as the baseline does.
test('a published merge the server can no longer record: cancel removes the journal and keeps the merge', async (t) => {
  const f = await landing(t);
  f.box.failMerge = true;
  assert.equal((await f.run('merge', 't1')).status, 4);
  const merged = f.at();
  f.box.state = 'abandoned';
  const retry = await f.run('merge', 't1');
  assert.equal(retry.status, 1, retry.output);
  assert.ok(retry.output.includes(`t1 is abandoned, no longer accepted at ${f.H1.slice(0, 8)}, where this checkout began landing it, so that landing cannot be finished. Cancel it with: atelier merge t1 --cancel --discard-local\n`), retry.output);
  f.box.requests.length = 0;
  const cancel = await f.run('merge', 't1', '--cancel', '--discard-local');
  assert.equal(cancel.status, 0, cancel.output);
  assert.equal(cancel.output, `t1's merge ${merged.slice(0, 8)} is on the baseline, but t1 is abandoned, so Atelier cannot record it. The landing journal is removed; the checkout keeps the merge, as the baseline does.\n`);
  assert.equal(f.at(), merged);
  assert.equal(f.tip(), merged);
  assert.equal(f.journal(), null);
  assert.ok(!f.asked('/landing'));
});

// ── an acceptance that moves after the merge commit ─────────────────────────

// A push lands between the merge commit and the lease, and withdraws the
// acceptance. The landing cannot be finished, and both merge and merge
// --cancel name the way out, which restores the checkout and leaves the
// server alone: there is no lease of this landing's to end.
test('an acceptance withdrawn before the lease: merge and cancel say so, and cancel --discard-local restores the checkout', async (t) => {
  const f = await landing(t);
  f.box.withdraw = true;
  const first = await f.run('merge', 't1');
  assert.equal(first.status, 1, first.output);
  assert.match(first.output, /acceptance_changed/);
  const merged = f.at();
  assert.notEqual(merged, f.start);
  assert.equal(f.journal().phase, 'committed');
  assert.equal(f.journal().mergeCommit, merged);

  f.box.requests.length = 0;
  const retry = await f.run('merge', 't1');
  assert.equal(retry.status, 1, retry.output);
  assert.ok(retry.output.includes(`t1 is claimed, no longer accepted at ${f.H1.slice(0, 8)}, where this checkout began landing it, so that landing cannot be finished. Cancel it with: atelier merge t1 --cancel --discard-local\n`), retry.output);
  assert.ok(!f.asked('/baseline-token'), 'the refusal comes before the landing reads the baseline');

  const kept = await f.run('merge', 't1', '--cancel');
  assert.equal(kept.status, 1, kept.output);
  assert.ok(kept.output.includes(`t1 is claimed, no longer accepted at ${f.H1.slice(0, 8)}, the revision this landing merged, so the landing cannot be finished. The checkout holds this merge's unpublished commit ${merged.slice(0, 8)} on top of ${f.start.slice(0, 8)}.\nRemove it with: atelier merge t1 --cancel --discard-local\n`), kept.output);
  assert.equal(f.at(), merged);
  assert.equal(f.journal().mergeCommit, merged);

  const cancelled = await f.run('merge', 't1', '--cancel', '--discard-local');
  assert.equal(cancelled.status, 0, cancelled.output);
  assert.match(cancelled.output, /Removed the unpublished merge commit; main is back at /);
  assert.match(cancelled.output, /t1: the landing in this checkout is cancelled\. t1 is claimed, and nothing changed on the server\.\n$/);
  assertRestored(f);
  assert.ok(!f.asked('/landing', true), 'no lease of this landing is cancelled');
});

// The acceptance is withdrawn as above, then the task's owner pushes a new
// revision and it is accepted. The journal from before the reopen names the
// earlier revision: merge refuses it and names the cancel; the owner has
// put the checkout back by hand, so a plain cancel removes the journal and
// leaves the new revision's lease alone; the new revision then lands.
test('a journal from before a reopen: merge names the cancel, which leaves the new acceptance alone, and the new revision lands', async (t) => {
  const f = await landing(t);
  f.box.withdraw = true;
  assert.equal((await f.run('merge', 't1')).status, 1);
  const merged = f.at();
  const H2 = f.revise('changed again\n');
  Object.assign(f.box, { state: 'accepted', head: H2, acceptedHead: H2, lease: H2 });

  const retry = await f.run('merge', 't1');
  assert.equal(retry.status, 1, retry.output);
  assert.ok(retry.output.includes(`t1 is accepted at ${H2.slice(0, 8)}, no longer accepted at ${f.H1.slice(0, 8)}, where this checkout began landing it, so that landing cannot be finished. Cancel it with: atelier merge t1 --cancel --discard-local, then merge again\n`), retry.output);
  assert.equal(f.at(), merged);

  // The owner already put the branch back on the start by hand: nothing is left to discard.
  f.git(f.checkout, 'reset', '-q', '--hard', f.start);
  f.box.requests.length = 0;
  const cancelled = await f.run('merge', 't1', '--cancel');
  assert.equal(cancelled.status, 0, cancelled.output);
  assert.equal(cancelled.output, `t1: the landing in this checkout is cancelled. t1 is accepted at ${H2.slice(0, 8)}, and nothing changed on the server; merge its accepted revision with: atelier merge t1.\n`);
  assertRestored(f);
  assert.ok(!f.asked('/landing', true), 'the lease is the new revision\'s, not this landing\'s');
  assert.equal(f.box.lease, H2);

  f.box.lease = null;
  const landed = await f.run('merge', 't1');
  assert.equal(landed.status, 0, landed.output);
  assert.equal(f.box.state, 'merged');
  assert.equal(f.tip(), f.at());
  assert.deepEqual(f.git(f.checkout, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1), [f.start, H2]);
});

// ── a landing stopped between two of its steps ──────────────────────────────

// The process stopped after the journal was written and before the Git
// merge began. The checkout is on the start. merge goes on from the
// journal; a cancel removes it and ends the lease. A journal of another task
// holds both back and names the commands that end it.
test('stopped before the Git merge: merge goes on, cancel ends it, and another task\'s journal names its way out', async (t) => {
  const f = await landing(t);
  f.begin(f.H1);
  const cancelled = await f.run('merge', 't1', '--cancel');
  assert.equal(cancelled.status, 0, cancelled.output);
  assert.equal(cancelled.output, 't1: the merge is cancelled; its owner can push a new revision.\n');
  assertRestored(f);
  assert.ok(f.asked('/landing', true));

  f.begin(f.H1);
  const landed = await f.run('merge', 't1');
  assert.equal(landed.status, 0, landed.output);
  assert.equal(f.box.state, 'merged');
  assert.equal(f.tip(), f.at());
  assert.equal(f.journal(), null);

  writeFileSync(f.journalFile, JSON.stringify({ project: 'proj', item: 't2', head: f.H1, start: f.at(), phase: 'prepared' }) + '\n');
  f.box.requests.length = 0;
  for (const args of [['merge', 't1'], ['merge', 't1', '--cancel']]) {
    const other = await f.run(...args);
    assert.equal(other.status, 1, other.output);
    assert.ok(other.output.includes('finish the pending landing for proj/t2 before starting another: atelier merge t2 --project proj, or cancel it with atelier merge t2 --project proj --cancel\n'), other.output);
  }
  assert.ok(!f.asked('/landing'));
});


// The process stopped inside `git merge --no-commit`: the Git merge is in
// progress on the start. merge refuses the uncommitted changes, as before;
// cancel keeps them unless asked, then aborts the Git merge and ends the
// lease, since the item is still accepted at the journal's revision.
test('stopped inside the Git merge: cancel keeps it unless asked, then aborts it', async (t) => {
  const f = await landing(t);
  f.begin(f.H1);
  f.git(f.checkout, 'fetch', '-q', f.fork, f.H1);
  f.git(f.checkout, 'merge', '-q', '--no-ff', '--no-commit', f.H1);
  assert.ok(existsSync(join(f.checkout, '.git', 'MERGE_HEAD')));

  const retry = await f.run('merge', 't1');
  assert.equal(retry.status, 1, retry.output);
  assert.match(retry.output, /the registered checkout has uncommitted changes/);

  const kept = await f.run('merge', 't1', '--cancel');
  assert.equal(kept.status, 1, kept.output);
  assert.ok(kept.output.includes(`the checkout holds this merge's unfinished Git merge of ${f.H1.slice(0, 8)} on ${f.start.slice(0, 8)}.\nAbort it with git merge --abort, then finish the landing with: atelier merge t1\nor cancel and remove it with: atelier merge t1 --cancel --discard-local\n`), kept.output);
  assert.ok(existsSync(join(f.checkout, '.git', 'MERGE_HEAD')));
  assert.ok(f.journal());

  const cancelled = await f.run('merge', 't1', '--cancel', '--discard-local');
  assert.equal(cancelled.status, 0, cancelled.output);
  assert.match(cancelled.output, /Aborted the unfinished Git merge; main is at [0-9a-f]{8}, where the merge began\.\n/);
  assert.match(cancelled.output, /t1: the merge is cancelled; its owner can push a new revision\./);
  assertRestored(f);
  assert.ok(f.asked('/landing', true));
});

// The process stopped after `git commit` and before the journal named the
// commit. Cancel finds it by its parents and its landing line and keeps it
// unless asked. A branch moved past it, or uncommitted changes on it, are
// left as they are, with what to do; once the branch is back on it, cancel
// --discard-local restores the start.
test('stopped after the merge commit, before the journal named it: cancel finds the commit and never resets past the owner\'s work', async (t) => {
  const f = await landing(t);
  f.begin(f.H1);
  f.git(f.checkout, 'fetch', '-q', f.fork, f.H1);
  f.git(f.checkout, 'merge', '-q', '--no-ff', '-m', 'Merge t1: Fixture task', '-m', `Atelier: proj/t1 accepted at ${f.H1}`, f.H1);
  const merged = f.at();
  assert.equal(f.journal().mergeCommit, undefined);

  const kept = await f.run('merge', 't1', '--cancel');
  assert.equal(kept.status, 1, kept.output);
  assert.ok(kept.output.includes(`the checkout holds this merge's unpublished commit ${merged.slice(0, 8)} on top of ${f.start.slice(0, 8)}.\nFinish it with: atelier merge t1\n`), kept.output);
  assert.ok(f.journal());

  // The owner committed on top of the merge commit.
  writeFileSync(join(f.checkout, 'mine.txt'), 'mine\n');
  f.git(f.checkout, 'add', 'mine.txt'); f.git(f.checkout, 'commit', '-q', '-m', 'Mine');
  const mine = f.at();
  f.box.requests.length = 0;
  const moved = await f.run('merge', 't1', '--cancel', '--discard-local');
  assert.equal(moved.status, 1, moved.output);
  assert.ok(moved.output.includes(`main moved since the merge: it is at ${mine.slice(0, 8)}, past the merge commit ${merged.slice(0, 8)}. Nothing was changed. Move your commits off it and put main back on ${merged.slice(0, 8)}, or on ${f.start.slice(0, 8)} where the merge began, then run: atelier merge t1 --cancel --discard-local\n`), moved.output);
  assert.equal(f.at(), mine);
  assert.ok(f.journal());
  assert.ok(!f.asked('/landing', true), 'a refusal ends nothing on the server');

  // Back on the merge commit, with a change not committed.
  f.git(f.checkout, 'reset', '-q', '--hard', merged);
  writeFileSync(join(f.checkout, 'work.txt'), 'unsaved\n');
  const dirty = await f.run('merge', 't1', '--cancel', '--discard-local');
  assert.equal(dirty.status, 1, dirty.output);
  assert.ok(dirty.output.includes(`the checkout has uncommitted changes on top of the merge commit ${merged.slice(0, 8)}. Nothing was changed. Set them aside (git stash), then run: atelier merge t1 --cancel --discard-local\n`), dirty.output);
  assert.equal(readFileSync(join(f.checkout, 'work.txt'), 'utf8'), 'unsaved\n');

  f.git(f.checkout, 'checkout', '-q', '--', 'work.txt');
  const cancelled = await f.run('merge', 't1', '--cancel', '--discard-local');
  assert.equal(cancelled.status, 0, cancelled.output);
  assertRestored(f);
  assert.ok(f.asked('/landing', true));
});

// The same stop, and the merge goes on from the commit it finds.
test('stopped after the merge commit, before the journal named it: merge goes on from that commit', async (t) => {
  const f = await landing(t);
  f.begin(f.H1);
  f.git(f.checkout, 'fetch', '-q', f.fork, f.H1);
  f.git(f.checkout, 'merge', '-q', '--no-ff', '-m', 'Merge t1: Fixture task', '-m', `Atelier: proj/t1 accepted at ${f.H1}`, f.H1);
  const merged = f.at();
  const landed = await f.run('merge', 't1');
  assert.equal(landed.status, 0, landed.output);
  assert.equal(f.at(), merged);
  assert.equal(f.tip(), merged);
  assert.equal(f.box.state, 'merged');
  assert.equal(f.journal(), null);
});
