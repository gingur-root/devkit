// The job file the controller renders into $AGENT_IN (devkit#1, "Agent
// contract"). Fields that don't apply are null.

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { OPERATOR_ID } from './constants.ts';

export const JOB_FILE = 'job.json';
export const ISSUE_FILE = 'issue.md';
export const RESULT_FILE = 'result.json';
export const PLAN_FILE = 'plan.md';
/** A retro's view of the card's history. */
export const TIMELINE_FILE = 'timeline.md';
/** Each agent's event stream, as `agent run` printed it. */
export const TRANSCRIPT_FILE = 'transcript.jsonl';
/** The build's change against `source`, as a binary git patch. */
export const CANDIDATE_FILE = 'candidate.patch';

/** Each stage's comment starts with its marker; the plan's text sits between these. */
export const PLAN_START = '<!-- devkit:plan:start -->';
export const PLAN_END = '<!-- devkit:plan:end -->';
export const CONTRACT_PREFIX = '<!-- devkit:contract ';

export function marker(role: string): string {
  return `<!-- devkit:${role} -->`;
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
    (comment.user?.type === 'Bot' || comment.user?.id === OPERATOR_ID) &&
    !!comment.body?.startsWith(marker(role))
  );
}

/** The hidden fields under a plan comment, which the build stage reads back. */
export const PlanContract = z.object({
  planRevision: z.string(),
  outcome: z.string().nullable(),
  source: z.string(),
  issueRevision: z.string(),
  checks: z.record(z.string(), z.string()),
  critique: z.boolean().nullable(),
});
export type PlanContract = z.infer<typeof PlanContract>;

export const Job = z.object({
  job: z.string(),
  role: z.string(),
  objective: z.string(),
  repo: z.string(),
  issue: z.object({ number: z.number().int(), title: z.string(), revision: z.string() }),
  plan: z.object({ revision: z.string(), criteria: z.array(z.string()) }).nullable(),
  source: z.string(),
  base: z.string().nullable(),
  candidate: z.string().nullable(),
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
