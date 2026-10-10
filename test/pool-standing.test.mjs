import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { suggestBuilder } from '../src/models/suggest.ts';
import { suggestReviewer } from '../src/review/suggest.ts';
import { actorStanding, cleanEntry, standingRefusal } from '../src/models/pool.ts';
import { standingRoute } from '../src/plans/route.ts';
import { planActions } from '../src/plans/phase.ts';

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

// The owner's standing binds a model by modelKey: letter case, a ":profile"
// suffix and the harness do not take it past a held entry.
test('an actor named with a profile, another letter case or another harness is held as its entry is', () => {
  for (const [name, change, why] of [...HELD.slice(0, 2), ['build-only', { roles: ['build'] }, /not a reviewer; its roles are build/]]) {
    const pool = [entry('gpt-6-astra', 'codex', change), entry('gemini-3', 'gemini-cli')];
    for (const actor of ['codex/gpt-6-astra', 'codex/gpt-6-astra:high', 'CODEX/GPT-6-Astra:fast', 'opencode/gpt-6-astra']) {
      assert.match(actorStanding(pool, actor, 'review') ?? '', new RegExp(`^${actor.replace(/[/.]/g, '\\$&')} is ${why.source}`), `${name} ${actor}`);
    }
    assert.equal(actorStanding(pool, 'gemini-cli/gemini-3:high', 'review'), null, name);
  }
  // The entry under the actor's own harness is the one whose standing holds.
  const pool = [entry('gpt-6-astra', 'codex', { roles: ['review'] }), entry('gpt-6-astra', 'opencode')];
  assert.match(actorStanding(pool, 'codex/gpt-6-astra:high', 'build'), /not a builder/);
  assert.equal(actorStanding(pool, 'opencode/gpt-6-astra:high', 'build'), null);
  // A dispatch suggestion named by a profile is refused as the plain name is.
  assert.throws(() => suggestBuilder(input([entry('opus-5.5', 'claude-code', { state: 'paused', stateAt: AT })]), { model: 'opus-5.5:high' }), /paused since/);
});

// A plan's tick dispatches from the routes saved at approval, read through
// standingRoute with the pool as it is now: a part that becomes ready after
// its builder was held goes to the next routed builder free to build, and a
// part with none left blocks the plan with who was held and why.
test("a plan's tick never dispatches a builder held since approval, named plainly or by a profile", () => {
  const ASTRA = 'codex/gpt-6-astra';
  const plan = { schema: 'atelier.plan.v1', goal: 'g', parts: [
    { key: 'a', dependsOn: [] },
    { key: 'b', dependsOn: ['a'] },
  ] };
  const parts = [{ key: 'a', state: 'merged' }, { key: 'b', state: 'open' }];
  const route = (builder, alternates) => ({ key: 'b', builder: { actor: builder, reasons: [] }, alternates: alternates.map((actor) => ({ actor, reasons: [] })), reviewer: { actor: 'gemini-cli/gemini-3', reasons: [] }, excluded: [], unrouted: null });
  const tick = (routes) => planActions({ plan, parts, routes, events: [], now: AT });
  for (const [name, change, why] of HELD) {
    const pool = [entry('gpt-6-astra', 'codex', change), entry('opus-5.5', 'claude-code')];
    for (const builder of [ASTRA, `${ASTRA}:high`]) {
      assert.deepEqual(tick([standingRoute(route(builder, [OPUS]), pool)]).dispatch.map((d) => d.to), [OPUS], `${name} ${builder}`);
      const alone = tick([standingRoute(route(builder, []), pool)]);
      assert.deepEqual(alone.dispatch, [], `${name} ${builder}`);
      assert.match(alone.blocked, new RegExp(`part b is unrouted: every routed builder is held: .*${why.source}`), `${name} ${builder}`);
      // An alternate held as well is passed over too.
      assert.deepEqual(tick([standingRoute(route(OPUS, [builder]), [...pool.slice(0, 1), entry('opus-5.5', 'claude-code', change)])]).dispatch, [], `${name} ${builder}`);
    }
  }
  // A route with nothing held is left as it was.
  const free = route(ASTRA, [OPUS]);
  assert.equal(standingRoute(free, [entry('gpt-6-astra', 'codex')]), free);
});

const ROOT = new URL('..', import.meta.url).pathname;
// Every path that chooses or accepts a model, and the check it must call.
const PATHS = [
  ['src/models/suggest.ts', 'suggestBuilder', 'standingRefusal(', 'dispatch suggestions (atelier dispatch --suggest)'],
  ['src/plans/route.ts', 'judge', 'standingRefusal(', "a plan's routing of builders and reviewers"],
  ['src/plans/route.ts', 'standingRoute', 'actorStanding(', "a plan's saved routes as each tick reads them"],
  ['src/ledger.ts', 'tick', 'standingRoute(', 'every plan dispatch, from the saved routes'],
  ['src/ledger.ts', 'tick', 'actorStanding(', 'a part waiting on a builder held since it was dispatched'],
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
