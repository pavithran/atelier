import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import worker from '../src/index.ts';
const TOKEN = 'stuck-test-token';
const testEnv = { ...env, ATELIER_TOKEN: TOKEN };
async function project(name) {
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, 'owner');
  await env.LEDGER.get(env.LEDGER.idFromName('__index')).registerProject(record);
  return L;
}
function read(name, actor = 'owner', extra = {}, query = '') {
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}/stuck${query}`, {
    headers: { authorization: `Bearer ${TOKEN}`, 'x-atelier-actor': actor },
  }), { ...testEnv, ...extra });
}
it('the owner GET reads a real ledger snapshot without events, lease renewals or Workflow observations', async () => {
  const L = await project('stuck-read-only');
  const item = await L.newItem('A current claim', ['src/**'], 'owner');
  await L.claim(item.id, 'codex/model');
  await L.setLandingWorkflow(item.id, 'stuck-read-only-wf', 'owner');
  await L.beginProjectLanding(item.id, 'owner');
  const before = await L.stuckSnapshot();
  const response = await read('stuck-read-only', 'owner', { LANDING_WORKFLOW: { get: async () => ({ status: async () => ({ status: 'running' }) }) } });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.project).toBe('stuck-read-only');
  expect(body.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(body.unavailable).toEqual([]);
  expect(body.entries).toEqual([]);
  expect(await L.stuckSnapshot()).toEqual(before);
});
it('non-owner reads and nonpositive limits are refused', async () => {
  await project('stuck-owner');
  expect((await read('stuck-owner', 'codex/model')).status).toBe(403);
  const response = await read('stuck-owner', 'owner', {}, '?runnerPollMinutes=0');
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: 'bad_limit' });
});
it('a failed Workflow read is explicitly unavailable and never proof of an orphan', async () => {
  const L = await project('stuck-unavailable-workflow');
  const item = await L.newItem('A landing', ['src/**'], 'owner');
  await L.claim(item.id, 'codex/model');
  await L.setLandingWorkflow(item.id, 'unreadable-wf', 'owner');
  await L.beginProjectLanding(item.id, 'owner');
  const body = await (await read('stuck-unavailable-workflow', 'owner', { LANDING_WORKFLOW: { get: async () => { throw new Error('provider unavailable'); } } })).json();
  expect(body.unavailable).toContain('Workflow unreadable-wf: provider unavailable');
  expect(body.entries).toEqual([]);
  expect((await L.landingWorkflowOf(item.id)).lastStatus).toBeUndefined();
});
it('a failed ledger read returns incomplete observations, never a successful empty source', async () => {
  await project('stuck-unavailable-ledger');
  const unavailableId = env.LEDGER.idFromName('project:stuck-unavailable-ledger').toString();
  const namespace = {
    idFromName: name => env.LEDGER.idFromName(name),
    get: id => id.toString() === unavailableId ? { stuckSnapshot: async () => { throw new Error('ledger unavailable'); } } : env.LEDGER.get(id),
  };
  const response = await read('stuck-unavailable-ledger', 'owner', { LEDGER: namespace });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.unavailable).toContain('project ledger: ledger unavailable');
  expect(body.complete).toBe(false);
  expect(body.failedChecksLastDay).toBeNull();
  expect(body.observedAt).toBeTruthy();
  expect(body.limits.noPushHours).toBe(6);
});
it('a runner working in another project is not idle despite an old coarsened offer', async () => {
  const selected = await project('stuck-selected');
  const waiting = await selected.newItem('Waiting for a runner', ['cli/**'], 'owner');
  await selected.dispatch(waiting.id, 'owner', { to: 'home', agent: 'codex', model: 'model' });
  const other = await project('stuck-other-active');
  const job = await other.newItem('Active elsewhere', ['src/**'], 'owner');
  await other.dispatch(job.id, 'owner', { to: 'home', agent: 'codex', model: 'model' });
  await other.claim(job.id, 'codex/model', { runner: 'home:busy', kind: 'home' });
  const I = env.LEDGER.get(env.LEDGER.idFromName('__index'));
  await I.askQueue({ runner: 'home:busy', kind: 'home', agents: [{ agent: 'codex', models: ['model'] }] }, new Date(Date.now() - 600000).toISOString());
  const active = await (await read('stuck-selected')).json();
  expect(active.entries.some(e => e.kind === 'idle-runner' && e.subject === 'home:busy')).toBe(false);
  await other.release(job.id, 'owner', 'Done with this attempt');
  const idle = await (await read('stuck-selected')).json();
  expect(idle.entries.some(e => e.kind === 'idle-runner' && e.subject === 'home:busy')).toBe(true);
});
