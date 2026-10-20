// The job file the controller renders into $AGENT_IN (devkit#1, "Agent
// contract"). Fields that don't apply are null.

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { OPERATOR_ID, PIPELINE_BOT } from './constants.ts';
import { Triage } from './result.ts';

export const JOB_FILE = 'job.json';
export const ISSUE_FILE = 'issue.md';
export const PR_FILE = 'pr.md';
export const DIFF_FILE = 'pr.diff';
export const CHANGED_FILE = 'changed.txt';
export const RESULT_FILE = 'result.json';
export const PLAN_FILE = 'plan.md';
/** The MCP manifest from the job's trusted commit. */
export const TOOLS_FILE = 'tools.json';
/** The repo's `.devkit/` agents and skills from the job's trusted commit. */
export const OVERRIDES_DIR = 'overrides';
/** The org and target repo's slice of pipeline memory. */
export const MEMORY_DIR = 'memory';
/** A retro issue's plan: the repo's open issues, which it may link findings to. */
export const ISSUES_FILE = 'issues.md';
/** A retro issue's approved triage, which the build files instead of building. */
export const TRIAGE_FILE = 'triage.json';
/** A retro's view of the card's history. */
export const TIMELINE_FILE = 'timeline.md';
/** Each agent's event stream, as `agent run` printed it. */
export const TRANSCRIPT_FILE = 'transcript.jsonl';
/** The review a repair answers, CI's finding included (devkit#9). */
export const REVIEW_FILE = 'review.json';
export const THREADS_FILE = 'threads.json';
export const CHECKS_FILE = 'checks.json';
export const RESUME_FILE = 'resume.json';
/** The build's change against `source`, as a binary git patch. */
export const CANDIDATE_FILE = 'candidate.patch';
/** Each agent.run step's outcome, written even when setup fails. */
export const STEPS_FILE = 'steps.json';

/** Each stage's comment starts with its marker; the plan's text sits between these. */
export const PLAN_START = '<!-- devkit:plan:start -->';
export const PLAN_END = '<!-- devkit:plan:end -->';
export const CONTRACT_PREFIX = '<!-- devkit:contract ';

export function marker(role: string): string {
  return `<!-- devkit:${role} -->`;
}

/** Ends the body of a subtask the card's plan filed, so a retry finds it (devkit#12). */
export function subtaskMarker(card: number): string {
  return `<!-- devkit:subtask #${card} -->`;
}

/** Ends the body of a follow-up the card's stage filed, so a retry finds it (devkit#12). */
export function followupMarker(card: number, stage: string): string {
  return `<!-- devkit:followup #${card} ${stage} -->`;
}

/**
 * The stage's own comment: the App's, or the operator's when his `gh` writes on
 * the WSL desk (repos the App can't reach, infra#47).
 */
export function isStageComment(
  comment: { body: string | null; user: { type: string; id: number } | null },
  role: string,
): boolean {
  return (
    (comment.user?.id === OPERATOR_ID ||
      (role === 'loop' ? comment.user?.id === PIPELINE_BOT.id : comment.user?.type === 'Bot')) &&
    !!comment.body?.startsWith(marker(role))
  );
}

/** The hidden fields under a plan comment, which the build stage reads back. */
export const PlanContract = z.object({
  planRevision: z.string(),
  outcome: z.string().nullable(),
  source: z.string(),
  issueRevision: z.string(),
  // Absent on plans published before devkit#168.
  bodySeen: z.boolean().nullable().default(null),
  checks: z.record(z.string(), z.string()),
  critique: z.boolean().nullable(),
  // Absent on plans published before devkit#115.
  triage: Triage.nullable().default(null),
  blockedBy: z.record(z.string(), z.array(z.number().int())).nullable().default(null),
});
export type PlanContract = z.infer<typeof PlanContract>;

export const Job = z.object({
  job: z.string(),
  role: z.string(),
  objective: z.string(),
  repo: z.string(),
  issue: z.object({
    number: z.number().int(),
    title: z.string(),
    revision: z.string(),
    bodySeen: z.boolean(),
  }),
  plan: z
    .object({
      revision: z.string(),
      criteria: z.array(z.string()),
      checks: z.record(z.string(), z.string()),
    })
    .nullable(),
  source: z.string(),
  base: z.string().nullable(),
  candidate: z.string().nullable(),
  memory: z.string().nullable().default(null),
  artifacts: z.array(z.string()),
  operations: z.array(z.string()),
  attemptLimit: z.number().int().nullable(),
});

export type Job = z.infer<typeof Job>;

/** SHA-256 hex. Line endings are normalized, since GitHub may return CRLF for text it was sent as LF. */
export function revision(...parts: string[]): string {
  return createHash('sha256')
    .update(parts.map((part) => part.replace(/\r\n/g, '\n')).join('\n'))
    .digest('hex');
}

/** Claude's `input_tokens` leaves out cache reads and writes; Codex's includes them. */
export function usage(events: string): { input: number; output: number } {
  const total = { input: 0, output: 0 };
  for (const line of events.split('\n')) {
    let event: { type?: string; usage?: Record<string, number> };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== 'result' || !event.usage) continue;
    const u = event.usage;
    total.input +=
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0);
    total.output += u.output_tokens ?? 0;
  }
  return total;
}
