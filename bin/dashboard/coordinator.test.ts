// A route makes the page jump to an issue and re-send Troy's message there, so
// only a valid open_thread call may produce one.
import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import { routeOf } from './coordinator.ts';

test('only a valid open_thread call routes', () => {
  assert.deepEqual(routeOf('mcp__github__open_thread', { repo: 'devkit', number: 71 }), {
    type: 'route',
    repo: 'devkit',
    number: 71,
  });
  assert.equal(
    routeOf('mcp__github__file_ask', { repo: 'scratch', title: 't', mode: 'queue' }),
    null,
  );
  assert.equal(routeOf('mcp__github__read_issue', { repo: 'devkit', number: 71 }), null);
  assert.equal(routeOf('mcp__github__open_thread', { repo: '../x', number: 1 }), null);
  assert.equal(routeOf('mcp__github__open_thread', { repo: 'devkit', number: 0 }), null);
});
