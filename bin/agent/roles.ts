import { z } from 'zod';

import { EFFORTS, EXECUTORS, type Effort, type Executor } from './constants.ts';

export interface Role {
  executor: Executor;
  /** Omitted: the account's default model. */
  model?: string;
  effort: Effort;
  objective: string;
  /**
   * Instruction files, relative to devkit's root, joined in order. A repo
   * overrides one under `.devkit/` at the trusted commit (`base ?? source`).
   * Render snapshots overrides into the job's `overrides/`, which run reads
   * instead of the checkout. The role's skills follow: each
   * `skills/<name>/SKILL.md` whose frontmatter `roles` line names it, from
   * devkit or that trusted snapshot (bin/agent/run.ts).
   */
  instructions: readonly string[];
  /** Claude built-in tools the role gets. Anything else, including subagents and skills, is absent. */
  tools: readonly string[];
  web: boolean;
  timeoutMinutes: number;
  /** Claude only; Codex has no turn cap, so its timeout bounds the run. */
  maxTurns: number;
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
    maxTurns: 10,
    result: false,
  },
  plan: {
    executor: 'claude',
    model: 'claude-opus-5-5',
    effort: 'medium',
    objective:
      'Plan the issue: acceptance criteria with IDs, how each is checked, and the open questions.',
    instructions: ['agents/worker.md', 'agents/contract.md', 'agents/plan.md'],
    tools: ['Bash', 'Read', 'Glob', 'Grep', 'Write'],
    web: true,
    timeoutMinutes: 30,
    maxTurns: 100,
    result: true,
  },
  research: {
    executor: 'claude',
    model: 'claude-opus-5-5',
    effort: 'medium',
    objective: 'Answer the research question with cited sources and identify any missing evidence.',
    instructions: ['agents/worker.md', 'agents/contract.md', 'agents/research.md'],
    tools: ['Bash', 'Read', 'Glob', 'Grep', 'Write'],
    web: true,
    timeoutMinutes: 30,
    maxTurns: 100,
    result: true,
  },
  replan: {
    executor: 'claude',
    model: 'claude-opus-5-5',
    effort: 'medium',
    objective:
      'Answer every open review thread and change the plan only when the approved spec must change.',
    instructions: ['agents/worker.md', 'agents/contract.md', 'agents/plan.md', 'agents/replan.md'],
    tools: ['Bash', 'Read', 'Glob', 'Grep', 'Write'],
    web: true,
    timeoutMinutes: 30,
    maxTurns: 100,
    result: true,
  },
  critique: {
    executor: 'codex',
    effort: 'high',
    objective:
      'Criticise the plan revision against its source commit: pass, changes-requested or inconclusive.',
    instructions: ['agents/worker.md', 'agents/contract.md', 'agents/critique.md'],
    tools: ['Bash', 'Read', 'Glob', 'Grep'],
    web: false,
    timeoutMinutes: 30,
    maxTurns: 100,
    result: true,
  },
  build: {
    // agents/sdlc.md: Codex at High implements; the account default model.
    executor: 'codex',
    effort: 'high',
    objective:
      'Implement the approved plan for the issue, and check every criterion assigned to you.',
    instructions: ['agents/worker.md', 'agents/contract.md', 'agents/build.md'],
    tools: ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write'],
    web: true,
    timeoutMinutes: 60,
    maxTurns: 200,
    result: true,
  },
  repair: {
    // agents/sdlc.md: repair is the implementation role plus its addendum.
    executor: 'codex',
    effort: 'high',
    objective:
      "Fix the review's findings on the candidate, and recheck every criterion they touch.",
    instructions: ['agents/worker.md', 'agents/contract.md', 'agents/build.md', 'agents/repair.md'],
    tools: ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write'],
    web: true,
    timeoutMinutes: 60,
    maxTurns: 200,
    result: true,
  },
  review: {
    // agents/sdlc.md: Claude reviews Codex's change, Opus 5.5 at High.
    executor: 'claude',
    model: 'claude-opus-5-5',
    effort: 'high',
    objective:
      'Review the candidate against the issue and approved plan: Correctness, Spec and Standards.',
    instructions: ['agents/worker.md', 'agents/contract.md', 'agents/review.md'],
    tools: ['Bash', 'Read', 'Glob', 'Grep'],
    web: true,
    timeoutMinutes: 30,
    maxTurns: 100,
    result: true,
  },
  verify: {
    executor: 'codex',
    effort: 'medium',
    objective:
      'Check every agent criterion of the approved plan on the exact candidate, with evidence.',
    instructions: ['agents/worker.md', 'agents/contract.md', 'agents/verify.md'],
    tools: ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write'],
    web: true,
    timeoutMinutes: 30,
    maxTurns: 100,
    result: true,
  },
  memory: {
    executor: 'claude',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    objective:
      'Propose the memory changes this merged PR implies, as files for a PR on gingur-root/pipeline.',
    instructions: ['agents/worker.md', 'agents/contract.md', 'agents/memory.md'],
    tools: ['Bash', 'Read', 'Glob', 'Grep', 'Write'],
    web: false,
    timeoutMinutes: 20,
    maxTurns: 50,
    result: true,
  },
  retro: {
    // devkit#39: reads a failed or Needs-you run and only suggests fixes, so it
    // gets no edit tools; publish posts its one comment.
    executor: 'claude',
    model: 'claude-opus-5-5',
    effort: 'medium',
    objective:
      'Run a retro on this pipeline run: what went wrong, and the fix that would stop it next time.',
    instructions: ['agents/worker.md', 'agents/contract.md', 'agents/retro.md'],
    tools: ['Bash', 'Read', 'Glob', 'Grep'],
    web: false,
    timeoutMinutes: 20,
    maxTurns: 50,
    result: true,
  },
} as const satisfies Record<string, Role>;

export type RoleName = keyof typeof ROLES;

export const RoleOverrides = z.partialRecord(
  z.enum(Object.keys(ROLES) as RoleName[]),
  z.strictObject({
    executor: z.enum(EXECUTORS).optional(),
    model: z.string().min(1).nullable().optional(),
    effort: z.enum(EFFORTS).optional(),
  }),
);
export type RoleOverrides = z.infer<typeof RoleOverrides>;
