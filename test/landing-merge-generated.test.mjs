// t39: atelier merge onto the baseline where a generator would have to run.
// The merge runs first in a throwaway clone pinned to the checkout's head and
// the accepted head (verifyAccepted in cli/merge-pipeline.mjs); it goes on
// only when every declared output is the accepted revision's own, mode and
// bytes. t686 (2026-10-15) was refused twice for outputs that matched.
// The fixtures are local Git repositories and the real CLI, as in
// landing-states-2.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { landing } from './landing-states-shared.mjs';

// gen.txt is generated from in/*.txt by `command` (the default also leaves
// it in the same mode every time); the checkout, the baseline and the task's
// workspace all hold it.
function declare(f, command = 'cat in/*.txt > gen.txt') {
  const manifest = JSON.stringify({ version: 1, generators: [{ name: 'gen', command: ['sh', '-c', command], inputs: ['in/**'], outputs: ['gen.txt'] }], records: [] });
  mkdirSync(join(f.checkout, 'bin')); mkdirSync(join(f.checkout, 'in'));
  writeFileSync(join(f.checkout, 'bin', 'merge-manifest.json'), manifest);
  writeFileSync(join(f.checkout, '.gitattributes'), 'gen.txt merge=atelier-generated\n');
  writeFileSync(join(f.checkout, 'in', 'base.txt'), 'base\n'); writeFileSync(join(f.checkout, 'gen.txt'), 'base\n');
  f.git(f.checkout, 'add', '.'); f.git(f.checkout, 'commit', '-q', '-m', 'Declare the generator');
  f.git(f.checkout, 'push', '-q', f.baseline, 'HEAD:main');
  f.git(f.workspace, 'fetch', '-q', f.baseline, 'main'); f.git(f.workspace, 'merge', '-q', '--no-edit', 'FETCH_HEAD');
}

// One side's commit, sent where that side lives; the task's is the accepted head.
function side(f, dir, files, message) {
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  f.git(dir, 'add', '.'); f.git(dir, 'commit', '-q', '-m', message);
  if (dir === f.checkout) f.git(dir, 'push', '-q', f.baseline, 'HEAD:main');
  else { f.git(dir, 'push', '-q', 'origin', 'main'); f.box.head = f.box.acceptedHead = f.git(dir, 'rev-parse', 'HEAD'); }
}

const kept = (f) => join(f.checkout, '.git', 'atelier', 'merge-logs');
const keptFiles = (f) => (existsSync(kept(f)) ? readdirSync(kept(f)) : []);

// Nothing merged, nothing changed in the checkout, the acceptance kept, and
// the comparison and logs kept where the message says.
function assertRefused(f, r, before, reason) {
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /nothing was merged and t1 stays accepted/);
  assert.match(r.output, reason);
  assert.match(r.output, new RegExp(`in ${kept(f).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`));
  assert.deepEqual({ at: f.at(), tip: f.tip() }, before);
  assert.equal(f.git(f.checkout, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(existsSync(join(f.checkout, '.git', 'MERGE_HEAD')), false);
  assert.equal(f.journal(), null);
  assert.equal(f.box.state, 'accepted');
  assert.ok(keptFiles(f).some((n) => n.endsWith('-verify-accepted.txt')), 'the comparison is kept');
}

test('both sides changed inputs but the regenerated output is the accepted one: the merge goes on, takes the accepted output and records it', async (t) => {
  const f = await landing(t);
  declare(f);
  side(f, f.workspace, { 'in/task.txt': '', 'work.txt': 'task\n' }, 'Task adds an empty input');
  side(f, f.checkout, { 'in/main.txt': '' }, 'Main adds another empty input');
  const accepted = f.box.acceptedHead;
  const r = await f.run('merge', 't1');
  assert.equal(r.status, 0, r.output);
  assert.equal(f.tip(), f.at());
  assert.equal(f.box.state, 'merged');
  assert.equal(readFileSync(join(f.checkout, 'gen.txt'), 'utf8'), 'base\n');
  // The published tree holds the accepted revision's output entry, and the merge commit says where it came from.
  const entry = (rev) => f.git(f.checkout, 'ls-tree', rev, '--', 'gen.txt');
  assert.equal(entry(f.at()), entry(accepted));
  assert.match(f.git(f.checkout, 'log', '-1', '--format=%B'), /Atelier-Regenerated: gen \(sh -c cat in\/\*\.txt > gen\.txt\): gen\.txt matches the accepted revision; log sha256 [0-9a-f]{64}/);
  // Equal-parent outputs: both parents held the same bytes, and the one comparison says so.
  assert.equal(entry(f.git(f.checkout, 'rev-parse', 'HEAD^1')), entry(f.git(f.checkout, 'rev-parse', 'HEAD^2')));
  assert.equal(f.git(f.checkout, 'status', '--porcelain'), '');
});

test('the tree published is the tree that was compared', async (t) => {
  const f = await landing(t);
  declare(f);
  side(f, f.workspace, { 'in/task.txt': '' }, 'Task adds an empty input');
  side(f, f.checkout, { 'in/main.txt': '' }, 'Main adds another empty input');
  const r = await f.run('merge', 't1');
  assert.equal(r.status, 0, r.output);
  const compared = readFileSync(join(kept(f), keptFiles(f).find((n) => n.endsWith('-verify-accepted.txt'))), 'utf8');
  assert.match(compared, /gen\.txt: regenerated 100644 blob [0-9a-f]+, accepted 100644 blob [0-9a-f]+\nverdict: identical/);
  // The compared tree is the merge commit's own: the accepted revision's output beside every other path of the merge.
  const tree = f.git(f.checkout, 'rev-parse', 'HEAD^{tree}');
  assert.equal(f.git(f.checkout, 'ls-tree', '-r', tree, '--', 'gen.txt'), f.git(f.checkout, 'ls-tree', '-r', f.box.acceptedHead, '--', 'gen.txt'));
});

test('a regenerated output that is the baseline\'s and not the accepted revision\'s is refused: nothing was checked or reviewed', async (t) => {
  // Main rewrote an input and its output; the task left the output stale. Merging gives the baseline's bytes, which the accepted revision never held.
  const f = await landing(t);
  declare(f);
  side(f, f.workspace, { 'in/task.txt': '' }, 'Task adds an empty input');
  side(f, f.checkout, { 'in/base.txt': 'main\n', 'gen.txt': 'main\n' }, 'Main rewrites the input and its output');
  const before = { at: f.at(), tip: f.tip() };
  const r = await f.run('merge', 't1');
  assertRefused(f, r, before, /regenerated outputs differ from the accepted revision's: gen\.txt \(regenerated differently from the accepted revision\)/);
});

test('changed output: the regenerated bytes match neither side', async (t) => {
  const f = await landing(t);
  declare(f);
  side(f, f.workspace, { 'in/task.txt': 'task\n', 'gen.txt': 'base\ntask\n' }, 'Task adds an input');
  side(f, f.checkout, { 'in/main.txt': 'main\n', 'gen.txt': 'base\nmain\n' }, 'Main adds an input');
  const before = { at: f.at(), tip: f.tip() };
  const r = await f.run('merge', 't1');
  assertRefused(f, r, before, /gen\.txt \(regenerated differently from the accepted revision\)/);
});

test('an output whose mode differs from the accepted revision\'s is refused though its bytes are the same', async (t) => {
  const f = await landing(t);
  declare(f, 'cat in/*.txt > gen.txt; chmod 755 gen.txt');
  side(f, f.workspace, { 'in/task.txt': '' }, 'Task adds an empty input, output left 644');
  side(f, f.checkout, { 'in/main.txt': '' }, 'Main adds an input');
  const before = { at: f.at(), tip: f.tip() };
  const r = await f.run('merge', 't1');
  assertRefused(f, r, before, /gen\.txt \(regenerated differently from the accepted revision\)/);
});

for (const [name, command, reason] of [
  ['fails', 'cat in/*.txt > gen.txt; echo boom >&2; exit 3', /the generator gen \(sh -c .*\) failed on run 1 \(exit 3\)/],
  ['is not deterministic', 'cat in/*.txt > gen.txt; echo $$ >> gen.txt', /the generator gen is not deterministic/],
  ['writes outside its outputs', 'cat in/*.txt > gen.txt; echo x > stray.txt', /wrote outside its declared outputs: stray\.txt/],
  ['leaves its output out', 'rm -f gen.txt', /did not leave its declared outputs gen\.txt/],
]) {
  test(`a generator that ${name} refuses the merge, keeps its log and leaves the checkout alone`, async (t) => {
    const f = await landing(t);
    declare(f, command);
    side(f, f.workspace, { 'in/task.txt': '' }, 'Task adds an empty input');
    side(f, f.checkout, { 'in/main.txt': '' }, 'Main adds another empty input');
    const before = { at: f.at(), tip: f.tip() };
    const r = await f.run('merge', 't1');
    assertRefused(f, r, before, reason);
    if (name === 'fails') assert.ok(keptFiles(f).some((n) => n.endsWith('-gen.log')), 'the generator log is kept');
  });
}

test('a merge the pipeline stops in the clone (a declaration problem) refuses with the reason the pipeline gives', async (t) => {
  // Main routes the declared output to a text merge, which the pipeline refuses to merge through.
  const f = await landing(t);
  declare(f);
  side(f, f.workspace, { 'in/task.txt': '' }, 'Task adds an empty input');
  side(f, f.checkout, { 'in/main.txt': '' }, 'Main adds another empty input');
  writeFileSync(join(f.checkout, '.gitattributes'), 'gen.txt merge=text\n');
  f.git(f.checkout, 'commit', '-q', '-am', 'Main routes the output elsewhere'); f.git(f.checkout, 'push', '-q', f.baseline, 'HEAD:main');
  const before = { at: f.at(), tip: f.tip() };
  const r = await f.run('merge', 't1');
  assertRefused(f, r, before, /gen\.txt is declared in bin\/merge-manifest\.json but \.gitattributes routes it to merge=text, not merge=atelier-generated/);
});
