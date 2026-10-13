export const EXECUTORS = ['claude', 'codex'] as const;
export type Executor = (typeof EXECUTORS)[number];

export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

/** Claude's `apiKeySource` values that mean the subscription OAuth token. */
export const CLAUDE_SUBSCRIPTION_SOURCES = ['none', 'oauth'] as const;

/** Codex's `auth.json` `auth_mode` for a ChatGPT login. */
export const CODEX_SUBSCRIPTION_MODE = 'chatgpt';

/** Variables every agent may see. Nothing else is inherited from the job. */
export const BASE_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'TERM',
  'CI',
] as const;

/** The one credential each executor may see, plus the fixed settings that isolate it. */
export const EXECUTOR_ENV = {
  claude: {
    pass: ['CLAUDE_CODE_OAUTH_TOKEN'],
    set: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
  },
  codex: { pass: ['CODEX_HOME'], set: {} },
} as const satisfies Record<
  Executor,
  { pass: readonly string[]; set: Readonly<Record<string, string>> }
>;

/**
 * Codex features that load context from the ChatGPT account or the Codex home
 * rather than from the role: account apps and remote plugins (the Neon server
 * and Canva tools seen on the runners), hooks, memories, and its own subagents.
 */
export const CODEX_FEATURES_OFF = [
  'apps',
  'plugins',
  'remote_plugin',
  'hooks',
  'memories',
  'multi_agent',
  'goals',
  'image_generation',
] as const;

/** Files in the Codex home the SDK cannot be told to ignore. */
export const CODEX_HOME_FORBIDDEN = ['config.toml', 'AGENTS.md'] as const;
