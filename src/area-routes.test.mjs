import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentRoute, runnerRoute } from './tokens.ts';

test('agents can only read board and area collections; runners cannot reach either', () => {
  for (const section of ['board', 'areas']) {
    for (const suffix of [[], ['a1'], ['a1', 'extra']]) {
      const path = ['projects', 'demo', section, ...suffix];
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        assert.equal(agentRoute(method, path), method === 'GET' && suffix.length === 0, `${method} ${path}`);
        assert.equal(runnerRoute(method, path), false, `runner ${method} ${path}`);
      }
    }
  }
});
