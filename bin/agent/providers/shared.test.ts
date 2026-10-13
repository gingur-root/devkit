// The env allowlist is the billing guard and the credential boundary; a leak
// here is silent.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentEnv } from './shared.ts';

test('each executor sees only its own credential and none of the job env', () => {
  const job = {
    ANTHROPIC_API_KEY: 'sk-ant',
    OPENAI_API_KEY: 'sk',
    PATH: '/bin',
    HOME: '/home/r',
    CLAUDE_CODE_OAUTH_TOKEN: 'claude',
    CODEX_HOME: '/c',
    BWS_AGENTS_TOKEN: 'bws',
    GITHUB_TOKEN: 'gh',
  };
  assert.deepEqual(agentEnv('claude', job), {
    PATH: '/bin',
    HOME: '/home/r',
    CLAUDE_CODE_OAUTH_TOKEN: 'claude',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  });
  assert.deepEqual(agentEnv('codex', job), { PATH: '/bin', HOME: '/home/r', CODEX_HOME: '/c' });
});
