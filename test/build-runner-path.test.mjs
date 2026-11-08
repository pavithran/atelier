import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('../scripts/studio/fix-build-runner-path.sh', import.meta.url).pathname;
const OLD = 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"';
const NEW = 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"';
const start = `#!/bin/zsh\numask 027\n${OLD}\nexec atelier runner\n`;

function dir(name, files) {
  const d = join('.scratch', `path-fix-${name}`);
  mkdirSync(d, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(d, file), text);
  return d;
}
const run = (...args) => spawnSync('/bin/sh', [script, ...args], { encoding: 'utf8' });

test('every start-build script gains /usr/sbin and /sbin, so lsof is found', () => {
  const d = dir('adds', { 'start-build.zsh': start, 'start-build-2.zsh': start });
  const ran = run(d);
  assert.equal(ran.status, 0, ran.stderr);
  for (const f of ['start-build.zsh', 'start-build-2.zsh']) {
    const text = readFileSync(join(d, f), 'utf8');
    assert.ok(text.includes(NEW + '\n'), f);
    assert.ok(!text.includes(OLD + '\n'), f);
    assert.ok(text.includes('exec atelier runner'), f);
  }
});

test('a second run changes nothing', () => {
  const d = dir('again', { 'start-build.zsh': start });
  run(d);
  const once = readFileSync(join(d, 'start-build.zsh'), 'utf8');
  assert.equal(run(d).status, 0);
  assert.equal(readFileSync(join(d, 'start-build.zsh'), 'utf8'), once);
});

test('a script whose PATH line is not the known one is refused and left alone', () => {
  const odd = start.replace(OLD, 'export PATH="/somewhere/else"');
  const d = dir('odd', { 'start-build.zsh': odd });
  const ran = run(d);
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /start-build\.zsh/);
  assert.equal(readFileSync(join(d, 'start-build.zsh'), 'utf8'), odd);
});

test('a folder with no start-build script is an error, not a silent success', () => {
  const d = dir('empty', { 'other.txt': 'x' });
  assert.notEqual(run(d).status, 0);
});

test('the file mode survives the rewrite', () => {
  const d = dir('mode', { 'start-build.zsh': start });
  chmodSync(join(d, 'start-build.zsh'), 0o750);
  run(d);
  assert.equal(statSync(join(d, 'start-build.zsh')).mode & 0o777, 0o750);
});
