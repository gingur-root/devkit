// The isolation and billing guards fail silently if they regress: a run that
// picks up an API key, a job secret or an account connector looks the same as
// one that didn't. These pin each guard.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { BILLING_KEYS } from './constants.ts';
import {
  agentEnv,
  assertClaudeInit,
  assertCodexHome,
  assertSubscriptionBilling,
  claudeOptions,
  codexOptions,
} from './isolation.ts';
import { ROLES } from './roles.ts';

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-agent-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('every billing key blocks a run', () => {
  for (const key of BILLING_KEYS) {
    assert.throws(() => assertSubscriptionBilling({ [key]: 'x' }), new RegExp(key));
  }
  assert.doesNotThrow(() =>
    assertSubscriptionBilling({ CLAUDE_CODE_OAUTH_TOKEN: 'x', PATH: '/bin' }),
  );
});

test('each executor sees only its own credential and none of the job env', () => {
  const job = {
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

test('Claude loads nothing from disk and only the role tools', () => {
  const options = claudeOptions(ROLES.hello, { cwd: '/w', executable: '/bin/claude', env: {} });
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.mcpServers, {});
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

test('Codex turns off account apps, plugins, subagents and bundled skills', () => {
  const { config } = codexOptions({ executable: '/bin/codex', env: {} });
  assert.deepEqual(config, {
    features: {
      apps: false,
      plugins: false,
      remote_plugin: false,
      hooks: false,
      memories: false,
      multi_agent: false,
      goals: false,
      image_generation: false,
    },
    agents: { enabled: false },
    skills: { bundled: { enabled: false } },
  });
});

test('a Codex home with config or a non-ChatGPT login stops the run', () => {
  const home = scratch();
  assert.throws(() => assertCodexHome(home), /No Codex login/);
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }),
  );
  assert.throws(() => assertCodexHome(home), /not a ChatGPT login/);
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
  assert.doesNotThrow(() => assertCodexHome(home));
  writeFileSync(join(home, 'config.toml'), '[mcp_servers.neon]\n');
  assert.throws(() => assertCodexHome(home), /config\.toml/);
});
