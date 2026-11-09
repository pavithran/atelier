import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseConfig } from '../cli/runner-config.mjs';
import { harnessEnv } from '../cli/runner.mjs';

const script = new URL('../scripts/studio/setup-browsers.sh', import.meta.url).pathname;
const START = '#!/bin/zsh\numask 027\nexport PATH="$HOME/.local/bin:/usr/bin:/bin"\nexec atelier runner\n';
const CONFIG = {
  agents: [
    { agent: 'claude-code', models: ['claude-sonnet-5-5'] },
    { agent: 'codex', models: ['gpt-6-astra'], env: ['OPENAI_API_KEY'] },
  ],
};

// A stand-in npm and playwright, so the script's own steps run for real
// without the network: npm "installs" a module whose chromium launches only
// when the browser folder the install step made exists.
const made = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
function fixture(name) {
  const base = mkdtempSync(join(tmpdir(), `setup-browsers-${name}-`));
  made.push(base);
  const bin = join(base, 'bin');
  mkdirSync(bin, { recursive: true });
  const npm = `#!/bin/sh
echo "$@" >> "${base}/npm.log"
[ -z "$FAKE_NPM_HANG" ] || exec sleep 30
while [ "$1" != --prefix ]; do shift; done
prefix=$2
version=\${5#playwright@}; for a in "$@"; do case $a in playwright@*) version=\${a#playwright@};; esac; done
m=$prefix/node_modules/playwright
mkdir -p "$m"
echo '{"name":"playwright","version":"'$version'"}' > "$m/package.json"
cat > "$m/index.js" <<'JS'
const fs = require('fs'), path = require('path');
exports.chromium = { launch: async () => {
  const dir = path.join(process.env.PLAYWRIGHT_BROWSERS_PATH || '', 'chromium-1');
  if (!fs.existsSync(dir)) throw new Error("Executable doesn't exist at " + dir);
  return { newPage: async () => ({ goto: async (u) => { if (u !== 'about:blank') throw new Error(u); } }), close: async () => {} };
} };
JS
cat > "$m/cli.js" <<'JS'
require('fs').mkdirSync(require('path').join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium-1'), { recursive: true });
JS
`;
  writeFileSync(join(bin, 'npm'), npm);
  chmodSync(join(bin, 'npm'), 0o755);
  const conf = join(base, 'conf');
  mkdirSync(conf, { recursive: true });
  writeFileSync(join(conf, 'build.json'), JSON.stringify(CONFIG, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(join(conf, 'start-build.zsh'), START);
  const root = join(base, 'pw');
  const run = (args = [conf], extra = {}) => spawnSync('/bin/sh', [script, ...args], {
    encoding: 'utf8', timeout: 60000,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: base, SETUP_BROWSERS_ROOT: root, ...extra },
  });
  return { base, conf, root, run, npmCalls: () => (existsSync(join(base, 'npm.log')) ? readFileSync(join(base, 'npm.log'), 'utf8').trim().split('\n').length : 0) };
}
const files = (f) => ({ json: readFileSync(join(f.conf, 'build.json'), 'utf8'), zsh: readFileSync(join(f.conf, 'start-build.zsh'), 'utf8') });

test('setup installs the module and browsers, names them in every harness env, and the runner passes them on', () => {
  const f = fixture('fresh');
  const ran = f.run();
  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(existsSync(join(f.root, 'node_modules/playwright/index.js')));
  assert.ok(existsSync(join(f.root, 'browsers/chromium-1')));
  // The runner's own parser accepts the rewritten config, and harnessEnv hands the variables to a build.
  const { json, zsh } = files(f);
  const config = parseConfig(json, { configPath: join(f.conf, 'build.json') });
  assert.deepEqual(config.errors, []);
  for (const entry of config.agents) {
    assert.ok(entry.env.includes('PLAYWRIGHT_MODULE') && entry.env.includes('PLAYWRIGHT_BROWSERS_PATH'), entry.agent);
    const base = { PLAYWRIGHT_MODULE: join(f.root, 'node_modules/playwright'), PLAYWRIGHT_BROWSERS_PATH: join(f.root, 'browsers'), ATELIER_TOKEN: 't' };
    const { env } = harnessEnv(base, entry.env, []);
    assert.equal(env.PLAYWRIGHT_MODULE, base.PLAYWRIGHT_MODULE);
    assert.equal(env.ATELIER_TOKEN, undefined);
  }
  assert.deepEqual(config.agents[1].env, ['OPENAI_API_KEY', 'PLAYWRIGHT_MODULE', 'PLAYWRIGHT_BROWSERS_PATH']);
  assert.ok(zsh.includes(`export PLAYWRIGHT_MODULE="${f.root}/node_modules/playwright"\n`));
  assert.ok(zsh.indexOf('export PLAYWRIGHT_MODULE') > zsh.indexOf('export PATH') && zsh.indexOf('export PLAYWRIGHT_MODULE') < zsh.indexOf('exec atelier'));
  assert.equal(statSync(join(f.conf, 'build.json')).mode & 0o777, 0o600);
  // Chromium launches from the installed pair, now and as a later --check (after a restart).
  const check = f.run(['--check']);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stderr, /about:blank/);
  assert.deepEqual(readdirSync(f.base).filter((n) => /\.(lock|staging|old)$/.test(n) || n.endsWith('.new')), []);
});

test('--check names the missing executable when the browsers are gone', () => {
  const f = fixture('check-missing');
  assert.equal(f.run().status, 0);
  const gone = spawnSync('/bin/sh', ['-c', `mv "${f.root}/browsers/chromium-1" "${f.root}/browsers/moved"`]);
  assert.equal(gone.status, 0);
  const check = f.run(['--check']);
  assert.notEqual(check.status, 0);
  assert.match(check.stderr, /Executable doesn't exist/);
});

test('a second run changes nothing and installs nothing', () => {
  const f = fixture('again');
  assert.equal(f.run().status, 0);
  const once = files(f), calls = f.npmCalls();
  const m1 = statSync(join(f.conf, 'build.json')).mtimeMs;
  const again = f.run();
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /not reinstalling/);
  assert.deepEqual(files(f), once);
  assert.equal(f.npmCalls(), calls);
  assert.equal(statSync(join(f.conf, 'build.json')).mtimeMs, m1);
});

test('a rerun after an interruption completes the install', () => {
  const f = fixture('interrupted');
  // Killed mid-install (a half staging folder, a stale .new copy, a lock of a dead run), and between the two moves (module only in .old).
  mkdirSync(join(f.root + '.staging', 'node_modules/half'), { recursive: true });
  mkdirSync(f.root + '.old/node_modules/playwright', { recursive: true });
  writeFileSync(join(f.root + '.old/node_modules/playwright/package.json'), '{"version":"0.0.1"}');
  writeFileSync(join(f.conf, 'build.json.new'), 'garbage');
  mkdirSync(f.root + '.lock');
  const dead = spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(f.root + '.lock', 'pid'), dead + '\n');
  const ran = f.run();
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stderr, new RegExp(`pid ${dead}, which is gone`));
  assert.ok(existsSync(join(f.root, 'browsers/chromium-1')));
  assert.ok(!existsSync(f.root + '.staging') && !existsSync(f.root + '.old') && !existsSync(f.root + '.lock'));
  assert.ok(!existsSync(join(f.conf, 'build.json.new')));
  assert.deepEqual(parseConfig(files(f).json, { configPath: 'x' }).errors, []);
});

test('a run while another holds the lock exits nonzero naming its pid and changes nothing', () => {
  const f = fixture('locked');
  mkdirSync(f.root + '.lock');
  writeFileSync(join(f.root + '.lock', 'pid'), `${process.pid}\n`);
  const before = files(f);
  const ran = f.run();
  assert.equal(ran.status, 75);
  assert.ok(ran.stderr.includes(`pid ${process.pid}`), ran.stderr);
  assert.deepEqual(files(f), before);
  assert.ok(!existsSync(f.root));
  assert.ok(existsSync(f.root + '.lock'), 'the holder keeps its lock');
  assert.equal(f.npmCalls(), 0);
});

test('a step past its limit exits nonzero naming it and leaves module, browsers and configs as they were', () => {
  const f = fixture('timeout');
  // An older setup is in place; the install step hangs past a one-second limit.
  mkdirSync(join(f.root, 'node_modules/playwright'), { recursive: true });
  writeFileSync(join(f.root, 'node_modules/playwright/package.json'), '{"version":"0.0.1"}');
  mkdirSync(join(f.root, 'browsers/chromium-0'), { recursive: true });
  const before = files(f);
  const started = Date.now();
  const ran = f.run([f.conf], { SETUP_BROWSERS_LIMIT: '1', FAKE_NPM_HANG: '1' });
  assert.ok(Date.now() - started < 20000, 'the hung step was killed at its limit');
  assert.equal(ran.status, 124);
  assert.match(ran.stderr, /step install-module exceeded its 1s limit/);
  assert.deepEqual(files(f), before);
  assert.equal(readFileSync(join(f.root, 'node_modules/playwright/package.json'), 'utf8'), '{"version":"0.0.1"}');
  assert.deepEqual(readdirSync(join(f.root, 'browsers')), ['chromium-0']);
  assert.deepEqual(readdirSync(f.base).filter((n) => /\.(lock|staging|old)$/.test(n)), []);
  assert.deepEqual(readdirSync(f.conf).sort(), ['build.json', 'start-build.zsh']);
  // The next run starts from that known state and completes.
  const next = f.run();
  assert.equal(next.status, 0, next.stderr);
  assert.ok(existsSync(join(f.root, 'browsers/chromium-1')));
});

test('a config that cannot take the variables fails before anything is moved', () => {
  const f = fixture('badconfig');
  writeFileSync(join(f.conf, 'start-build.zsh'), '#!/bin/zsh\nexec atelier runner\n');
  const before = files(f);
  const ran = f.run();
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /step prepare-configs failed/);
  assert.deepEqual(files(f), before);
  assert.ok(!existsSync(f.root));
});
