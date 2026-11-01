import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertClaimAllowed, RuleError } from '../src/rules.ts';

const now = new Date('2026-11-01T12:00:00Z');
const old = '2026-10-29T12:00:00Z';
const fresh = '2026-11-01T11:00:00Z';
const item = (id, over = {}) => ({ id, title: id, scope: ['src/**'], state: 'submitted', owner: 'codex/gpt-6', workspace: `demo/t/${id.slice(1)}`, base: null, head: 'a'.repeat(40), acceptedHead: null, createdAt: old, updatedAt: old, lastPushAt: old, ...over });
const want = item('t9', { state: 'open', owner: null });
const refusal = (holders, policy = {}, scopes = {}) => {
  try { assertClaimAllowed(want, holders, { checks: [], protected: [], refuseOverlap: true, ...policy }, 'claude-code/opus-5.5', 'owner', 'executor', { now, scopes }); }
  catch (err) { assert.ok(err instanceof RuleError); assert.equal(err.code, 'overlap'); return err; }
  assert.fail('claim must be refused');
};

test('overlap names every holder and idle age, including unscoped holders of a scoped claim', () => {
  const err = refusal([item('t157', { scope: [] }), item('t159', { owner: 'opencode/glm-5.3', updatedAt: fresh, lastPushAt: fresh })]);
  assert.match(err.detail, /t157 \(codex\/gpt-6, idle 3 days\)/);
  assert.match(err.detail, /t159 \(opencode\/glm-5.3, idle 1 hour\)/);
  assert.match(err.detail, /unscoped (?:task|item) overlaps everything/);
});

test('next names each holder task to narrow, and releases only holders past the stuck limit', () => {
  const err = refusal([item('t157', { scope: [] }), item('t159', { updatedAt: fresh, lastPushAt: fresh })]);
  assert.match(err.next, /only the developer can/);
  assert.match(err.next, /atelier edit t157 --scope GLOB/);
  assert.match(err.next, /atelier edit t159 --scope GLOB/);
  assert.match(err.next, /atelier release t157/);
  assert.doesNotMatch(err.next, /atelier release t159/);
});

test('release advice respects project silence limit and latest activity at its boundary', () => {
  const holder = item('t157', { updatedAt: fresh });
  assert.match(refusal([holder], { silenceLimitMinutes: 30 }).next, /atelier release t157/);
  assert.doesNotMatch(refusal([holder], { silenceLimitMinutes: 60 }).next, /atelier release/);
  assert.doesNotMatch(refusal([holder], { silenceLimitMinutes: 120 }).next, /atelier release/);
  assert.doesNotMatch(refusal([item('t157', { lastPushAt: fresh })]).next, /atelier release/);
});

test('unscoped branch changes become quoted ready-to-run scope flags; unavailable changes keep GLOB', () => {
  const holders = [item('t157', { scope: [] }), item('t159', { scope: [] })];
  const err = refusal(holders, {}, { t157: ['src/a.ts', "docs/it's here.md"] });
  assert.ok(err.next.includes(`atelier edit t157 --scope 'src/a.ts' --scope 'docs/it'"'"'s here.md'`), err.next);
  assert.match(err.next, /atelier edit t159 --scope GLOB/);
  assert.match(refusal([item('t157')], {}, { t157: ['docs/a.md'] }).next, /atelier edit t157 --scope GLOB/, 'declared scopes are not replaced by measured files');
});
