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
  test(`${script.name}: privileged startup ignores injected code`, () => {
    const h = scratch(), marker = join(h, 'executed'), injection = join(h, 'startup');
    writeFileSync(injection, `echo ran > '${marker}'\n`);
    const env = { ...process.env, BASH_ENV: injection, ENV: injection, HOME: h, PATH: h, DEVELOPER_DIR: h, NODE_OPTIONS: '--import=evil', DRYRUN: '1', SUDO_USER: 'pavi', PS4: `$(echo traced > '${marker}')`, SHELLOPTS: 'xtrace', 'BASH_FUNC_echo%%': `() { /bin/touch '${marker}'; }` };
    assert.ok(script.text.startsWith('#!/bin/bash -p\n'));
    const entry = join(h, 'entry'); writeFileSync(entry, script.text); chmodSync(entry, 0o700);
    const whole = spawnSync(entry, [], { env, encoding: 'utf8' });
    assert.notEqual(whole.status, 0);
    assert.equal(existsSync(marker), false);
  });

  test(`${script.name}: every external executable is fixed and root-checked`, () => {
    const declarations = [...script.text.matchAll(/^([A-Z_]+)=(\/(?:usr\/bin|bin|usr\/sbin)\/[^\s]+)$/gm)];
    assert.ok(declarations.length > 20);
    const checked = run(script, 'check_system_tools');
    assert.equal(checked.status, 0, checked.stderr);
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
    const r = run(script, 'CP="$1"; check_system_tools', [tool]);
    assert.equal(r.status, 1); assert.match(r.stderr, /unsafe system tool/);
    assert.ok(r.stderr.includes(tool));
  });

  test(`${script.name}: early cleanup releases its lock on success and failure`, () => {
    for (const status of [0, 42]) {
      const h = scratch(), work = join(h, 'work'), lock = join(h, 'lock'); mkdirSync(work); writeFileSync(lock, 'owned');
      const r = run(script, `WORK="$1/work"; LOCK="$1/lock"; trap early_cleanup EXIT; exit ${status}`, [h]);
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

// Root ownership cannot be created by this unprivileged suite. Metadata adapters
// model protected custody for scratch inputs; trusted_source/trusted_entry and
// dry() remain the real functions. Separate cases use actual filesystem metadata.
const custody = `
STAT=fixture_stat; LS=fixture_ls
fixture_stat() { if [ "$2" = %Su ]; then echo root; else echo 700; fi; }
fixture_ls() { echo plain; }
`;
const valid = `R2_ENDPOINT=https://${'a'.repeat(32)}.r2.cloudflarestorage.com\nR2_BUCKET=atelier-backups\nR2_ACCESS_KEY_ID=${'b'.repeat(32)}\nR2_SECRET_ACCESS_KEY=${'c'.repeat(64)}\n`;
function backupInputs() {
  const h = scratch(); mkdirSync(join(h, 'work'));
  writeFileSync(join(h, 'R2.env'), valid); writeFileSync(join(h, 'backup.pub'), `age1${'q'.repeat(58)}\n`);
  return h;
}
const inputVars = `WORK="$1/work"; R2_SRC="$1/R2.env"; PUB_SRC="$1/backup.pub"; TEMPLATE="$2"`;
const template = resolve('scripts/studio/zone.atelier.backup.plist.template');

test('backup refuses caller-owned inputs through real source checks', { skip: mac }, () => {
  const h = backupInputs();
  const r = run(scripts[0], `${inputVars}; prepare_inputs`, [h, template]);
  assert.equal(r.status, 1); assert.match(r.stderr, /root-owned|writable/);
  assert.match(r.stderr, /sudo \/usr\/bin\/install -o root -g wheel -m 600/);
  assert.equal(existsSync(join(h, 'work/r2.env')), false);
});

test('backup snapshots each trusted input once, rejects linked parents and never prints unknown lines', { skip: mac }, () => {
  const h = backupInputs();
  const r = run(scripts[0], `${custody}${inputVars}
  snapshot_cp() { /bin/cp "$@"; case "$2" in "$R2_SRC"|"$PUB_SRC") printf changed > "$2" ;; esac; }
  CP=snapshot_cp; prepare_inputs`, [h, template]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(h, 'work/r2.env'), 'utf8'), valid);
  for (const name of ['R2.env', 'backup.pub']) assert.equal(readFileSync(join(h, name), 'utf8'), 'changed');
  const bad = backupInputs(); writeFileSync(join(bad, 'R2.env'), 'PRIVATE-KEY-MATERIAL=secret\n');
  const failure = run(scripts[0], `${custody}${inputVars}; prepare_inputs`, [bad, template]);
  assert.equal(failure.status, 1); assert.match(failure.stderr, /unknown setting/); assert.doesNotMatch(failure.stderr + failure.stdout, /PRIVATE-KEY-MATERIAL|secret/);
  const linked = join(h, 'linked'); symlinkSync(bad, linked);
  const parent = run(scripts[0], `${custody}${inputVars}; prepare_inputs`, [linked, template]);
  assert.equal(parent.status, 1); assert.match(parent.stderr, /not a plain source/);
});

test('the actual backup plist renderer selects each environment server and CLT git', { skip: mac }, () => {
  for (const [env, server, minute] of [['staging', 'server', 30], ['production', 'server-production', 0]]) {
    const h = scratch();
    const r = run(scripts[0], `WORK="$1"; TEMPLATE="$2"; /bin/cp "$TEMPLATE" "$WORK/template"
      ENV=${env}; SERVER=${server}; HOME_DIR=/Users/atelierd; SVC=atelierd; LABEL=zone.atelier.backup.$ENV
      HOUR=3; MINUTE=${minute}; B=$HOME_DIR/secrets/backup; W=$HOME_DIR/backup-work
      render_plist`, [h, template]);
    assert.equal(r.status, 0, r.stderr);
    for (const [key, expected] of [['ProgramArguments.0', '/Users/atelierd/bin/node'], ['ProgramArguments.1', `/Users/atelierd/${server}/cli/backup.mjs`], ['EnvironmentVariables.ATELIER_GIT', '/Library/Developer/CommandLineTools/usr/bin/git']]) {
      const parsed = spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(h, 'plist')], { encoding: 'utf8' });
      assert.equal(parsed.status, 0, parsed.stderr); assert.equal(parsed.stdout.trim(), expected);
    }
  }
});

test('restore archive rejects unprotected custody before copying', { skip: mac }, () => {
  const h = scratch(); writeFileSync(join(h, 'restore.tar'), 'untrusted');
  const r = run(scripts[1], 'WORK="$1"; TAR_SRC="$1/restore.tar"; extract_archive', [h]);
  assert.equal(r.status, 1); assert.match(r.stderr, /sudo \/usr\/bin\/install -o root -g wheel -m 600/);
  assert.equal(existsSync(join(h, 'restored.tar')), false);
});

test('input snapshots refuse a last-moment source symlink instead of following it', { skip: mac }, () => {
  for (const script of scripts) {
    const h = backupInputs();
    writeFileSync(join(h, 'restore.tar'), 'placeholder');
    // This injected race is possible only with our synthetic custody metadata.
    // A no-follow copy must produce a link that the real trusted_entry rejects.
    const r = run(script, `${custody}${inputVars}; TAR_SRC="$1/restore.tar"
      race_cp() {
        [ "$1" = -P ] || exit 88
        case "$2" in "$R2_SRC"|"$TAR_SRC") /bin/rm "$2"; /bin/ln -s /bin/ls "$2" ;; esac
        /bin/cp "$@"
      }
      CP=race_cp
      ${script.name === 'backup' ? 'prepare_inputs' : 'extract_archive'}`, [h, template]);
    assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /not a plain source/);
  }
});

test('restore extracts a hostile archive and installs only a fresh minimal repository config', { skip: mac }, () => {
  for (const server of ['server', 'server-production']) {
    const h = scratch(), archive = join(h, 'restore.tar'), repo = join(h, 'source/repos/key.git');
    for (const dir of ['hooks', 'objects/info', 'info']) mkdirSync(join(repo, dir), { recursive: true });
    mkdirSync(join(h, 'source/data')); mkdirSync(join(h, 'work'));
    writeFileSync(join(repo, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(repo, 'config'), '[core]\n alternateRefsCommand = touch /tmp/evil\n fsmonitor = touch /tmp/evil\n');
    for (const file of ['hooks/pre-receive', 'objects/info/alternates', 'objects/info/http-alternates', 'info/attributes', 'config.worktree']) writeFileSync(join(repo, file), 'hostile');
    const tar = spawnSync('/usr/bin/tar', ['-cf', archive, '-C', join(h, 'source'), 'data', 'repos'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    assert.equal(tar.status, 0);
    const r = run(scripts[1], `${custody}WORK="$1/work"; TAR_SRC="$1/restore.tar"; SERVER=${server}
      extract_archive; sanitize_repositories; /bin/cp -R "$X/repos" "$1/installed"`, [h]);
    assert.equal(r.status, 0, r.stderr);
    const installed = join(h, 'installed/key.git');
    assert.equal(readFileSync(join(installed, 'config'), 'utf8'), `[core]\n\tbare = true\n\thooksPath = /Users/atelierd/${server}/hooks\n`);
    for (const file of ['hooks', 'objects/info/alternates', 'objects/info/http-alternates', 'info', 'config.worktree']) assert.equal(existsSync(join(installed, file)), false, file);
  }
});
