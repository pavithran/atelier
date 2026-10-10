import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { suggestBuilder } from '../src/models/suggest.ts';
import { suggestReviewer } from '../src/review/suggest.ts';
import { cleanEntry, standingRefusal } from '../src/models/pool.ts';

// The owner's standing for a model (paused, reserved, its roles) is checked in
// one place, standingRefusal in src/models/pool.ts, and every path that
// chooses or accepts a model calls it before it does. The list below is every
// such path; a new one is added here, and one that stops calling the check
// fails this test.

const AT = '2026-10-09T00:00:00.000Z';
const entry = (id, harness = 'codex', more = {}) => ({ ...cleanEntry({ id, harness, where: 'home' }, 'owner', AT), ...more });
const OPUS = 'claude-code/opus-5.5';
const item = { id: 't1', title: 'Improve formatting', scope: ['docs/**'], owner: 'codex/gpt-6.1-sol', pushActors: [] };
const policy = { eligible: ['codex', 'claude-code', 'gemini-cli'], checks: [], protected: [] };
const input = (pool) => ({ item, project: 'p', pool, policy, sources: [], runs: [] });
const HELD = [
  ['paused', { state: 'paused', stateAt: AT, note: 'AI Studio down' }, /paused since 2026-10-09 \(the owner's standing\): AI Studio down/],
  ['reserved', { state: 'reserved', stateAt: AT, note: "astra's credits" }, /reserved since 2026-10-09 \(the owner's standing\): astra's credits/],
  ['review-only', { roles: ['review'] }, /not a builder; its roles are review/],
];

test('a dispatch suggestion never names a paused, reserved or review-only builder, and says why it passed it over', () => {
  for (const [name, change, why] of HELD) {
    const opus = entry('opus-5.5', 'claude-code', change);
    assert.throws(() => suggestBuilder(input([opus])), (e) => e.code === 'no_builder' && why.test(e.message), name);
    const pick = suggestBuilder(input([opus, entry('gemini-3', 'gemini-cli')]));
    assert.equal(pick.actor, 'gemini-cli/gemini-3', name);
    assert.match(pick.reasons.join(' '), new RegExp(`Passed over ${OPUS}: ${why.source}`), name);
    // Named with --model, the held model is still refused.
    assert.throws(() => suggestBuilder(input([opus, entry('gemini-3', 'gemini-cli')]), { model: 'opus-5.5' }), why, name);
  }
  assert.equal(suggestBuilder(input([entry('opus-5.5', 'claude-code', { roles: ['build'] })])).actor, OPUS);
});

test('a reviewer suggestion never names a paused, reserved or build-only model', () => {
  for (const [name, change] of [HELD[0], HELD[1], ['build-only', { roles: ['build'] }]]) {
    const pick = suggestReviewer(input([entry('opus-5.5', 'claude-code', change), entry('gemini-3', 'gemini-cli')]));
    assert.equal(pick.actor, 'gemini-cli/gemini-3', name);
  }
});

test('the one check names the role it refuses and passes a model free for it', () => {
  assert.equal(standingRefusal(entry('x'), 'build'), null);
  assert.equal(standingRefusal(entry('x', 'codex', { roles: ['review'] }), 'review'), null);
  assert.match(standingRefusal(entry('x', 'codex', { roles: ['build'] }), 'plan'), /not a planner; its roles are build/);
  assert.match(standingRefusal(entry('x', 'codex', { state: 'reserved', stateAt: AT }), 'review'), /reserved since 2026-10-09/);
});

const ROOT = new URL('..', import.meta.url).pathname;
// Every path that chooses or accepts a model, and the check it must call.
const PATHS = [
  ['src/models/suggest.ts', 'suggestBuilder', 'standingRefusal(', 'dispatch suggestions (atelier dispatch --suggest)'],
  ['src/plans/route.ts', 'judge', 'standingRefusal(', "a plan's routing of builders and reviewers"],
  ['src/plans/state.ts', 'pickPlanner', 'standingRefusal(', "a plan's default planner"],
  ['src/review/reviewer.ts', 'judge', 'standingRefusal(', 'pickReviewer: plan reviews, landing reviews, reviewer suggestions'],
  ['src/review/suggest.ts', 'suggestReviewer', 'pickReviewer(', 'reviewer suggestions, through pickReviewer'],
  ['src/ledger.ts', 'assertStanding', 'actorStanding(', 'every model the owner names'],
  ['src/ledger.ts', 'requestReview', 'this.assertStanding(', 'a named reviewer (atelier land --reviewer)'],
  ['src/ledger.ts', 'newPlan', 'this.assertStanding(', 'a named planner (atelier plan --planner)'],
  ['src/ledger.ts', 'reroutePlan', 'this.assertStanding(', 'a named planner or builder (atelier plan reroute)'],
  ['src/ledger.ts', 'rerouteReviewer', 'this.assertStanding(', "a named reviewer of a plan's part"],
  ['src/ledger.ts', 'reviewTick', 'actorStanding(', "a plan's reviews and their open requests"],
  ['src/ledger.ts', 'askTierReview', 'actorStanding(', 'tier reviews'],
  ['src/ledger.ts', 'reaskReview', 'actorStanding(', 'a request carried when the head moves'],
  ['src/ledger.ts', 'reaskForCriteria', 'actorStanding(', 'a request carried when the criteria change'],
];

// The body of a top-level function or a class method, up to the next one.
function body(file, name) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const start = new RegExp(`^(?:export )?(?:async )?function ${name}\\(|^  (?:private )?(?:async )?${name}\\(`, 'm').exec(text);
  assert.ok(start, `${file} has no function ${name}`);
  const rest = text.slice(start.index + start[0].length);
  const next = /^(?:export )?(?:async )?function \w+\(|^  (?:private )?(?:async )?\w+\(.*\{\s*$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

test('every path that chooses or accepts a model calls the one standing check', () => {
  for (const [file, name, call, what] of PATHS) {
    assert.ok(body(file, name).includes(call), `${file} ${name} (${what}) does not call ${call.replace(/\($/, '')}`);
  }
});

test('no path checks the state or roles on its own, outside the one check', () => {
  const files = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true })
    .flatMap((d) => d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []);
  const strays = files('src').filter((f) => f !== join('src', 'models', 'pool.ts'))
    .filter((f) => /\b(offThePool|hasModelRole)\(/.test(readFileSync(join(ROOT, f), 'utf8')));
  assert.deepEqual(strays, []);
});
