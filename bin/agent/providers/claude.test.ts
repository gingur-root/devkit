// A run that loaded a stray tool, MCP server or API-key login looks the same
// as one that didn't; these pin the guards that stop it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ROLES } from '../roles.ts';
import { assertClaudeInit, claudeOptions } from './claude.ts';

test('Claude loads nothing from disk and only the role tools', () => {
  const options = claudeOptions(ROLES.hello, { cwd: '/w', executable: '/bin/claude', env: {} });
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.tools, ['Bash', 'Read']);
  assert.equal(options.persistSession, false);
});

test('Claude init outside the role stops the run', () => {
  const options = claudeOptions(ROLES.hello, { cwd: '/w', executable: '/bin/claude', env: {} });
  const clean = { apiKeySource: 'none', tools: ['Bash', 'Read'], mcp_servers: [] };
  assert.doesNotThrow(() => assertClaudeInit(clean, options));
  assert.throws(
    () => assertClaudeInit({ ...clean, apiKeySource: 'ANTHROPIC_API_KEY' }, options),
    /subscription/,
  );
  assert.throws(
    () => assertClaudeInit({ ...clean, tools: ['Bash', 'Read', 'Task'] }, options),
    /Task/,
  );
  assert.throws(
    () => assertClaudeInit({ ...clean, mcp_servers: [{ name: 'claude.ai Neon' }] }, options),
    /Neon/,
  );
});
