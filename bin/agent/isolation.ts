// Everything that keeps an agent run to what its role declares. Each check
// here fails loudly: a run that quietly picked up an account connector or an
// API key looks exactly like one that didn't.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { CodexOptions } from '@openai/codex-sdk';

import {
  BASE_ENV,
  CLAUDE_SUBSCRIPTION_SOURCES,
  CODEX_FEATURES_OFF,
  CODEX_HOME_FORBIDDEN,
  CODEX_SUBSCRIPTION_MODE,
  EXECUTOR_ENV,
  type Executor,
} from './constants.ts';
import type { Role } from './roles.ts';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The agent's whole environment: an allowlist, never the job's env. This is also
 * what keeps billing on the subscriptions: an API key in the job never reaches
 * the agent.
 */
export function agentEnv(executor: Executor, source: Env): Record<string, string> {
  const { pass, set } = EXECUTOR_ENV[executor];
  const env: Record<string, string> = {};
  for (const key of [...BASE_ENV, ...pass]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...set };
}

export function claudeOptions(
  role: Role,
  ctx: { cwd: string; executable: string; env: Record<string, string> },
): Options {
  return {
    pathToClaudeCodeExecutable: ctx.executable,
    cwd: ctx.cwd,
    env: ctx.env,
    model: role.model,
    effort: role.effort,
    // No user, project or local settings, so no CLAUDE.md, hooks, plugins or
    // MCP servers from disk.
    settingSources: [],
    strictMcpConfig: true,
    // The allowlist is what actually removes subagents (Task), skills (Skill)
    // and the scheduling and messaging tools: an absent tool cannot be called.
    tools: [...role.tools, ...(role.web ? ['WebSearch', 'WebFetch'] : [])],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: role.instructions },
  };
}

/** Checks Claude's own report of what it loaded against what the role allows. */
export function assertClaudeInit(
  init: { apiKeySource: string; tools: string[]; mcp_servers: { name: string }[] },
  options: Options,
): void {
  if (!(CLAUDE_SUBSCRIPTION_SOURCES as readonly string[]).includes(init.apiKeySource)) {
    throw new Error(`Claude authenticated with ${init.apiKeySource}, not the subscription token.`);
  }
  const allowed = new Set(Array.isArray(options.tools) ? options.tools : []);
  const extra = init.tools.filter((tool) => !allowed.has(tool));
  if (extra.length)
    throw new Error(`Claude loaded tools the role does not allow: ${extra.join(', ')}`);
  const declared = new Set(Object.keys(options.mcpServers ?? {}));
  const servers = init.mcp_servers
    .map((server) => server.name)
    .filter((name) => !declared.has(name));
  if (servers.length)
    throw new Error(`Claude loaded MCP servers the role does not declare: ${servers.join(', ')}`);
}

export function codexHome(env: Env): string {
  const home = env.CODEX_HOME ?? (env.HOME && join(env.HOME, '.codex'));
  if (!home) throw new Error('Neither CODEX_HOME nor HOME is set.');
  return home;
}

/**
 * The SDK cannot pass `--ignore-user-config`, so the Codex home must hold
 * nothing but the login, and the login must be ChatGPT. Only `auth_mode` is
 * read from auth.json; nothing from it is printed.
 */
export function assertCodexHome(home: string): void {
  const present = CODEX_HOME_FORBIDDEN.filter((file) => existsSync(join(home, file)));
  if (present.length)
    throw new Error(
      `${home} has ${present.join(', ')}; agent runs load config only from the role.`,
    );
  const auth = join(home, 'auth.json');
  if (!existsSync(auth)) throw new Error(`No Codex login in ${home}.`);
  let mode: unknown;
  try {
    mode = (JSON.parse(readFileSync(auth, 'utf8')) as { auth_mode?: unknown }).auth_mode;
  } catch {
    // JSON.parse quotes the text near the error, which here is a token.
    throw new Error(`Codex login in ${home} is not readable JSON.`);
  }
  if (mode !== CODEX_SUBSCRIPTION_MODE)
    throw new Error(`Codex login in ${home} is not a ChatGPT login.`);
}

export function codexOptions(ctx: {
  executable: string;
  env: Record<string, string>;
}): CodexOptions {
  return {
    codexPathOverride: ctx.executable,
    env: ctx.env,
    config: {
      features: Object.fromEntries(CODEX_FEATURES_OFF.map((feature) => [feature, false])),
      // `features.multi_agent` alone leaves the collaboration tools registered.
      agents: { enabled: false },
      // imagegen, openai-docs, skill-creator and skill-installer ship inside Codex.
      skills: { bundled: { enabled: false } },
    },
  };
}
