import type { Executor } from '../constants.ts';
import { runClaude } from './claude.ts';
import { runCodex } from './codex.ts';
import type { Provider } from './shared.ts';
import { runStub } from './stub.ts';

export type { Provider, RunInput, RunOutput } from './shared.ts';

export const PROVIDERS = {
  claude: runClaude,
  codex: runCodex,
  stub: runStub,
} as const satisfies Record<Executor, Provider>;
