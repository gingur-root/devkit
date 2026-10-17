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
// `crash` throws, `timeout` reports a timeout, and `missing` returns no result.
// `changes` asks for repair until STUB.md matches the repair fixture; `never`
// always asks for repair; `advisory` passes with an inline advisory finding.

import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { STUB_FIXTURES, type StubFixture } from '../constants.ts';
import { JOB_FILE, Job, PLAN_FILE, REVIEW_FILE } from '../job.ts';
import { agentEnv, type RunInput, type RunOutput } from './shared.ts';
import { toolsEnv } from '../tools.ts';

const FIXTURES = new URL('../fixtures/', import.meta.url);

export async function runStub(input: RunInput): Promise<RunOutput> {
  const fixture = (process.env.DEVKIT_STUB_FIXTURE ?? 'ready') as StubFixture;
  if (!STUB_FIXTURES.includes(fixture)) throw new Error(`No stub fixture "${fixture}".`);
  if (!input.in || !input.out) throw new Error('The stub needs --in and --out.');
  input.emit({
    type: 'init',
    fixture,
    tools: {
      claude: input.tools.claude,
      codex: input.tools.codex,
      env: Object.keys({ ...agentEnv('stub', process.env), ...toolsEnv(input.tools, process.env) }),
    },
  });
  if (fixture === 'crash' || fixture === 'timeout' || fixture === 'missing') {
    if (fixture === 'crash') throw new Error('stub crash');
    if (fixture === 'missing') return { ok: true };
    return {
      ok: false,
      failure: { class: 'timeout', resetsAt: null },
      error: 'stub timeout',
    };
  }
  if (fixture === 'rate-limit') {
    return {
      ok: false,
      failure: { class: 'rate_limit', resetsAt: '2026-01-01T00:00:00.000Z' },
      error: 'stub rate limit',
    };
  }
  const job = Job.parse(JSON.parse(readFileSync(join(input.in, JOB_FILE), 'utf8')));
  const repaired =
    fixture === 'changes' &&
    job.role === 'review' &&
    existsSync(join(input.cwd, 'STUB.md')) &&
    readFileSync(join(input.cwd, 'STUB.md'), 'utf8') ===
      readFileSync(new URL('repair.md', FIXTURES), 'utf8');
  const own = new URL(`${job.role}.${repaired ? 'ready' : fixture}.json`, FIXTURES);
  const file = existsSync(own) ? own : new URL(`${job.role}.ready.json`, FIXTURES);
  const result = JSON.parse(readFileSync(file, 'utf8'));
  const reviewFile = join(input.in, REVIEW_FILE);
  if (job.role === 'repair' && existsSync(reviewFile)) {
    const review = JSON.parse(readFileSync(reviewFile, 'utf8'));
    result.changes = (review.findings ?? []).map((finding: { id: string }) => ({
      ref: finding.id,
      change: 'Rewrote STUB.md.',
      response: null,
      evidence: null,
    }));
  }
  // A plan writes plan.md; a build or repair changes the checkout; a review or retro writes nothing.
  if (job.role !== 'review' && job.role !== 'retro') {
    const target = job.role === 'plan' ? join(input.out, PLAN_FILE) : join(input.cwd, 'STUB.md');
    const ownText = new URL(`${job.role}.${fixture}.md`, FIXTURES);
    copyFileSync(existsSync(ownText) ? ownText : new URL(`${job.role}.md`, FIXTURES), target);
    // Every never-pass repair must produce a new candidate to reach the cap.
    if (fixture === 'never' && job.role === 'repair')
      appendFileSync(target, `\nRepair of candidate ${job.source}.\n`);
  }
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
