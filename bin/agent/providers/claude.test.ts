// A run that loaded a stray tool or an API-key login looks the same as one that
// didn't; this pins the guard that stops it.

import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import { ROLES } from '../roles.ts';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { assertClaudeInit, claudeFailure, claudeOptions } from './claude.ts';
import { codexFailure } from './codex.ts';

test('every role passes its turn cap to Claude', () => {
  const defaults = {
    hello: 10,
    plan: 100,
    build: 200,
    repair: 200,
    review: 100,
    retro: 50,
    elevated: 200,
  };
  for (const [name, role] of Object.entries(ROLES)) {
    const options = claudeOptions(role, {
      cwd: '/w',
      executable: '/bin/claude',
      env: {},
      instructions: '',
    });
    assert.equal(options.maxTurns, defaults[name as keyof typeof defaults], name);
    assert.equal(options.maxTurns, role.maxTurns, name);
  }
});

test('Claude init outside the role stops the run', () => {
  const options = claudeOptions(ROLES.hello, {
    cwd: '/w',
    executable: '/bin/claude',
    env: {},
    instructions: '',
  });
  const clean = { apiKeySource: 'none', tools: ['Bash', 'Read'] };
  assert.doesNotThrow(() => assertClaudeInit(clean, options));
  assert.throws(() => assertClaudeInit({ ...clean, apiKeySource: 'ANTHROPIC_API_KEY' }, options));
  assert.throws(() =>
    assertClaudeInit({ ...clean, tools: ['Bash', 'Read', 'mcp__neon__run_sql'] }, options),
  );
  assert.throws(
    () =>
      assertClaudeInit({ ...clean, tools: ['Bash', 'Read', 'mcp__context7__query-docs'] }, options),
    'a role without web gets no docs server',
  );
});

test('a web role may load Context7 and nothing else from MCP', () => {
  const options = claudeOptions(ROLES.review, {
    cwd: '/w',
    executable: '/bin/claude',
    env: {},
    instructions: '',
  });
  const tools = [...ROLES.review.tools, 'WebSearch', 'WebFetch', 'mcp__context7__query-docs'];
  assert.doesNotThrow(() => assertClaudeInit({ apiKeySource: 'none', tools }, options));
  assert.throws(() =>
    assertClaudeInit({ apiKeySource: 'none', tools: [...tools, 'mcp__neon__run_sql'] }, options),
  );
});

test("each CLI's failure maps to its class, with a rate limit's reset time when given", () => {
  const limit = {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: 1_791_950_400 },
  } as SDKMessage;
  assert.deepEqual(claudeFailure(limit), {
    class: 'rate_limit',
    resetsAt: '2026-10-14T04:00:00.000Z',
  });
  const allowed = { ...limit, rate_limit_info: { status: 'allowed_warning' } } as SDKMessage;
  assert.equal(claudeFailure(allowed), undefined, 'a warning is not a failure');
  const turns = { type: 'result', subtype: 'error_max_turns' } as SDKMessage;
  assert.equal(claudeFailure(turns)?.class, 'timeout');
  const api = { type: 'result', subtype: 'success', is_error: true, api_error_status: 529 };
  assert.equal(claudeFailure(api as SDKMessage)?.class, 'overloaded');

  assert.equal(
    codexFailure("You've hit your usage limit. Try again at 3:05 AM.").class,
    'rate_limit',
  );
  assert.equal(codexFailure('unexpected status 503 Service Unavailable').class, 'overloaded');
  assert.equal(codexFailure('500 Internal Server Error').class, 'server_error');
  assert.equal(codexFailure('model refused').class, 'unknown');
});
