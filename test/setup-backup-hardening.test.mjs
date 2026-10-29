import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-backup-hardening-')));
after(() => rmSync(root, { recursive: true, force: true }));
const mac = process.platform === 'darwin' ? false : 'BSD stat and Mach-O checks require macOS';
const scripts = ['backup', 'restore'].map(name => ({ name, path: resolve(`scripts/studio/setup-${name}.sh`), text: readFileSync(`scripts/studio/setup-${name}.sh`, 'utf8') }));
const scratch = () => mkdtempSync(join(root, 'case-'));
function run(script, body, args = []) {
  return spawnSync('/bin/bash', ['-p', '-c', `SETUP_${script.name.toUpperCase()}_LIB=1 source "$0"\n${body}`, script.path, ...args], { encoding: 'utf8' });
}
function executable(path, body) { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o700); }

for (const script of scripts) {
  test(`${script.name}: privileged startup ignores injected code and clears the root environment`, () => {
    const h = scratch(), marker = join(h, 'executed'), injection = join(h, 'startup');
    writeFileSync(injection, `echo ran > '${marker}'\n`);
    const env = { ...process.env, BASH_ENV: injection, ENV: injection, HOME: h, PATH: h, DEVELOPER_DIR: h, NODE_OPTIONS: '--import=evil', DRYRUN: '1', SUDO_USER: 'pavi', PS4: `$(echo traced > '${marker}')`, SHELLOPTS: 'xtrace', 'BASH_FUNC_echo%%': `() { /bin/touch '${marker}'; }` };
    assert.ok(script.text.startsWith('#!/bin/bash -p\n'));
    const entry = join(h, 'entry'); writeFileSync(entry, script.text); chmodSync(entry, 0o700);
    const whole = spawnSync(entry, [], { env, encoding: 'utf8' });
    assert.notEqual(whole.status, 0);
    const prelude = script.text.slice(script.text.indexOf('if builtin test'), script.text.indexOf('# Atelier 2.0')).replace('builtin test "$EUID" = 0', 'builtin true');
    const r = spawnSync('/bin/bash', ['-p', '-c', `${prelude}\n/usr/bin/env\nbuiltin pwd\numask`], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    for (const key of ['BASH_ENV','ENV','DEVELOPER_DIR','NODE_OPTIONS','DRYRUN','SUDO_USER','PS4','SHELLOPTS']) assert.doesNotMatch(r.stdout, new RegExp(`^${key}=`, 'm'));
    assert.match(r.stdout, /^HOME=\/var\/root$/m);
    assert.match(r.stdout, /^PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin$/m);
    assert.match(r.stdout, /\n\/\n0*77\n$/);
    assert.equal(existsSync(marker), false);
    const plain = spawnSync('/bin/bash', ['-c', prelude], { encoding: 'utf8' });
    assert.equal(plain.status, 1); assert.match(plain.stderr, /privileged bash/);
  });

  test(`${script.name}: every external executable is fixed and root-checked`, () => {
    const declarations = [...script.text.matchAll(/^([A-Z_]+)=(\/(?:usr\/bin|bin|usr\/sbin)\/[^\s]+)$/gm)];
    assert.ok(declarations.length > 20);
    const validation = script.text.slice(script.text.indexOf('  for tool in'), script.text.indexOf('\nfi', script.text.indexOf('  for tool in')));
    for (const [, name] of declarations) assert.ok(validation.includes(`"$${name}"`), `${name} checked`);
    assert.match(validation, /\[ -f "\$tool" \].*\[ -x "\$tool" \].*\$STAT.*= root/);
    // Command positions, including pipelines, substitutions, run and find -exec.
    const bare = /(?:^|[;|]|\$\(|\b(?:then|do|run|if|elif|else|exec)\s+)\s*(?:!\s*)?(?:LC_ALL=C\s+)?(stat|ls|sed|grep|launchctl|seq|sleep|pgrep|plutil|rm|mv|install|mkdir|mktemp|cp|chmod|tar|awk|dscl|wc|tr|chown|id|date|readlink|find|sqlite3|basename|tail|git|otool|curl|sudo)\s/gm;
    assert.doesNotMatch(script.text.split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n').replace(/(?:echo|fail) "[^"\n]*"/g, ''), bare);
    assert.match(script.text, /GIT=\/Library\/Developer\/CommandLineTools\/usr\/bin\/git/);
    assert.match(script.text, /OTOOL=\/Library\/Developer\/CommandLineTools\/usr\/bin\/llvm-otool/);
    assert.match(script.text, /trusted_source "\$tool"/);
    assert.match(script.text, /trusted_source \/Users\/atelierd\/bin\/node/);
    assert.match(script.text, /check_node \/Users\/atelierd\/bin\/node/);
    assert.doesNotMatch(script.text, /GIT=\/usr\/bin\/git|OTOOL=\/usr\/bin\/otool/);
    // Neither script invokes sudo, curl or node directly; launchd runs the verified node.
    assert.doesNotMatch(script.text, /^\s*(?:"\$SUDO"|"\$CURL"|"\$NODE") /m);
  });

  test(`${script.name}: executable verification rejects a real caller-owned tool`, { skip: mac }, () => {
    const h = scratch(), tool = join(h, 'cp'); executable(tool, 'exit 0');
    const start = script.text.indexOf('  for tool in'), end = script.text.indexOf('\nfi', start);
    const r = run(script, `CP="$1"; ${script.text.slice(start, end)}`, [tool]);
    assert.equal(r.status, 1); assert.match(r.stderr, /unsafe system tool/);
    assert.ok(r.stderr.includes(tool));
  });

  test(`${script.name}: early cleanup releases its lock on success and failure`, () => {
    const start = script.text.indexOf('LOCK= WORK='), end = script.text.indexOf('if ! dry; then', start);
    for (const status of [0, 42]) {
      const h = scratch(), work = join(h, 'work'), lock = join(h, 'lock'); mkdirSync(work); writeFileSync(lock, 'owned');
      const r = run(script, `${script.text.slice(start, end)}\nWORK="$1/work"; LOCK="$1/lock"; exit ${status}`, [h]);
      assert.equal(r.status, status, r.stderr); assert.equal(existsSync(work), false); assert.equal(existsSync(lock), false);
    }
  });

  test(`${script.name}: real source and lock checks reject writable custody`, { skip: mac }, () => {
    const good = run(script, 'trusted_source /bin/ls'); assert.equal(good.status, 0, good.stderr);
    const writable = run(script, 'trusted_entry /private/tmp'); assert.equal(writable.status, 1); assert.match(writable.stderr, /group\/world-writable/);
    const h = scratch(), source = join(h, 'script'); writeFileSync(source, 'reviewed bytes');
    for (const body of ['trusted_source "$1/script"', 'LOCK_DIR="$1"; acquire_lock']) {
      const r = run(script, body, [h]); assert.equal(r.status, 1); assert.match(r.stderr, /not root-owned|group\/world-writable|unsafe lock/);
    }
    const link = join(h, 'link'); symlinkSync('/bin/ls', link);
    const r = run(script, 'trusted_entry "$1"', [link]); assert.equal(r.status, 1); assert.match(r.stderr, /not a plain source/);
    assert.match(script.text, /if ! trusted_source "\$SOURCE"/);
    assert.match(script.text, /sudo \/usr\/bin\/install -o root -g wheel -m 700/);
    const missing = run(script, 'GIT=/absent/git; check_tools'); assert.equal(missing.status, 1); assert.match(missing.stderr, /xcode-select --install/);
  });

  test(`${script.name}: actual shlock excludes a second writer and preserves its lock`, { skip: mac }, () => {
    const h = scratch();
    // Only custody is replaced: shlock and PID handling are the system implementations.
    const r = run(script, 'LOCK_DIR="$1"; trusted_entry() { :; }; STAT=fake_stat; fake_stat() { echo root; }; acquire_lock; echo "$$"; acquire_lock', [h]);
    assert.equal(r.status, 1); assert.match(r.stderr, /another installer is running/);
    assert.equal(readFileSync(join(h, 'install.lock'), 'utf8').trim(), r.stdout.trim());
    assert.match(script.text, /LOCK_DIR=\/Library\/Atelier\/lock/);
    assert.ok(script.text.indexOf('trap early_cleanup EXIT') < script.text.lastIndexOf('\n  acquire_lock\n'));
    assert.match(script.text, /\[ -z "\$LOCK" \] \|\| "\$RM" -f "\$LOCK"/);
    assert.match(script.text, /\[ \$status = 0 \] \|\| restore; early_cleanup "\$status"/);
  });

  test(`${script.name}: real file check rejects a node shim and real otool accepts a system binary`, { skip: mac }, () => {
    const h = scratch(), shim = join(h, 'node'); executable(shim, 'exec /opt/homebrew/bin/node "$@"');
    const bad = run(script, 'WORK="$1"; check_node "$1/node"', [h]); assert.equal(bad.status, 1); assert.match(bad.stderr, /Mach-O executable/);
    const good = run(script, 'WORK="$1"; check_node /bin/ls', [h]); assert.equal(good.status, 0, good.stderr);
    const otool = join(h, 'otool');
    for (const [body, why] of [
      ['echo "$4:"', /empty library list/],
      ['echo "$4:"; echo error >&2', /otool reported an error/],
      ['echo "$4:"; printf "\\t/opt/homebrew/lib/evil.dylib (compatibility version 1.0.0)\\n"', /outside the system libraries/],
    ]) {
      executable(otool, body);
      const r = run(script, 'WORK="$1"; OTOOL="$1/otool"; check_node /bin/ls', [h]); assert.equal(r.status, 1); assert.match(r.stderr, why);
    }
  });
}

test('backup reads caller inputs once and validates only the private snapshots', () => {
  const script = scripts[0], h = scratch(), work = join(h, 'work'); mkdirSync(work, { mode: 0o700 });
  const r2 = join(h, 'R2.env'), pub = join(h, 'BACKUP.pub');
  const valid = `R2_ENDPOINT=https://${'a'.repeat(32)}.r2.cloudflarestorage.com\nR2_BUCKET=atelier-backups\nR2_ACCESS_KEY_ID=${'b'.repeat(32)}\nR2_SECRET_ACCESS_KEY=${'c'.repeat(64)}\n`;
  writeFileSync(r2, valid); writeFileSync(pub, `age1${'q'.repeat(58)}\n`);
  const start = script.text.indexOf('"$CP" "$R2_SRC"'), end = script.text.indexOf('# 2. The plist');
  const block = script.text.slice(start, end);
  assert.equal((block.match(/"\$R2_SRC"/g) || []).length, 1);
  assert.equal((block.match(/"\$PUB_SRC"/g) || []).length, 1);
  assert.match(block, /trusted_entry "\$WORK\/r2.env"/);
  assert.match(block, /trusted_entry "\$WORK\/recipient"/);
  const runInputs = () => run(script, `WORK="$1"; R2_SRC="$2"; PUB_SRC="$3"; TEMPLATE="$4"\ndry() { return 0; }\n${block}`, [work, r2, pub, resolve('scripts/studio/zone.atelier.backup.plist.template')]);
  const snapshot = run(script, `WORK="$1"; R2_SRC="$2"; PUB_SRC="$3"; TEMPLATE="$4"
dry() { return 0; }
snapshot_cp() { /bin/cp "$@"; case "$1" in "$R2_SRC"|"$PUB_SRC") printf changed > "$1" ;; esac; }
CP=snapshot_cp
${block}`, [work, r2, pub, resolve('scripts/studio/zone.atelier.backup.plist.template')]);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.equal(readFileSync(r2, 'utf8'), 'changed');
  assert.equal(readFileSync(pub, 'utf8'), 'changed');
  assert.equal(readFileSync(join(work, 'r2.env'), 'utf8'), valid);
  rmSync(join(work, 'values'), { recursive: true });
  writeFileSync(r2, valid);
  writeFileSync(pub, 'AGE-SECRET-KEY-do-not-install\n');
  const bad = runInputs(); assert.equal(bad.status, 1); assert.match(bad.stderr, /holds an age identity/);
});

test('the rendered backup plist uses the verified node and CLT git', { skip: mac }, () => {
  const template = readFileSync('scripts/studio/zone.atelier.backup.plist.template', 'utf8');
  const h = scratch(), file = join(h, 'plist');
  writeFileSync(file, template.replaceAll('@HOME@', '/Users/atelierd').replaceAll('@ENV@', 'staging').replaceAll('@HOUR@', '3').replaceAll('@MINUTE@', '30'));
  for (const [key, expected] of [['ProgramArguments.0', '/Users/atelierd/bin/node'], ['EnvironmentVariables.ATELIER_GIT', '/Library/Developer/CommandLineTools/usr/bin/git']]) {
    const r = spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), expected);
  }
  assert.match(scripts[0].text, /x EnvironmentVariables.ATELIER_GIT\)" = "\$GIT"/);
});
