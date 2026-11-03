import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { refreshRunners } from '../scripts/ship-refresh-runners.mjs';
import { SHIP_GIT } from '../scripts/ship-studio.mjs';
import { composeShip } from '../cli/ship.mjs';

const head = 'a'.repeat(40);
test('production verifies delivery before refreshing runners with the captured commit', () => {
  const ship = JSON.parse(readFileSync('docs/atelier/ship.json', 'utf8'));
  assert.deepEqual(ship['verify-deploy'].map(r => r.run), [
    ['node', 'scripts/ship-studio.mjs', 'verify', '--version-url', 'https://atelier.zone/api/version'],
    ['node', 'scripts/ship-refresh-runners.mjs'],
  ]);
  assert.deepEqual(composeShip(process.cwd()).problems, []);
});

test('refresh pins the push, reset and dependency install to the shipped commit', () => {
  const calls = [], messages = [];
  assert.equal(refreshRunners({ getHead: () => head, run: (...args) => { calls.push(args); return { status: 0 }; }, log: s => messages.push(s) }), true);
  assert.deepEqual(calls.map(c => c.slice(0, 2)), [
    [SHIP_GIT, ['push', 'ai-studio:ai-projects/atelier-runner', `${head}:refs/atelier/ship`]],
    ['/usr/bin/ssh', ['-o', 'BatchMode=yes', '--', 'ai-studio', `PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH; cd "$HOME/ai-projects/atelier-runner" && git reset --hard ${head} && npm ci`]],
  ]);
  assert.ok(calls.every(c => c[2].timeout === 240_000));
  assert.deepEqual(messages, [`Refreshed Studio runners to ${head}.`]);
});

for (const failure of ['source', 'push', 'ssh', 'spawn']) {
  test(`a ${failure} failure warns, returns normally and never reports completion`, () => {
    const warnings = [], messages = [];
    let calls = 0;
    const result = refreshRunners({
      getHead: () => { if (failure === 'source') throw Error('source moved'); return head; },
      run: () => { calls++; if (failure === 'spawn') throw Error('spawn failed'); return { status: calls === (failure === 'push' ? 1 : 2) ? 1 : 0 }; },
      warn: s => warnings.push(s), log: s => messages.push(s),
    });
    assert.equal(result, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Warning: Studio runner refresh failed.*delivery remains successful/);
    assert.deepEqual(messages, []);
    assert.equal(calls, failure === 'source' ? 0 : failure === 'ssh' ? 2 : 1);
  });
}

 test('the ship command exits successfully when refresh cannot start', () => {
  const result = spawnSync(process.execPath, ['scripts/ship-refresh-runners.mjs'], {
    encoding: 'utf8', env: { ...process.env, ATELIER_SHIP_HEAD: 'invalid' },
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Warning: Studio runner refresh failed.*delivery remains successful/);
  assert.equal(result.stdout, '');
});
