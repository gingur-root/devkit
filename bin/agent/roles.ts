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
  build: {
    // agents/sdlc.md: Codex at High implements; the account default model.
    executor: 'codex',
    effort: 'high',
    objective:
      'Implement the approved plan for the issue, and check every criterion assigned to you.',
    instructions: [
      'agents/worker.md',
      'skills/plain-english/SKILL.md',
      'agents/contract.md',
      'agents/build.md',
    ],
    tools: ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write'],
    web: true,
    timeoutMinutes: 60,
    result: true,
  },
  repair: {
    // agents/sdlc.md: repair is the implementation role plus its addendum.
    executor: 'codex',
    effort: 'high',
    objective:
      "Fix the review's findings on the candidate, and recheck every criterion they touch.",
    instructions: [
      'agents/worker.md',
      'skills/plain-english/SKILL.md',
      'agents/contract.md',
      'agents/build.md',
      'agents/repair.md',
    ],
    tools: ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write'],
    web: true,
    timeoutMinutes: 60,
    result: true,
  },
  review: {
    // agents/sdlc.md: Claude reviews Codex's change, Opus 5.5 at High.
    executor: 'claude',
    model: 'claude-opus-5-5',
    effort: 'high',
    objective:
      'Review the candidate against the issue and approved plan: Correctness, Spec and Standards.',
    instructions: [
      'agents/worker.md',
      'skills/plain-english/SKILL.md',
      'agents/contract.md',
      'agents/review.md',
    ],
    tools: ['Bash', 'Read', 'Glob', 'Grep'],
    web: true,
    timeoutMinutes: 30,
    result: true,
  },
  elevated: {
    // Runs on the operator's WSL desk as him (infra#43), on his own Claude
    // login: the one role whose job holds admin credentials.
    executor: 'claude',
    model: 'claude-opus-5-5',
    effort: 'high',
    objective:
      "Carry out the approved plan with the operator's admin access, and check every criterion.",
    instructions: [
      'agents/worker.md',
      'skills/plain-english/SKILL.md',
      'agents/contract.md',
      'agents/build.md',
      'agents/elevated.md',
    ],
    tools: ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write'],
    web: true,
    timeoutMinutes: 60,
    result: true,
  },
} as const satisfies Record<string, Role>;

export type RoleName = keyof typeof ROLES;
