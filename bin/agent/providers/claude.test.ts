// A run that loaded a stray tool or an API-key login looks the same as one that
// didn't; this pins the guard that stops it.

import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import { ROLES } from '../roles.ts';
import { assertClaudeInit, claudeOptions } from './claude.ts';

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
});
