/** `stub` writes fixture results instead of calling a model, for smoke runs of the chain. */
export const EXECUTORS = ['claude', 'codex', 'stub'] as const;
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
  stub: { pass: ['DEVKIT_STUB_FIXTURE'], set: {} },
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

/** The stub's fixtures, in bin/agent/fixtures/. */
export const STUB_FIXTURES = ['ready', 'invalid'] as const;
export type StubFixture = (typeof STUB_FIXTURES)[number];

/** The operator's GitHub user ID, as in the admission expression. */
export const OPERATOR_ID = 2553213;

export const BOARD_TITLE = 'Pipeline';
export const STATUS_FIELD = 'Status';
export const STATUSES = ['Ask', 'Planning', 'Needs you', 'Building', 'Ready', 'Done'] as const;
export type Status = (typeof STATUSES)[number];

/** The label that starts each stage; the pipeline removes it when the run ends. Review runs inside the build's run. */
export const STAGE_LABELS = {
  plan: 'agent:plan',
  build: 'agent:build',
  review: 'agent:build',
  elevated: 'agent:elevated',
} as const;

/** The pipeline App's bot user, which authors the build's commits. */
export const PIPELINE_BOT = {
  name: 'gingur-root-pipeline[bot]',
  email: '340770692+gingur-root-pipeline[bot]@users.noreply.github.com',
} as const;
