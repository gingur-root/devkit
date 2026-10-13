import type { Effort, Executor } from './constants.ts';

export interface Role {
  executor: Executor;
  /** Omitted: the account's default model. */
  model?: string;
  effort: Effort;
  objective: string;
  /**
   * Instruction files, relative to devkit's root, joined in order. A repo
   * overrides one by committing the same path under `.devkit/`.
   */
  instructions: readonly string[];
  /** Claude built-in tools the role gets. Anything else, including subagents and skills, is absent. */
  tools: readonly string[];
  web: boolean;
  timeoutMinutes: number;
  /** Whether the run returns the result envelope (bin/agent/result.ts). */
  result: boolean;
}

export const ROLES = {
  hello: {
    executor: 'claude',
    model: 'claude-sonnet-5-5',
    effort: 'low',
    objective: 'Say hello.',
    instructions: ['agents/hello.md'],
    tools: ['Bash', 'Read'],
    web: false,
    timeoutMinutes: 5,
    result: false,
  },
  plan: {
    executor: 'claude',
    model: 'claude-opus-5-5',
    effort: 'medium',
    objective:
      'Plan the issue: acceptance criteria with IDs, how each is checked, and the open questions.',
    instructions: [
      'agents/worker.md',
      'skills/plain-english/SKILL.md',
      'agents/contract.md',
      'agents/plan.md',
    ],
    tools: ['Bash', 'Read', 'Glob', 'Grep', 'Write'],
    web: true,
    timeoutMinutes: 30,
    result: true,
  },
} as const satisfies Record<string, Role>;

export type RoleName = keyof typeof ROLES;
