// Writes a fixture result instead of calling a model, so a smoke run of the
// whole chain takes seconds. The fixture's job, role and issue revision come
// from the job file, so `ready` passes the contract check and `invalid` fails
// only on its schema.

import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { STUB_FIXTURES, type StubFixture } from '../constants.ts';
import { JOB_FILE, Job, PLAN_FILE } from '../job.ts';
import type { RunInput, RunOutput } from './shared.ts';

const FIXTURES = new URL('../fixtures/', import.meta.url);

export async function runStub(input: RunInput): Promise<RunOutput> {
  const fixture = (process.env.DEVKIT_STUB_FIXTURE ?? 'ready') as StubFixture;
  if (!STUB_FIXTURES.includes(fixture)) throw new Error(`No stub fixture "${fixture}".`);
  if (!input.in || !input.out) throw new Error('The stub needs --in and --out.');
  const job = Job.parse(JSON.parse(readFileSync(join(input.in, JOB_FILE), 'utf8')));
  const result = JSON.parse(readFileSync(new URL(`${job.role}.${fixture}.json`, FIXTURES), 'utf8'));
  copyFileSync(new URL(`${job.role}.md`, FIXTURES), join(input.out, PLAN_FILE));
  input.emit({ type: 'init', fixture });
  return {
    ok: true,
    result: {
      ...result,
      job: job.job,
      role: job.role,
      inputs: { ...result.inputs, issue: job.issue.revision },
    },
  };
}
