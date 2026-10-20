// A run that loaded a stray tool or an API-key login looks the same as one that
// didn't; this pins the guard that stops it.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { onTestFinished, test, vi } from 'vite-plus/test';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { ROLES } from '../roles.ts';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { DEFAULT_TOOLS, renderTools, Tools } from '../tools.ts';
import { assertClaudeInit, claudeFailure, claudeOptions, runClaude } from './claude.ts';
import { codexFailure } from './codex.ts';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

test('every role passes its turn cap to Claude', () => {
  const defaults = {
    hello: 10,
    plan: 100,
    build: 200,
    repair: 200,
    review: 100,
    retro: 50,
    memory: 50,
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
  assert.doesNotThrow(() => assertClaudeInit(clean, options, []));
  assert.throws(() =>
    assertClaudeInit({ ...clean, apiKeySource: 'ANTHROPIC_API_KEY' }, options, []),
  );
  assert.throws(() =>
    assertClaudeInit({ ...clean, tools: ['Bash', 'Read', 'mcp__neon__run_sql'] }, options, []),
  );
  assert.throws(
    () =>
      assertClaudeInit(
        { ...clean, tools: ['Bash', 'Read', 'mcp__context7__query-docs'] },
        options,
        [],
      ),
    'hello gets no docs server',
  );
});

test('a role may load only the MCP servers rendered from its manifest', () => {
  const options = claudeOptions(ROLES.review, {
    cwd: '/w',
    executable: '/bin/claude',
    env: {},
    instructions: '',
  });
  const tools = [...ROLES.review.tools, 'WebSearch', 'WebFetch', 'mcp__context7__query-docs'];
  const servers = Object.keys(renderTools(DEFAULT_TOOLS, 'review').claude.mcpServers);
  assert.doesNotThrow(() => assertClaudeInit({ apiKeySource: 'none', tools }, options, servers));
  assert.throws(() =>
    assertClaudeInit(
      { apiKeySource: 'none', tools: [...tools, 'mcp__neon__run_sql'] },
      options,
      servers,
    ),
  );
});

test('Claude keeps built-in web tools tied to the role and uses a config-file argument', () => {
  for (const role of ['plan', 'review', 'retro', 'hello'] as const) {
    const options = claudeOptions(ROLES[role], {
      cwd: '/w',
      executable: '/bin/claude',
      env: {},
      instructions: '',
      mcpConfig: '/tmp/mcp.json',
    });
    assert.deepEqual(options.extraArgs, { 'mcp-config': '/tmp/mcp.json' });
    assert.equal('mcpServers' in options, false);
    assert.equal(options.strictMcpConfig, true);
    assert.ok(Array.isArray(options.tools));
    assert.equal(options.tools.includes('WebSearch'), role === 'plan' || role === 'review');
    assert.equal(options.tools.includes('WebFetch'), role === 'plan' || role === 'review');
  }
});

test('Claude writes private variable references and removes the file after success or failure', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'devkit-claude-tools-'));
  onTestFinished(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.mocked(query).mockReset();
  });
  writeFileSync(join(cwd, 'claude'), '', { mode: 0o700 });
  vi.stubEnv('PATH', cwd);
  vi.stubEnv('DEVKIT_MCP_SECRETS', JSON.stringify({ MCP_X_TOKEN: 'sentinel-claude' }));
  const tools = renderTools(
    Tools.parse({
      mcpServers: {
        x: {
          url: 'https://example.com/mcp',
          secret: '11111111-1111-4111-8111-111111111111',
          roles: ['plan'],
        },
      },
    }),
    'plan',
  );
  for (const fail of [false, true]) {
    let file = '';
    vi.mocked(query).mockImplementation(({ options }) => {
      file = options!.extraArgs!['mcp-config']!;
      assert.equal(statSync(file).mode & 0o777, 0o600);
      const config = readFileSync(file, 'utf8');
      assert.ok(config.includes('${MCP_X_TOKEN}'));
      assert.ok(!config.includes('sentinel-claude'));
      assert.equal(options!.env!.MCP_X_TOKEN, 'sentinel-claude');
      assert.equal(options!.env!.DEVKIT_MCP_SECRETS, undefined);
      assert.equal(options!.mcpServers, undefined);
      return (async function* () {
        if (fail) throw new Error('fixture failure');
        yield { type: 'system', subtype: 'init', apiKeySource: 'none', tools: ['mcp__x__docs'] };
        yield { type: 'result', subtype: 'success', is_error: false };
      })() as ReturnType<typeof query>;
    });
    const events: Record<string, unknown>[] = [];
    const result = await runClaude({
      role: ROLES.plan,
      tools,
      cwd,
      instructions: '',
      prompt: '',
      emit: (event) => events.push(event),
    });
    assert.equal(result.ok, !fail);
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(dirname(file)), false);
    assert.ok(!JSON.stringify(events).includes('sentinel-claude'));
  }
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

test('memory has file proposal tools without Edit or web tools', () => {
  const options = claudeOptions(ROLES.memory, {
    cwd: '/w',
    executable: '/bin/claude',
    env: {},
    instructions: '',
  });
  assert.deepEqual(options.tools, ['Bash', 'Read', 'Glob', 'Grep', 'Write']);
  assert.throws(
    () => assertClaudeInit({ apiKeySource: 'none', tools: ['Edit'] }, options, []),
    /does not allow/,
  );
  assert.throws(
    () => assertClaudeInit({ apiKeySource: 'none', tools: ['WebFetch'] }, options, []),
    /does not allow/,
  );
});
