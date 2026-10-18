// The Codex SDK can't ignore the user config or check the login, so this guard
// is what keeps stray config and API-key logins out of a run.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished, test, vi } from 'vite-plus/test';
import type { CodexOptions } from '@openai/codex-sdk';

import { ROLES } from '../roles.ts';
import { DEFAULT_TOOLS, renderTools, Tools } from '../tools.ts';
import { assertCodexHome, codexOptions, codexSandbox, runCodex } from './codex.ts';

const sdk = vi.hoisted(() => ({ startThread: vi.fn(), runStreamed: vi.fn(), construct: vi.fn() }));
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options: CodexOptions) {
      sdk.construct(options);
    }
    startThread = sdk.startThread;
  },
}));

test('a Codex home with config or a non-ChatGPT login stops the run', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-agent-'));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const login = (body: string) => writeFileSync(join(home, 'auth.json'), body);

  login('{"tokens": SECRET');
  assert.throws(
    () => assertCodexHome(home),
    (error: Error) => !error.message.includes('SECRET'),
  );
  login(JSON.stringify({ auth_mode: 'apikey' }));
  assert.throws(() => assertCodexHome(home));
  login(JSON.stringify({ auth_mode: 'chatgpt' }));
  assert.doesNotThrow(() => assertCodexHome(home));
  const config = (body: string) => writeFileSync(join(home, 'config.toml'), body);
  config('[projects."/work/repo"]\ntrust_level = "trusted"\n');
  assert.doesNotThrow(() => assertCodexHome(home), 'the trust entry Codex writes itself');
  config('[projects."/work/repo"]\ntrust_level = "trusted"\nmodel = "other"\n');
  assert.throws(() => assertCodexHome(home));
  config('[mcp_servers.x]\ncommand = "x"\n');
  assert.throws(() => assertCodexHome(home));
});

test("a Codex run gets no more access than the role's tools", () => {
  assert.equal(codexSandbox(['Read']), 'read-only');
  assert.equal(codexSandbox(['Read', 'Edit']), 'workspace-write');
  assert.equal(codexSandbox(['Bash', 'Read']), 'danger-full-access');
});

test('Codex always uses manifest MCP configs and keeps web search tied to the role', async () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-codex-tools-'));
  onTestFinished(() => {
    rmSync(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
    sdk.startThread.mockReset();
    sdk.runStreamed.mockReset();
    sdk.construct.mockReset();
  });
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
  writeFileSync(join(home, 'codex'), '', { mode: 0o700 });
  vi.stubEnv('CODEX_HOME', home);
  vi.stubEnv('PATH', home);
  vi.stubEnv('DEVKIT_MCP_SECRETS', JSON.stringify({ MCP_X_TOKEN: 'sentinel-codex' }));
  sdk.startThread.mockReturnValue({ runStreamed: sdk.runStreamed });
  sdk.runStreamed.mockImplementation(async () => ({
    events: (async function* () {
      yield { type: 'turn.completed', usage: {} };
    })(),
  }));
  for (const role of ['plan', 'review', 'retro', 'hello'] as const) {
    const tools = renderTools(
      Tools.parse({
        mcpServers: {
          ...DEFAULT_TOOLS.mcpServers,
          x: {
            url: 'https://example.com/mcp',
            secret: '11111111-1111-4111-8111-111111111111',
            roles: ['plan', 'review', 'retro'],
          },
        },
      }),
      role,
    );
    const options = codexOptions({ executable: '/bin/codex', env: {}, tools });
    assert.deepEqual(options.config?.mcp_servers, tools.codex);
    const result = await runCodex({
      role: ROLES[role],
      tools,
      cwd: home,
      instructions: '',
      prompt: '',
      emit() {},
    });
    assert.equal(result.ok, true);
    const child = sdk.construct.mock.lastCall?.[0] as CodexOptions;
    assert.equal(child.env?.MCP_X_TOKEN, role === 'hello' ? undefined : 'sentinel-codex');
    assert.equal(child.env?.DEVKIT_MCP_SECRETS, undefined);
    assert.ok(!JSON.stringify(child.config).includes('sentinel-codex'));
    assert.equal(
      sdk.startThread.mock.lastCall?.[0].webSearchMode,
      role === 'plan' || role === 'review' ? 'live' : 'disabled',
    );
  }
});
