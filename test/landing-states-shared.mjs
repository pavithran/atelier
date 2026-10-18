// What the parts of landing-states.test.mjs share (t771); the tests were split across files so none runs for more than about a minute.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildHistory, savePairs } from '../cli/fresh.mjs';
import { landingDir, landingJournal, landingJournalFile } from '../cli/landing.mjs';
import { SERVER_CAPABILITIES } from '../src/route-level.ts';
export async function landing(t, { fresh = false } = {}) {
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
  const box = { state: 'accepted', head: H1, acceptedHead: H1, lease: null, gate: null, withdraw: false, failLanding: false, failMerge: false, failItemAfterMerge: false, requests: [] };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {}, path = new URL(req.url, 'http://x').pathname;
    const reply = (status, answer) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer)); };
    // merge checks the server's capabilities first (t458).
    if (path === '/api/version') return reply(200, { capabilities: SERVER_CAPABILITIES });
    box.requests.push({ method: req.method, path, body });
    const item = () => ({ id: 't1', title: 'Fixture task', state: box.state, owner: 'codex/test', head: box.head, acceptedHead: box.acceptedHead });
    // A ledger that stops answering once the merge is recorded (t561).
    if (path === '/api/projects/proj/items/t1' && req.method === 'GET' && box.failItemAfterMerge && box.state === 'merged') return reply(503, { error: 'temporary', detail: 'ledger down' });
    if (path === '/api/projects/proj/items/t1' && req.method === 'GET') return reply(200, { item: item(), policy: { checks: [], protected: [], commitIdentity: { name: 'Fixture', email: 'fixture@example.invalid', agentEmails: [] } }, gate: { ready: true, outOfScope: [], blockers: [] }, evidence: [], reviews: [], events: [] });
    if (path.endsWith('/baseline-token')) return reply(200, { remote: baseline, token: 'fixture', defaultBranch: 'main' });
    if (path.endsWith('/read-token')) return reply(200, { remote: fork, token: 'fixture', head: box.head, defaultBranch: 'main' });
    // The stand-in lets every cancel through, so what refuses one here is the CLI.
    if (path.endsWith('/landing') && body.cancel === true) { box.lease = null; return reply(200, item()); }
    if (path.endsWith('/landing')) {
      if (box.gate) { const gate = box.gate; box.gate = null; await gate; }
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
  // The accepted revision merged into the baseline from another clone, as a landing made elsewhere would.
  const mergeElsewhere = () => {
    const other = join(p, 'other');
    git(p, 'clone', '-q', baseline, other);
    git(other, 'fetch', '-q', fork, box.acceptedHead);
    git(other, 'merge', '-q', '--no-ff', '-m', 'Merge t1 elsewhere', box.acceptedHead);
    git(other, 'push', '-q', 'origin', 'main');
    return git(other, 'rev-parse', 'HEAD');
  };
  return { p, cache, git, baseline, fork, checkout, workspace, box, run, revise, H1, start, at, tip, journal, journalFile, rewrite, asked, begin, dir, mergeElsewhere };
}
export function assertRestored(f) {
  assert.equal(f.at(), f.start);
  assert.equal(f.git(f.checkout, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.ok(!existsSync(join(f.checkout, '.git', 'MERGE_HEAD')), 'MERGE_HEAD');
  assert.equal(f.journal(), null);
}
