// Part 1 of 2 of the tests that were in landing-states.test.mjs, split so no file runs for more than about a minute (t771).
// The states of a landing, and the way out of each. `atelier merge ID`
// lands an accepted task in the owner's checkout: it writes a journal under
// the CLI's cache (cli/landing.mjs), merges and commits in the checkout,
// takes the landing lease on the server, publishes the merge commit to the
// baseline, and records the merge. Each state says what is true in the
// checkout and on the server, and what each command does from it. merge,
// merge --cancel and sync each hold the checkout's landing lock while they
// run, so none of them runs beside another: a cancel never meets a merge of
// the same checkout halfway through its publication. Where merge --cancel
// asks whether the baseline holds a commit, it fetches the baseline and Git
// reads its whole history.
//
// none: no journal. merge starts a landing. merge --cancel ends any lease
//   the item holds, unless the baseline holds the accepted revision; that
//   merge is recorded by the checkout that made it. sync and wrap go ahead.
// prepared: the journal names the accepted revision, the commit the merge
//   starts from and the baseline's head; the checkout is on that start. The
//   item is accepted at the revision, with no lease. merge goes on; merge
//   --cancel removes the journal and ends any lease; sync and wrap refuse.
// merging: stopped inside the Git merge, which is in progress on the start
//   with the accepted revision's tree incoming. merge refuses the
//   uncommitted changes. merge --cancel keeps the Git merge unless
//   --discard-local, which aborts it.
// committed: the merge commit is made and the journal names it, or the
//   process stopped first and the commit is found by its parents and its
//   line `Atelier: PROJECT/ID accepted at REVISION`. Until the lease is
//   taken, a push or a review on the server can withdraw the acceptance,
//   and another revision can then be accepted. merge takes the lease while
//   the item is accepted at the journal's revision, and otherwise refuses,
//   naming the cancel. merge --cancel keeps the commit unless
//   --discard-local, which puts the branch back on the start while it is
//   still on the commit with nothing uncommitted, and otherwise changes
//   nothing and says how to get there; a branch already back on the start
//   needs no flag. It ends the lease only while the item is accepted at the
//   journal's revision: a lease is taken for the accepted revision alone and
//   nothing moves the acceptance while one is held, so after a change of
//   acceptance there is no lease of this landing's to end. Nor does it when
//   the baseline holds the accepted revision through a merge made
//   elsewhere: that lease is left for that merge to be recorded.
// leased: as committed, and the server holds the lease, so no push or
//   review moves the acceptance. merge publishes. merge --cancel ends the
//   lease, which the server refuses once the merge is on the baseline.
// published: the baseline holds the merge commit (or, for a baseline that
//   holds part of the history, its rebuilt twin), and the journal says so
//   once the push returns. merge records the merge, with the branch on the
//   merge commit, and otherwise names the commit to put it back on. merge
//   --cancel refuses, with or without --discard-local, and the checkout
//   keeps the merge: it reads the journal, and the baseline's whole history
//   for a push that returned just before the process stopped. When the item
//   is no longer accepted at the journal's revision, so that the server
//   cannot record the merge, merge --cancel removes the journal and keeps the
//   merge, as the baseline does.
// recorded: the server says merged, and the journal is still there. merge
//   and merge --cancel remove the journal and keep the merge.
//
// Every test runs the real CLI against a stand-in ledger on 127.0.0.1, in
// scratch repositories, and leaves the landing in one of these states the
// way an interrupted process or a change on the server would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { landing, assertRestored } from "./landing-states-shared.mjs";
// The owner's checkout, its baseline and a task's fork with the task's first
// revision, served by a stand-in ledger whose answers come from `box`: the
// item's state, head and accepted revision, the landing lease, and one-shot
// failures. A `gate` promise holds the answer to the next lease request until
// it settles, as a slow server would. `withdraw` makes the next lease request find the acceptance
// withdrawn by a push, as the server's recordPush does in that window. With
// `fresh`, the baseline holds the checkout's history rebuilt from its last
// commit, as atelier init --history-since makes it.
// ── a merge on the baseline ─────────────────────────────────────────────────

// The merge is pushed and the server fails to record it: the journal says
// published. A cancel, with or without --discard-local, refuses and keeps
// the checkout on the merge, whatever the server would allow. The same holds
// when the process stopped after the push returned and before the journal
// said so: the merge commit is found in the baseline's history. merge then
// records the merge.
for (const fresh of [false, true]) {
  test(`a published merge is never cancelled, and merge records it${fresh ? ', on a baseline that holds part of the history' : ''}`, async (t) => {
    const f = await landing(t, { fresh });
    f.box.failMerge = true;
    const first = await f.run('merge', 't1');
    assert.equal(first.status, 4, first.output);
    const merged = f.at();
    assert.equal(f.journal().phase, 'published');
    // A baseline with part of the history holds the merge's rebuilt twin.
    const sent = f.tip();
    if (fresh) assert.notEqual(sent, merged); else assert.equal(sent, merged);
    const refusal = `t1's merge ${sent.slice(0, 8)} is already on the baseline, so the landing cannot be cancelled, and the checkout keeps it.\nRecord the merge with: atelier merge t1\n`;

    for (const step of ['committed', 'published']) {
      f.rewrite({ phase: step });
      for (const flags of [['--discard-local'], []]) {
        f.box.requests.length = 0;
        const cancel = await f.run('merge', 't1', '--cancel', ...flags);
        assert.equal(cancel.status, 1, `${step} ${flags}: ${cancel.output}`);
        assert.ok(cancel.output.includes(refusal), cancel.output);
        assert.equal(f.at(), merged);
        assert.equal(f.journal().phase, step);
        assert.ok(!f.asked('/landing', true), 'the lease stays');
      }
    }

    const recorded = await f.run('merge', 't1');
    assert.equal(recorded.status, 0, recorded.output);
    assert.equal(f.box.state, 'merged');
    assert.equal(f.at(), merged);
    assert.equal(f.tip(), sent);
    assert.equal(f.journal(), null);
  });
}


// A merge removes the task's workspace on this Mac once its HEAD is in main
// or the head Atelier recorded (t561); one with a changed tracked file is
// kept and named, and a later merge run removes it once it is clean.
test('a merge removes the task\'s workspace once its work is in main, and keeps one holding more', async (t) => {
  const f = await landing(t);
  const ws = join(f.cache, 'work', 'proj', 't1');
  mkdirSync(join(f.cache, 'work', 'proj'), { recursive: true });
  f.git(f.p, 'clone', '-q', f.fork, ws);
  f.git(ws, 'config', 'atelier.project', 'proj'); f.git(ws, 'config', 'atelier.item', 't1');
  writeFileSync(join(ws, 'work.txt'), 'not committed\n');
  const first = await f.run('merge', 't1');
  assert.equal(first.status, 0, first.output);
  assert.equal(f.box.state, 'merged');
  assert.ok(first.output.includes(`Kept t1's workspace ${ws}: contains changed or untracked files`), first.output);
  assert.ok(existsSync(ws));
  // Behind the accepted head, its HEAD is in main.
  f.git(ws, 'reset', '-q', '--hard', 'HEAD~1');
  const again = await f.run('merge', 't1');
  assert.equal(again.status, 0, again.output);
  assert.ok(again.output.includes(`Removed t1's workspace ${ws}`), again.output);
  assert.ok(!existsSync(ws));
});


// The ledger failed the read that comes before the workspace's removal, and
// the merge, already made, exited 4 before what follows it (t561 pre-review).
test('a ledger that fails after the merge leaves the workspace and does not fail the merge', async (t) => {
  const f = await landing(t);
  const ws = join(f.cache, 'work', 'proj', 't1');
  mkdirSync(join(f.cache, 'work', 'proj'), { recursive: true });
  f.git(f.p, 'clone', '-q', f.fork, ws);
  f.git(ws, 'config', 'atelier.project', 'proj'); f.git(ws, 'config', 'atelier.item', 't1');
  f.box.failItemAfterMerge = true;
  const r = await f.run('merge', 't1');
  assert.equal(r.status, 0, r.output);
  assert.equal(f.box.state, 'merged');
  assert.ok(r.output.includes("t1's workspace was left in place: temporary: ledger down"), r.output);
  assert.ok(r.output.includes('The project branch was not pushed to its own remotes.'), r.output);
  assert.ok(existsSync(ws));
});


// The server recorded the merge and the process stopped before it removed
// the journal. merge --cancel removes it and keeps the merge.
test('a recorded merge whose journal is left: cancel removes the journal and keeps the merge', async (t) => {
  const f = await landing(t);
  f.box.failMerge = true;
  assert.equal((await f.run('merge', 't1')).status, 4);
  const left = readFileSync(f.journalFile, 'utf8'), merged = f.at();
  assert.equal((await f.run('merge', 't1')).status, 0);
  writeFileSync(f.journalFile, left);
  f.box.requests.length = 0;
  const cancel = await f.run('merge', 't1', '--cancel', '--discard-local');
  assert.equal(cancel.status, 0, cancel.output);
  assert.equal(cancel.output, `t1 is already merged as ${merged.slice(0, 8)}. The landing journal is removed; the checkout keeps the merge.\n`);
  assert.equal(f.at(), merged);
  assert.equal(f.journal(), null);
  assert.ok(!f.asked('/landing'));
});


// A merge commit that never reached the baseline is still cancelled: the
// lease ends and the checkout goes back to the start.
test('an unpublished merge is cancelled after the baseline is read', async (t) => {
  const f = await landing(t);
  f.box.failLanding = true;
  assert.equal((await f.run('merge', 't1')).status, 4);
  assert.equal(f.journal().phase, 'committed');
  f.box.requests.length = 0;
  const kept = await f.run('merge', 't1', '--cancel');
  assert.equal(kept.status, 1, kept.output);
  assert.match(kept.output, /the checkout holds this merge's unpublished commit/);
  const cancelled = await f.run('merge', 't1', '--cancel', '--discard-local');
  assert.equal(cancelled.status, 0, cancelled.output);
  assert.equal(f.at(), f.start);
  assert.equal(f.journal(), null);
  assert.ok(f.asked('/baseline-token') && f.asked('/landing', true));
});
// The checkout as the merge found it: on its start, with nothing uncommitted and no Git merge in progress.
// A merge pushed and not recorded, whose checkout the owner moved back to
// the start by hand. Cancel still refuses and says which commit the branch
// needs; merge names it too, and records the merge once the branch is back.
test('a published merge with the branch moved off it: cancel and merge name the commit to put it back on', async (t) => {
  const f = await landing(t);
  f.box.failMerge = true;
  assert.equal((await f.run('merge', 't1')).status, 4);
  const merged = f.at();
  f.git(f.checkout, 'reset', '-q', '--hard', f.start);
  const cancel = await f.run('merge', 't1', '--cancel', '--discard-local');
  assert.equal(cancel.status, 1, cancel.output);
  assert.ok(cancel.output.includes(`t1's merge ${merged.slice(0, 8)} is already on the baseline, so the landing cannot be cancelled, and the checkout keeps it.\nRecord the merge with: atelier merge t1\nmain no longer holds the merge commit ${merged.slice(0, 8)}; put it back on that commit before the next merge.\n`), cancel.output);
  const retry = await f.run('merge', 't1');
  assert.equal(retry.status, 1, retry.output);
  assert.ok(retry.output.includes(`the checkout moved after the merge: main is at ${f.start.slice(0, 8)}, not at the merge commit ${merged.slice(0, 8)}. Put main back on ${merged.slice(0, 8)}, moving any commits of yours off it, then run atelier merge t1 again, or cancel the landing with: atelier merge t1 --cancel\n`), retry.output);
  f.git(f.checkout, 'merge', '-q', '--ff-only', merged);
  const recorded = await f.run('merge', 't1');
  assert.equal(recorded.status, 0, recorded.output);
  assert.equal(f.box.state, 'merged');
  assert.equal(f.journal(), null);
});


// The merge is pushed, and the task is abandoned before the merge is
// recorded, which the server allows under a lease: the merge can no longer
// be recorded. merge refuses the landing and names the cancel, which removes
// the journal and keeps the merge, as the baseline does.
test('a published merge the server can no longer record: cancel removes the journal and keeps the merge', async (t) => {
  const f = await landing(t);
  f.box.failMerge = true;
  assert.equal((await f.run('merge', 't1')).status, 4);
  const merged = f.at();
  f.box.state = 'abandoned';
  const retry = await f.run('merge', 't1');
  assert.equal(retry.status, 1, retry.output);
  assert.ok(retry.output.includes(`t1 is abandoned, no longer accepted at ${f.H1.slice(0, 8)}, where this checkout began landing it, so that landing cannot be finished. Cancel it with: atelier merge t1 --cancel --discard-local\n`), retry.output);
  f.box.requests.length = 0;
  const cancel = await f.run('merge', 't1', '--cancel', '--discard-local');
  assert.equal(cancel.status, 0, cancel.output);
  assert.equal(cancel.output, `t1's merge ${merged.slice(0, 8)} is on the baseline, but t1 is abandoned, so Atelier cannot record it. The landing journal is removed; the checkout keeps the merge, as the baseline does.\n`);
  assert.equal(f.at(), merged);
  assert.equal(f.tip(), merged);
  assert.equal(f.journal(), null);
  assert.ok(!f.asked('/landing'));
});


// ── an acceptance that moves after the merge commit ─────────────────────────

// A push lands between the merge commit and the lease, and withdraws the
// acceptance. The landing cannot be finished, and both merge and merge
// --cancel name the way out, which restores the checkout and leaves the
// server alone: there is no lease of this landing's to end.
test('an acceptance withdrawn before the lease: merge and cancel say so, and cancel --discard-local restores the checkout', async (t) => {
  const f = await landing(t);
  f.box.withdraw = true;
  const first = await f.run('merge', 't1');
  assert.equal(first.status, 1, first.output);
  assert.match(first.output, /acceptance_changed/);
  const merged = f.at();
  assert.notEqual(merged, f.start);
  assert.equal(f.journal().phase, 'committed');
  assert.equal(f.journal().mergeCommit, merged);

  f.box.requests.length = 0;
  const retry = await f.run('merge', 't1');
  assert.equal(retry.status, 1, retry.output);
  assert.ok(retry.output.includes(`t1 is claimed, no longer accepted at ${f.H1.slice(0, 8)}, where this checkout began landing it, so that landing cannot be finished. Cancel it with: atelier merge t1 --cancel --discard-local\n`), retry.output);
  assert.ok(!f.asked('/baseline-token'), 'the refusal comes before the landing reads the baseline');

  const kept = await f.run('merge', 't1', '--cancel');
  assert.equal(kept.status, 1, kept.output);
  assert.ok(kept.output.includes(`t1 is claimed, no longer accepted at ${f.H1.slice(0, 8)}, the revision this landing merged, so the landing cannot be finished. The checkout holds this merge's unpublished commit ${merged.slice(0, 8)} on top of ${f.start.slice(0, 8)}.\nRemove it with: atelier merge t1 --cancel --discard-local\n`), kept.output);
  assert.equal(f.at(), merged);
  assert.equal(f.journal().mergeCommit, merged);

  const cancelled = await f.run('merge', 't1', '--cancel', '--discard-local');
  assert.equal(cancelled.status, 0, cancelled.output);
  assert.match(cancelled.output, /Removed the unpublished merge commit; main is back at /);
  assert.match(cancelled.output, /t1: the landing in this checkout is cancelled\. t1 is claimed, and nothing changed on the server\.\n$/);
  assertRestored(f);
  assert.ok(!f.asked('/landing', true), 'no lease of this landing is cancelled');
});
