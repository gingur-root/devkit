// The env allowlist is the billing guard and the credential boundary; a leak
// here is silent.

import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import { agentEnv } from './shared.ts';

test('each executor sees only its own credential, the read token, and none of the job env', () => {
  const job = {
    PATH: '/bin',
    GH_TOKEN: 'gh',
    ANTHROPIC_API_KEY: 'sk',
    AGENTS_SECRETS_TOKEN: 'bws',
    CLAUDE_CODE_OAUTH_TOKEN: 'claude',
    CODEX_HOME: '/c',
  };
  assert.deepEqual(agentEnv('claude', job), {
    PATH: '/bin',
    GH_TOKEN: 'gh',
    CLAUDE_CODE_OAUTH_TOKEN: 'claude',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  });
  assert.deepEqual(agentEnv('codex', job), { PATH: '/bin', GH_TOKEN: 'gh', CODEX_HOME: '/c' });
});
