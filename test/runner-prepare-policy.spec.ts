import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import worker from '../src/index.ts';

it('a project-scoped runner reads the preparation policy through the project route before claiming', async () => {
  const owner = 'preparation-policy-owner';
  const name = 'runner-preparation-policy';
  const command = 'npm ci --prefer-offline --no-audit --no-fund && npm run types';
  const prepare = {
    command,
    declaration: { command, by: 'command' as const },
    inputs: ['package.json', 'package-lock.json', 'wrangler.jsonc'],
    outputs: ['node_modules', 'worker-configuration.d.ts'],
  };
  const project = { name, repo: name, policy: { checks: [], protected: [], prepare }, createdAt: new Date().toISOString() };
  await env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`)).setProject(project, 'owner');
  await env.LEDGER.get(env.LEDGER.idFromName('__index')).registerProject(project);
  const bindings = { ...env, ATELIER_TOKEN: owner };
  const issued = await worker.fetch(new Request('https://atelier.test/api/tokens', {
    method: 'POST',
    headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json', 'x-atelier-actor': 'owner' },
    body: JSON.stringify({ runner: 'home:prepare', projects: [name] }),
  }), bindings);
  expect(issued.status).toBe(201);
  const { token } = await issued.json() as { token: string };
  const read = (projectName: string) => worker.fetch(new Request(`https://atelier.test/api/projects/${projectName}`, {
    headers: { authorization: `Bearer ${token}`, 'x-atelier-actor': 'codex/gpt-6-astra', 'x-atelier-runner': 'home:prepare' },
  }), bindings);
  const response = await read(name);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ project: { policy: { prepare } }, items: [], events: [] });
  expect((await read('another-project')).status).toBe(403);
});
