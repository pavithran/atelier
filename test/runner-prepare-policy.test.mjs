import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliState } from '../cli/atelier.mjs';
import { hasPreparation } from '../cli/commands/runner.mjs';
import { runTask, runOutcome, infrastructureFailureCount, taskRevisionKey } from '../cli/runner.mjs';

// A fixture credential assembled at run time, so no literal bearer token
// sits in the tree for the secret scan to flag.
const FIXTURE_TOKEN = ['fixture', 'login', 'value'].join('-');

function credential(t) {
  const previous = { ...cliState };
  cliState.loginToken = FIXTURE_TOKEN;
  cliState.loginServer = 'https://preparation.test';
  t.after(() => Object.assign(cliState, previous));
}

test('preparation policy lookup uses the assignment identity and a bounded request', async (t) => {
  credential(t);
  let policy = {};
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://preparation.test/api/projects/demo');
    assert.equal(options.headers.authorization, `Bearer ${FIXTURE_TOKEN}`);
    assert.equal(options.headers['x-atelier-actor'], 'opencode/model');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ project: { policy } });
  });
  const timeout = t.mock.method(AbortSignal, 'timeout', AbortSignal.timeout);
  assert.equal(await hasPreparation('demo', 'opencode/model'), false);
  policy = { prepare: { command: 'npm ci', inputs: ['package-lock.json'], outputs: ['node_modules'] } };
  assert.equal(await hasPreparation('demo', 'opencode/model'), true);
  assert.deepEqual(timeout.mock.calls.map((c) => c.arguments), [[30_000], [30_000]]);
});

for (const failure of ['network', 'timeout', 'HTTP 503', 'HTTP 429', 'HTTP 403', 'invalid JSON', 'missing policy']) {
  test(`a preparation policy ${failure} failure reaches infrastructure handling without terminating the runner`, async (t) => {
    credential(t);
    t.mock.method(globalThis, 'fetch', async () => {
      if (failure === 'network') throw new Error('connection refused');
      if (failure === 'timeout') throw new DOMException('request timed out', 'TimeoutError');
      if (failure.startsWith('HTTP')) return new Response('unavailable', { status: Number(failure.slice(5)) });
      if (failure === 'invalid JSON') return new Response('{');
      return Response.json({});
    });
    await assert.rejects(hasPreparation('demo', 'opencode/model'), (error) => {
      assert.equal(error.infrastructure, true);
      assert.match(error.message, /preparation policy could not be read/);
      return true;
    });
    const state = await runTask({ project: 'demo', item: { id: 't1' }, agent: 'opencode', model: 'model', actor: 'opencode/model' }, {
      agents: [{ agent: 'opencode', models: ['model'], command: ['harness'] }],
    }, 'home:test', {
      workspacePath: () => process.cwd(),
      readValidationBlock: async () => ({ actor: 'opencode/model', head: 'before', taskKey: taskRevisionKey({ id: 't1' }), detail: 'old blocker' }),
      hasPreparation,
      cli: () => assert.fail('must not claim or release after an unreadable policy'),
      harness: () => assert.fail('must not start a harness'),
      log: () => {},
      stopped: () => false,
    });
    assert.equal(state.phase, 'failed');
    assert.equal(state.taskFailure, false);
    assert.match(state.reason, /preparation policy could not be read/);
    assert.equal(runOutcome(state), null, 'infrastructure failures do not count against the model');
    assert.equal(infrastructureFailureCount(0, state), 1);
  });
}
