import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished, test } from 'vite-plus/test';

import { run } from './run.ts';
import type { Job } from './job.ts';
import { ROLES, type RoleName } from './roles.ts';
import { agentEnv } from './providers/shared.ts';
import { claudeOptions } from './providers/claude.ts';
import { codexOptions } from './providers/codex.ts';
import { DEFAULT_TOOLS, loadTools, renderTools, Tools, toolsEnv } from './tools.ts';

const HTTP_UUID = '11111111-1111-4111-8111-111111111111';
const STDIO_UUID = '22222222-2222-4222-8222-222222222222';
const fixture = {
  mcpServers: {
    x: { url: 'https://example.com/mcp', secret: HTTP_UUID, roles: ['plan'] },
    localDocs: {
      command: 'docs-mcp',
      args: ['--stdio'],
      secret: STDIO_UUID,
      env: 'MCP_DOCS_KEY',
      roles: ['plan'],
    },
  },
};

function repo(manifest?: unknown): string {
  const cwd = mkdtempSync(join(tmpdir(), 'devkit-tools-'));
  onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
  if (manifest !== undefined) {
    mkdirSync(join(cwd, '.devkit'));
    writeFileSync(join(cwd, '.devkit/tools.json'), JSON.stringify(manifest));
  }
  return cwd;
}

function stage(role: RoleName, manifest: unknown) {
  const input = repo();
  const out = repo();
  const job: Job = {
    job: `${role}-test`,
    role,
    objective: '',
    repo: 'o/r',
    issue: { number: 1, title: 'Title', revision: 'rev', bodySeen: true },
    plan: null,
    source: 'candidate',
    base: 'base',
    candidate: null,
    artifacts: [],
    operations: [],
    attemptLimit: null,
  };
  writeFileSync(join(input, 'job.json'), JSON.stringify(job));
  writeFileSync(join(input, 'tools.json'), JSON.stringify(manifest));
  return { input, out };
}

function cli(args: string[], cwd: string, secrets?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, DEVKIT_STUB_FIXTURE: 'ready' };
  delete env.DEVKIT_MCP_SECRETS;
  if (secrets) env.DEVKIT_MCP_SECRETS = secrets;
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../devkit.mjs', import.meta.url)), 'agent', ...args],
    {
      cwd,
      env,
      encoding: 'utf8',
    },
  );
}

test('credential requests use the job manifest even when the candidate changes it', () => {
  const trusted = {
    mcpServers: {
      trusted: { url: 'https://trusted.example/mcp', secret: HTTP_UUID, roles: ['review'] },
    },
  };
  const candidate = {
    mcpServers: {
      candidate: { url: 'https://candidate.example/mcp', secret: STDIO_UUID, roles: ['review'] },
    },
  };
  const cwd = repo(candidate);
  const { input } = stage('review', trusted);
  const result = cli(['tools', '--role', 'review', '--in', input, '--secrets'], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${HTTP_UUID} > MCP_TRUSTED_TOKEN\n`);
  assert.ok(!result.stdout.includes(STDIO_UUID));
});

test('run renders only trusted tools when the candidate adds a different server', () => {
  const trusted = {
    mcpServers: {
      trusted: { url: 'https://trusted.example/mcp', secret: HTTP_UUID, roles: ['review'] },
    },
  };
  const cwd = repo({
    mcpServers: {
      candidate: { url: 'https://candidate.example/mcp', secret: STDIO_UUID, roles: ['review'] },
    },
  });
  const { input, out } = stage('review', trusted);
  const result = cli(
    ['run', '--role', 'review', '--executor', 'stub', '--cwd', cwd, '--in', input, '--out', out],
    cwd,
    JSON.stringify({ MCP_TRUSTED_TOKEN: 'trusted-value', MCP_CANDIDATE_TOKEN: 'candidate-value' }),
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const init = JSON.parse(readFileSync(join(out, 'transcript.jsonl'), 'utf8').split('\n')[0]!);
  assert.deepEqual(init.tools.claude.mcpServers.trusted, {
    type: 'http',
    url: 'https://trusted.example/mcp',
    headers: { Authorization: 'Bearer ${MCP_TRUSTED_TOKEN}' },
  });
  assert.deepEqual(init.tools.codex.trusted, {
    url: 'https://trusted.example/mcp',
    bearer_token_env_var: 'MCP_TRUSTED_TOKEN',
  });
  assert.doesNotMatch(JSON.stringify(init), /candidate|trusted-value|candidate-value|22222222/);
});

test('stub runs a credentialed manifest without fetched secrets and lists only env names', () => {
  const manifest = {
    mcpServers: { x: { url: 'https://example.com/mcp', secret: HTTP_UUID, roles: ['plan'] } },
  };
  // Both copies reproduce the old loader as well as the trusted job-dir loader.
  const cwd = repo(manifest);
  const { input, out } = stage('plan', manifest);
  const result = cli(
    ['run', '--role', 'plan', '--executor', 'stub', '--cwd', cwd, '--in', input, '--out', out],
    cwd,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const envelope = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
  assert.equal(envelope.status, 'complete');
  const init = JSON.parse(readFileSync(join(out, 'transcript.jsonl'), 'utf8').split('\n')[0]!);
  assert.equal(init.type, 'init');
  assert.ok(init.tools.env.includes('MCP_X_TOKEN'));
  assert.ok(init.tools.env.every((name: unknown) => typeof name === 'string'));
  assert.deepEqual(init.tools.codex.x, {
    url: 'https://example.com/mcp',
    bearer_token_env_var: 'MCP_X_TOKEN',
  });
  assert.doesNotMatch(JSON.stringify(init), /DEVKIT_MCP_SECRETS|11111111/);
});

test('credential env names cannot replace the agent environment', () => {
  for (const env of [
    'PATH',
    'HOME',
    'GH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'DEVKIT_MCP_SECRETS',
    'MCP_',
  ]) {
    assert.equal(
      Tools.safeParse({ mcpServers: { x: { command: 'x', roles: [], env } } }).success,
      false,
      env,
    );
  }
  assert.equal(
    Tools.safeParse({ mcpServers: { x: { command: 'x', roles: [], env: 'MCP_FOO' } } }).success,
    true,
  );
});

test('agent tools prints both native configs for the selected role', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../devkit.mjs', import.meta.url)),
      'agent',
      'tools',
      '--role',
      'plan',
      '--in',
      stage('plan', {}).input,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const tools = JSON.parse(result.stdout);
  assert.deepEqual(tools.claude.mcpServers.context7, {
    type: 'http',
    url: 'https://mcp.context7.com/mcp',
  });
  assert.deepEqual(tools.codex.context7, { url: 'https://mcp.context7.com/mcp' });
});

test('run stops when a manifest CLI is missing from PATH', async () => {
  await assert.rejects(
    run({
      role: 'hello',
      executor: 'stub',
      in: stage('hello', { clis: ['devkit-nonexistent-cli'] }).input,
    }),
    { message: 'devkit-nonexistent-cli is not on PATH.' },
  );
});

test('the schema parses defaults and rejects invalid repo manifests', () => {
  assert.deepEqual(Tools.parse(DEFAULT_TOOLS), DEFAULT_TOOLS);
  assert.deepEqual(Tools.parse({}), { mcpServers: {}, clis: [] });
  const invalid = [
    { unknown: true },
    { mcpServers: { x: { url: 'https://example.com', command: 'x', roles: [] } } },
    { mcpServers: { x: { roles: [] } } },
    { mcpServers: { x: { url: 'https://example.com', secret: 'bad', roles: [] } } },
    { mcpServers: { x: { url: 'https://example.com', roles: ['research'] } } },
    { mcpServers: { x: { url: 'bad', roles: [] } } },
    { mcpServers: { x: { command: '', roles: [] } } },
    { mcpServers: { x: { command: 'x', roles: [], extra: true } } },
    { mcpServers: { 'bad-name': { command: 'x', roles: [] } } },
    { mcpServers: { x: { command: 'x', env: 'bad-name', roles: [] } } },
    { mcpServers: { x: { command: 'x', env: 'DEVKIT_MCP_SECRETS', roles: [] } } },
  ];
  for (const manifest of invalid) {
    assert.equal(Tools.safeParse(manifest).success, false, JSON.stringify(manifest));
    assert.throws(() => loadTools(stage('plan', manifest).input), { name: 'ZodError' });
  }
});

test('a repo adds servers, replaces whole defaults and unions CLI requirements', () => {
  assert.deepEqual(loadTools(undefined), DEFAULT_TOOLS);
  assert.deepEqual(loadTools(repo()), DEFAULT_TOOLS);
  DEFAULT_TOOLS.clis.push('node');
  try {
    const tools = loadTools(
      stage('plan', { ...fixture, clis: ['node', 'docs-mcp', 'docs-mcp'] }).input,
    );
    assert.deepEqual(Object.keys(tools.mcpServers).sort(), ['context7', 'localDocs', 'x']);
    assert.deepEqual(tools.clis, ['node', 'docs-mcp']);
    const replaced = loadTools(
      stage('plan', {
        mcpServers: {
          context7: { command: 'repo-docs', roles: ['retro'] },
        },
      }).input,
    );
    assert.deepEqual(replaced.mcpServers.context7, {
      command: 'repo-docs',
      args: [],
      roles: ['retro'],
    });
    const disabled = loadTools(
      stage('plan', {
        mcpServers: {
          context7: { url: 'https://mcp.context7.com/mcp', roles: [] },
        },
      }).input,
    );
    for (const role of Object.keys(ROLES) as RoleName[])
      assert.deepEqual(renderTools(disabled, role).codex, {});
  } finally {
    DEFAULT_TOOLS.clis.pop();
  }
});

test('HTTP and stdio credentials render as variable references for each CLI', () => {
  assert.deepEqual(renderTools(Tools.parse(fixture), 'plan'), {
    claude: {
      mcpServers: {
        x: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer ${MCP_X_TOKEN}' },
        },
        localDocs: {
          type: 'stdio',
          command: 'docs-mcp',
          args: ['--stdio'],
          env: { MCP_DOCS_KEY: '${MCP_DOCS_KEY}' },
        },
      },
    },
    codex: {
      x: { url: 'https://example.com/mcp', bearer_token_env_var: 'MCP_X_TOKEN' },
      localDocs: { command: 'docs-mcp', args: ['--stdio'], env_vars: ['MCP_DOCS_KEY'] },
    },
    secrets: { MCP_X_TOKEN: HTTP_UUID, MCP_DOCS_KEY: STDIO_UUID },
  });
  const keyless = renderTools(
    Tools.parse({
      mcpServers: {
        local: { command: 'local-docs', roles: ['retro'] },
        docsApi: { url: 'https://example.com', secret: HTTP_UUID, roles: ['retro'] },
      },
    }),
    'retro',
  );
  assert.deepEqual(keyless.claude.mcpServers.local, {
    type: 'stdio',
    command: 'local-docs',
    args: [],
  });
  assert.deepEqual(keyless.codex.local, { command: 'local-docs', args: [] });
  assert.deepEqual(keyless.secrets, { MCP_DOCS_API_TOKEN: HTTP_UUID });
});

test('role selection isolates configs and env; SDK config arguments contain no values', () => {
  const sentinel = `sentinel-${randomUUID()}`;
  const source = {
    PATH: '/bin',
    DEVKIT_MCP_SECRETS: JSON.stringify({
      MCP_X_TOKEN: sentinel,
      MCP_DOCS_KEY: sentinel,
      UNRELATED: sentinel,
    }),
  };
  const tools = Tools.parse(fixture);
  const denied = renderTools(tools, 'retro');
  for (const executor of ['claude', 'codex', 'stub'] as const) {
    const env = { ...agentEnv(executor, source), ...toolsEnv(denied, source) };
    assert.deepEqual(env, agentEnv(executor, source));
    assert.doesNotMatch(
      JSON.stringify({ ...denied, env }),
      /localDocs|sentinel-|MCP_X_TOKEN|MCP_DOCS_KEY|DEVKIT_MCP_SECRETS/,
    );
  }
  const allowed = renderTools(tools, 'plan');
  const env = { ...agentEnv('claude', source), ...toolsEnv(allowed, source) };
  assert.equal(env.MCP_X_TOKEN, sentinel);
  assert.equal(env.MCP_DOCS_KEY, sentinel);
  assert.equal(env.DEVKIT_MCP_SECRETS, undefined);
  assert.equal(env.UNRELATED, undefined);
  const claude = claudeOptions(ROLES.plan, {
    cwd: '/w',
    executable: '/bin/claude',
    env,
    instructions: '',
    mcpConfig: '/tmp/mcp.json',
  });
  // The SDK consumes env separately; only the remaining options become arguments.
  const { env: childEnv, ...argvOptions } = claude;
  assert.equal(childEnv?.MCP_X_TOKEN, sentinel);
  assert.ok(!JSON.stringify(argvOptions).includes(sentinel));
  assert.equal('mcpServers' in argvOptions, false);
  const codex = codexOptions({ executable: '/bin/codex', env, tools: allowed });
  assert.ok(!JSON.stringify(codex.config).includes(sentinel));
  assert.deepEqual(codex.config?.shell_environment_policy, {
    exclude: ['MCP_X_TOKEN', 'MCP_DOCS_KEY'],
  });
  assert.deepEqual(codex.config?.mcp_servers, allowed.codex);
});

test('credential input fails loudly without quoting credential values', () => {
  const tools = renderTools(Tools.parse(fixture), 'plan');
  assert.throws(() => toolsEnv(tools, {}), /Missing MCP credential MCP_X_TOKEN/);
  assert.throws(
    () => toolsEnv(tools, { DEVKIT_MCP_SECRETS: '{sentinel-secret' }),
    (error: Error) => !error.message.includes('sentinel-secret'),
  );
  assert.deepEqual(
    toolsEnv(renderTools(Tools.parse(fixture), 'retro'), {
      DEVKIT_MCP_SECRETS: '{sentinel-secret',
    }),
    {},
  );
});

test('defaults scope keyless Context7 independently of built-in web search', () => {
  for (const role of ['plan', 'build', 'repair', 'review', 'elevated'] as const) {
    const rendered = renderTools(DEFAULT_TOOLS, role);
    assert.deepEqual(Object.keys(rendered.codex), ['context7']);
    assert.deepEqual(rendered.secrets, {});
  }
  for (const role of ['hello', 'retro'] as const) {
    assert.deepEqual(renderTools(DEFAULT_TOOLS, role), {
      claude: { mcpServers: {} },
      codex: {},
      secrets: {},
    });
  }
  assert.equal('github' in DEFAULT_TOOLS.mcpServers, false);
});
