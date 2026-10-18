// A route makes the page jump to an issue and re-send Troy's message there, so
// only a valid open_thread call may produce one.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { test } from 'vite-plus/test';

import { ASK_LABELS, coordinatorOptions, routeOf, turnEvents } from './coordinator.ts';

test('both ask modes include filing provenance and only start adds a stage label', () => {
  assert.deepEqual(ASK_LABELS.queue, ['agent:filed', 'ready-for-agent']);
  assert.deepEqual(ASK_LABELS.start, ['agent:filed', 'ready-for-agent', 'agent:plan']);
});

test('SDK note, tool call, tool result and answer become ordered turn events', async () => {
  // Only fields read by turnEvents; SDK transport metadata is irrelevant here.
  const messages = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'note' }] } },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__github__read_issue', input: {} }],
      },
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'issue details' }],
      },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } },
    { type: 'result', subtype: 'success', is_error: false },
  ] as SDKMessage[];
  async function* sdkMessages() {
    yield* messages;
  }
  assert.deepEqual(await Array.fromAsync(turnEvents(sdkMessages(), {})), [
    { type: 'text', text: 'note' },
    { type: 'tool', name: 'mcp__github__read_issue' },
    { type: 'text', text: 'answer' },
    { type: 'done', ok: true },
  ]);
});

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

test('coordinator init allows only its configured GitHub server', async () => {
  const options = coordinatorOptions({ PATH: bin }, undefined, true);
  async function* init(tool: string) {
    yield {
      type: 'system',
      subtype: 'init',
      apiKeySource: 'none',
      session_id: 'session',
      tools: [tool],
    } as SDKMessage;
  }
  assert.deepEqual(await Array.fromAsync(turnEvents(init('mcp__github__read_issue'), options)), [
    { type: 'session', id: 'session' },
  ]);
  await assert.rejects(
    Array.fromAsync(turnEvents(init('mcp__unexpected__tool'), options)),
    /tools the role does not allow/,
  );
});
