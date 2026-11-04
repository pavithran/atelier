import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { refreshRunners } from '../scripts/ship-refresh-runners.mjs';
import { composeShip } from '../cli/ship.mjs';

test('production verifies delivery before refreshing runners with the captured commit', () => {
  const ship = JSON.parse(readFileSync('docs/atelier/ship.json', 'utf8'));
  assert.deepEqual(ship['verify-deploy'].map(r => r.run), [
    ['node', 'scripts/ship-studio.mjs', 'verify', '--version-url', 'https://atelier.zone/api/version'],
    ['node', 'scripts/ship-refresh-runners.mjs'],
  ]);
  assert.equal(ship.deploy.if_changed, undefined, "every production ship must reach runner refresh, including runner-only changes");
  assert.deepEqual(composeShip(process.cwd()).problems, []);
});

test('the ship command exits successfully when refresh cannot start', () => {
  const result = spawnSync(process.execPath, ['scripts/ship-refresh-runners.mjs'], {
    encoding: 'utf8', env: { ...process.env, ATELIER_SHIP_HEAD: 'invalid' },
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Warning: Studio runner refresh failed.*delivery remains successful/);
  assert.equal(result.stdout, '');
});
