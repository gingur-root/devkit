// The job file the controller renders into $AGENT_IN (devkit#1, "Agent
// contract"). Fields that don't apply are null.

import { createHash } from 'node:crypto';

import { z } from 'zod';

export const JOB_FILE = 'job.json';
export const ISSUE_FILE = 'issue.md';
export const RESULT_FILE = 'result.json';
export const PLAN_FILE = 'plan.md';

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
