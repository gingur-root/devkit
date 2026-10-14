// A route makes the page jump to an issue and re-send Troy's message there, so
// only a valid open_thread call may produce one.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vite-plus/test';

import { coordinatorOptions, routeOf } from './coordinator.ts';

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

// The options need a claude on PATH; CI has none, so a stub stands in.
const bin = mkdtempSync(join(tmpdir(), 'coordinator-'));
writeFileSync(join(bin, 'claude'), '', { mode: 0o755 });

// The SDK exposes no public tool list; the registered names are what the CLI sees at init.
function toolNames(home: boolean): string[] {
  const github = coordinatorOptions({ PATH: bin }, undefined, home).mcpServers
    ?.github as unknown as { instance: { _registeredTools: object } };
  return Object.keys(github.instance._registeredTools);
}

test('only home turns can route (devkit#104)', () => {
  assert.ok(toolNames(true).includes('open_thread'));
  assert.ok(!toolNames(false).includes('open_thread'));
  assert.ok(toolNames(false).includes('read_issue'));
});
