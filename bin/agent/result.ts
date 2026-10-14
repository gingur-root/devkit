// The result envelope every role returns (devkit#1, "Agent contract"). Strict:
// every field is required and `null` where it doesn't apply, because Codex's
// output schema needs that.

import { z } from 'zod';

const OUTCOMES = [
  'ready',
  'needs-input',
  'answered',
  'inconclusive',
  'pass',
  'changes-requested',
  'implemented',
  'verified',
  'failed',
] as const;

/** The writing rules cap a routine summary at 150 words. */
export const SUMMARY_WORDS = 150;

const Outcome = z.enum(OUTCOMES);
const Axis = z.enum(['correctness', 'spec', 'standards']);

export const Result = z
  .object({
    job: z.string(),
    role: z.string(),
    inputs: z
      .object({
        issue: z.string().nullable(),
        plan: z.string().nullable(),
        base: z.string().nullable(),
        candidate: z.string().nullable(),
        artifacts: z.array(z.string()),
      })
      .strict(),
    outputs: z
      .object({
        plan: z.string().nullable(),
        candidate: z.string().nullable(),
        artifacts: z.array(z.string()),
      })
      .strict(),
    status: z.enum(['complete', 'blocked', 'stale', 'failed']),
    outcome: Outcome.nullable(),
    summary: z
      .string()
      .refine((text) => text.split(/\s+/).filter(Boolean).length <= SUMMARY_WORDS, {
        message: `summary is over ${SUMMARY_WORDS} words`,
      }),
    evidence: z.array(
      z
        .object({
          criterion: z.string().nullable(),
          check: z.string(),
          expected: z.string(),
          observed: z.string(),
          exit: z.number().int().nullable(),
          location: z.string(),
          result: z.enum(['pass', 'fail', 'not-verified']),
        })
        .strict(),
    ),
    changes: z
      .array(
        z
          .object({
            ref: z.string(),
            change: z.string().nullable(),
            response: z.string().nullable(),
            evidence: z.string().nullable(),
          })
          .strict(),
      )
      .nullable(),
    hypotheses: z.array(z.string()).nullable(),
    axes: z.object({ correctness: Outcome, spec: Outcome, standards: Outcome }).strict().nullable(),
    criteria: z
      .array(
        z.object({ id: z.string(), text: z.string(), check: z.enum(['ci', 'agent']) }).strict(),
      )
      .nullable(),
    probe: z
      .object({ kind: z.enum(['research', 'prototype']), question: z.string() })
      .strict()
      .nullable(),
    critique: z.boolean().nullable(),
    docs: z.boolean().nullable(),
    assumptions: z.array(z.string()),
    questions: z.array(z.string()),
    next: z.string(),
    findings: z
      .array(
        z
          .object({
            id: z.string(),
            axis: Axis,
            blocking: z.boolean(),
            criterion: z.string().nullable(),
            path: z.string().nullable(),
            line: z.number().int().nullable(),
            evidence: z.string(),
            scenario: z.string(),
            impact: z.string(),
            fix: z.string(),
          })
          .strict(),
      )
      .nullable(),
    subtasks: z
      .array(z.object({ title: z.string(), body: z.string(), pr: z.boolean() }).strict())
      .nullable(),
    followups: z.array(z.object({ title: z.string(), body: z.string() }).strict()).nullable(),
    failure: z
      .object({
        class: z.enum(['rate_limit', 'overloaded', 'server_error', 'timeout', 'unknown']),
        resetsAt: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type Result = z.infer<typeof Result>;
export type Failure = NonNullable<Result['failure']>;

// Without `$schema`: Claude's validator can't resolve the 2020-12 meta-schema URL.
const { $schema: _, ...schema } = z.toJSONSchema(Result, { unrepresentable: 'any' });

/** What the executors' native schema options take. The word cap is checked on validation only. */
export const RESULT_JSON_SCHEMA: Record<string, unknown> = schema;
