// Writes a fixture result instead of calling a model, so a smoke run of the
// whole chain takes seconds. The fixture's job, role and issue revision come
// from the job file, so `ready` passes the contract check and `invalid` fails
// only on its schema. `needs-you` changes only the review, which asks the
// operator a question; every other role runs `ready`. `rate-limit` returns no
// result and a rate limit, as a CLI that hit one does. `red` changes only the
// build, whose STUB.md fails a format check until the repair rewrites it.
// `story` changes only the plan, which proposes two subtasks, one elevated.
// `followups` changes only the build, which proposes seven follow-ups, two over
// the cap.

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { STUB_FIXTURES, type StubFixture } from '../constants.ts';
import { JOB_FILE, Job, PLAN_FILE } from '../job.ts';
import type { RunInput, RunOutput } from './shared.ts';

const FIXTURES = new URL('../fixtures/', import.meta.url);

export async function runStub(input: RunInput): Promise<RunOutput> {
  const fixture = (process.env.DEVKIT_STUB_FIXTURE ?? 'ready') as StubFixture;
  if (!STUB_FIXTURES.includes(fixture)) throw new Error(`No stub fixture "${fixture}".`);
  if (!input.in || !input.out) throw new Error('The stub needs --in and --out.');
  if (fixture === 'rate-limit') {
    input.emit({ type: 'init', fixture });
    return {
      ok: false,
      failure: { class: 'rate_limit', resetsAt: '2026-01-01T00:00:00.000Z' },
      error: 'stub rate limit',
    };
  }
  const job = Job.parse(JSON.parse(readFileSync(join(input.in, JOB_FILE), 'utf8')));
  const own = new URL(`${job.role}.${fixture}.json`, FIXTURES);
  const file = existsSync(own) ? own : new URL(`${job.role}.ready.json`, FIXTURES);
  const result = JSON.parse(readFileSync(file, 'utf8'));
  // A plan writes plan.md; a build or repair changes the checkout; a review or retro writes nothing.
  if (job.role !== 'review' && job.role !== 'retro') {
    const target = job.role === 'plan' ? join(input.out, PLAN_FILE) : join(input.cwd, 'STUB.md');
    const ownText = new URL(`${job.role}.${fixture}.md`, FIXTURES);
    copyFileSync(existsSync(ownText) ? ownText : new URL(`${job.role}.md`, FIXTURES), target);
  }
  input.emit({ type: 'init', fixture });
  input.emit({ type: 'result', ok: true, usage: { input_tokens: 0, output_tokens: 0 } });
  return {
    ok: true,
    result: {
      ...result,
      job: job.job,
      role: job.role,
      inputs: {
        ...result.inputs,
        issue: job.issue.revision,
        plan: job.plan?.revision ?? null,
        base: job.base,
        candidate: job.candidate,
      },
    },
  };
}
