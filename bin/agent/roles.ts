import type { Effort, Executor } from './constants.ts';

export interface Role {
  executor: Executor;
  /** Omitted: the account's default model. */
  model?: string;
  effort: Effort;
  instructions: string;
  /** Claude built-in tools the role gets. Anything else, including subagents and skills, is absent. */
  tools: readonly string[];
  web: boolean;
  timeoutMinutes: number;
}

export const ROLES = {
  hello: {
    executor: 'claude',
    model: 'claude-sonnet-5-5',
    effort: 'low',
    instructions:
      'You are a smoke test for the gingur-root agent runner. Answer in one short line.',
    tools: ['Bash', 'Read'],
    web: false,
    timeoutMinutes: 5,
  },
} as const satisfies Record<string, Role>;

export type RoleName = keyof typeof ROLES;
