import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshRunners } from '../scripts/ship-refresh-runners.mjs';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const head = 'a'.repeat(40);
test('ship publishes a bundle and never executes code in the builder copy', () => {
  const calls = [], messages = [];
  assert.equal(refreshRunners({ getHead: () => head, run: (...args) => {
    calls.push(args);
    return { status: 0, stdout: head + '\n' };
  }, log: s => messages.push(s) }), true);
  assert.ok(calls.some(c => c[1][0] === 'bundle'));
  assert.deepEqual(calls[0][1], ['push', 'ai-studio:ai-projects/atelier-runner', `${head}:refs/atelier/ship`]);
  assert.match(calls[1][1].at(-1), new RegExp(`git reset --hard ${head} && npm ci$`));
  assert.ok(calls.every(c => c[2].timeout === 90_000));
  assert.ok(calls.every(c => !JSON.stringify(c[1]).includes('safe.directory')));
  assert.ok(calls.every(c => !JSON.stringify(c[1]).includes('ai-studio:/Users/atelier-build/ai-projects/atelier-runner')));
  assert.ok(calls.filter(c => c[0] === '/usr/bin/ssh').every(c => !c[1].at(-1).includes('cd "/Users/atelier-build/ai-projects/atelier-runner')));
  assert.match(messages.join('\n'), /Builder copy reached/);
});

for (const failure of ['source', 'spawn']) {
  test(`${failure} failure warns without reporting completion`, () => {
    const messages = [], warnings = [];
    assert.equal(refreshRunners({
      getHead: () => { if (failure === 'source') throw Error('source moved'); return head; },
      run: () => { throw Error('spawn failed'); },
      log: s => messages.push(s), warn: s => warnings.push(s),
    }), false);
    assert.equal(messages.length, 0);
    assert.equal(warnings.length, 1);
  });
}
test('missing acknowledgement reports pending', () => {
  const warnings = [];
  assert.equal(refreshRunners({ getHead: () => head, run: () => ({ status: 0, stdout: 'old' }), warn: s => warnings.push(s), log: () => {} }), false);
  assert.match(warnings.join('\n'), /Builder copy has not reached/);
});

test('published head is readable by the loop as a forty-character commit', () => {
  let published;
  refreshRunners({ getHead: () => head, log: () => {}, warn: () => {},
    run: (command, args) => {
      if (command === '/usr/bin/ssh' && args.at(-1).startsWith('umask')) {
        const command = args.at(-1).replaceAll(/> runner-refresh\.(bundle|head)\.\$\$/g, '');
        const result = spawnSync('/bin/sh', ['-c', `cd() { :; }; cat() { :; }; mv() { :; }; ${command}`], { input: 'bundle' });
        published = String(result.stdout);
        return result;
      }
      return { status: 0, stdout: head };
    } });
  assert.equal(published, head + '\n');
});

for (const failure of ['', 'identity', 'busy', 'fetch', 'mismatch', 'reset', 'install', 'restart', 'crash']) {
  test(`builder refresh: ${failure || 'success'}`, () => {
    const script = readFileSync('scripts/studio/refresh-build-runners.sh', 'utf8')
      .replace(' > "$flags/runner-refresh.applied.next"', '');
    const result = spawnSync('/bin/sh', ['-c', `
      id() { echo ${failure === 'identity' ? 'pavi' : 'atelier-build'}; }
      cat() { case "$1" in *.head) echo ${head} ;; *) return 1 ;; esac; }
      cd() { echo cd; }
      git() {
        echo "git $*" >&2
        case "$1" in
          fetch) ${failure === 'fetch' ? 'return 1' : ':'} ;;
          rev-parse) echo ${failure === 'mismatch' ? 'bad' : head} ;;
          reset) ${failure === 'reset' ? 'return 1' : ':'} ;;
        esac
      }
      npm() { echo "npm $* TMPDIR=$TMPDIR"; ${failure === 'install' ? 'return 1' : ':'}; }
      idle() { ${failure === 'busy' ? 'return 1' : ':'}; }
      restart() { echo "restart TMPDIR=$TMPDIR"; ${failure === 'crash' ? 'exit 137' : failure === 'restart' ? 'return 1' : ':'}; }
      mv() { echo completed; }
      ${script}
      set -e
      refresh_build_runners idle restart
    `], { encoding: 'utf8' });
    const output = result.stdout + result.stderr;
    assert.equal(output.includes('completed'), failure === '', output);
    if (failure === '') {
      assert.match(output, /npm ci TMPDIR=\/Users\/atelier-build\/tmp/);
      assert.match(output, /restart TMPDIR=\/Users\/atelier-build\/tmp/);
    }
    if (['identity', 'busy'].includes(failure)) assert.ok(!output.includes('git '), output);
    if (['fetch', 'mismatch', 'reset'].includes(failure)) assert.ok(!output.includes('npm '), output);
  });
}

for (let failAt = 1; failAt <= 5; failAt++) {
  test(`ship operation ${failAt} failure leaves completion unreported`, () => {
    let calls = 0;
    const messages = [], warnings = [];
    assert.equal(refreshRunners({ getHead: () => head,
      run: () => ({ status: ++calls === failAt ? 1 : 0, stdout: head }),
      log: s => messages.push(s), warn: s => warnings.push(s) }), false);
    assert.equal(messages.length, 0);
    assert.equal(warnings.length, 1);
  });
}
