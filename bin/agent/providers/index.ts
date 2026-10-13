import type { Executor } from '../constants.ts';
import { runClaude } from './claude.ts';
import { runCodex } from './codex.ts';
import type { Provider } from './shared.ts';

export type { Provider, RunInput } from './shared.ts';

export const PROVIDERS = { claude: runClaude, codex: runCodex } as const satisfies Record<
  Executor,
  Provider
>;
