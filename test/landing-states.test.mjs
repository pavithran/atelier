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
// committed: the merge commit is made and the journal names it. merge takes
//   the lease while the item is accepted at the journal's revision. merge
//   --cancel keeps the commit unless --discard-local, which ends any lease
//   and puts the branch back on the start while it is still on the commit
//   with nothing uncommitted.
// leased: as committed, and the server holds the lease, so no push or
//   review moves the acceptance. merge publishes. merge --cancel ends the
//   lease, which the server refuses once the merge is on the baseline.
// published: the baseline holds the merge commit (or, for a baseline that
//   holds part of the history, its rebuilt twin), and the journal says so
//   once the push returns. merge records the merge. merge --cancel refuses,
//   with or without --discard-local, and the checkout keeps the merge: it
//   reads the journal, and the baseline's whole history for a push that
//   returned just before the process stopped.
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
import { landingDir, landingJournalFile } from '../cli/landing.mjs';

// The owner's checkout, its baseline and a task's fork with the task's first
// revision, served by a stand-in ledger whose answers come from `box`: the
// item's state, head and accepted revision, the landing lease, and one-shot
// failures. With `fresh`, the baseline holds the checkout's history rebuilt
// from its last commit, as atelier init --history-since makes it.
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
  const box = { state: 'accepted', head: H1, acceptedHead: H1, lease: null, failLanding: false, failMerge: false, requests: [] };
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
  const journalFile = landingJournalFile(landingDir(cache, join(checkout, '.git')));
  const journal = () => (existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) : null);
  // Rewrite the journal as a process stopped at another step would have left it.
  const rewrite = (fields) => writeFileSync(journalFile, JSON.stringify({ ...journal(), ...fields }, null, 2) + '\n');
  const at = () => git(checkout, 'rev-parse', 'HEAD');
  const tip = () => git(p, '--git-dir', baseline, 'rev-parse', 'main');
  // Whether a request reached the server, by its path's end and, for the lease, whether it cancels.
  const asked = (end, cancel) => box.requests.some((r) => r.path.endsWith(end) && (cancel === undefined || (r.body.cancel === true) === cancel));
  return { p, git, baseline, fork, checkout, workspace, box, run, revise, H1, start, at, tip, journal, journalFile, rewrite, asked };
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
