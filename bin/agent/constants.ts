/** `stub` writes fixture results instead of calling a model, for smoke runs of the chain. */
export const EXECUTORS = ['claude', 'codex', 'stub'] as const;
export type Executor = (typeof EXECUTORS)[number];

export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

/** Claude's `apiKeySource` values that mean the subscription OAuth token. */
export const CLAUDE_SUBSCRIPTION_SOURCES = ['none', 'oauth'] as const;

/** Codex's `auth.json` `auth_mode` for a ChatGPT login. */
export const CODEX_SUBSCRIPTION_MODE = 'chatgpt';

/**
 * Variables every agent may see. Nothing else is inherited from the job.
 * GH_TOKEN is the run's read token: `contents: read` on every repo the
 * pipeline App reaches (actions/agent.token).
 */
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
  'GH_TOKEN',
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
/** `red` builds a change CI rejects, which the stub repair then fixes. */
export const STUB_FIXTURES = [
  'ready',
  'invalid',
  'needs-you',
  'rate-limit',
  'red',
  'story',
  'followups',
  'crash',
  'timeout',
  'missing',
  'changes',
  'never',
  'advisory',
  'spec',
  'unverified',
  'critique',
  'critique-pass',
  'docs',
  'inconclusive',
] as const;
export type StubFixture = (typeof STUB_FIXTURES)[number];

/** The operator's GitHub user ID, as in the admission expression. */
export const OPERATOR_ID = 2553213;
/** The operator's login, which Needs-you and Ready comments mention so the notification reaches him. */
export const OPERATOR_LOGIN = 'gingur';
/** Every pipeline commit lists the operator as co-author; the ID-based noreply address links it to his account (devkit#76). */
export const OPERATOR_COAUTHOR = `Co-authored-by: Troy Rhinehart <${OPERATOR_ID}+${OPERATOR_LOGIN}@users.noreply.github.com>`;

/** The operator's "put it on the board" label, and his consent for the loop to plan the card (devkit#47). */
export const READY_LABEL = 'ready-for-agent';

/** Marks an issue a retro filed, or one its plan filed in turn (devkit#115). */
export const RETRO_LABEL = 'retro';
/** The controller adds it at filing to distinguish its issues from bot authorship (devkit#200). */
export const FILED_LABEL = 'agent:filed';

/** Bot authorship alone is not proof the controller filed an issue. */
export function filedByPipeline(issue: {
  user?: { id: number } | null;
  labels: { name: string }[];
}): boolean {
  return issue.user?.id === PIPELINE_BOT.id && issue.labels.some((l) => l.name === FILED_LABEL);
}

/** Follow-ups one stage may file (devkit#12); the rest are dropped and reported. */
export const FOLLOWUP_CAP = 5;

export const BOARD_TITLE = 'Pipeline';
export const STATUS_FIELD = 'Status';
export const STATUSES = ['Ask', 'Planning', 'Needs you', 'Building', 'Ready', 'Done'] as const;
export type Status = (typeof STATUSES)[number];
/** Single-select on the board (devkit#115): P0 drop everything, P1 next, P2 soon, P3 someday. Unset means untriaged. */
export const PRIORITY_FIELD = 'Priority';
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** The label that starts each stage; the pipeline removes it when the run ends. Review and repair run inside the build's run. */
export const STAGE_LABELS = {
  research: 'agent:research',
  plan: 'agent:plan',
  build: 'agent:build',
  review: 'agent:build',
  repair: 'agent:build',
  replan: 'agent:build',
} as const;

/**
 * The repair or stale-rerun cap in one build run before the card goes to Needs
 * you. agent.build.yml has one `repair-<n>` job per round.
 */
export const REPAIR_ROUNDS = 10;

/** The pipeline App's bot user, which authors the build's commits. */
export const PIPELINE_BOT = {
  id: 340770692,
  name: 'gingur-root-pipeline[bot]',
  email: '340770692+gingur-root-pipeline[bot]@users.noreply.github.com',
} as const;

/**
 * The stages a dashboard Continue may hand a plan to (devkit#99), and the
 * marker role of the App comment that records the Continue. The comment is the
 * proof the gate needs before it accepts that stage's label from the App.
 */
export const CONTINUE_ROLES = { build: 'continue' } as const;
export type Handoff = keyof typeof CONTINUE_ROLES;
/** Continue adds `agent:plan` right after its comment; a later plan start is not the Continue's. */
export const CONTINUE_WINDOW_MS = 60_000;

/** The operator's comment commands that start a stage, as the label each one stands for. */
export const STAGE_COMMANDS = {
  '/plan': STAGE_LABELS.plan,
  '/approve': STAGE_LABELS.build,
} as const;
