// Exercise failures through the same run/result/verdict seam the pipeline uses.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vite-plus/test';

import { JOB_FILE, type Job, RESULT_FILE, TRANSCRIPT_FILE } from '../job.ts';
import { verdict } from '../publish.ts';
import { Result } from '../result.ts';
import { run } from '../run.ts';

for (const [fixture, failureClass, summary] of [
  ['crash', 'unknown', /stub crash/],
  ['timeout', 'timeout', /stub timeout/],
  ['missing', 'unknown', /without a structured result/],
] as const) {
  test(`the ${fixture} stub writes a failed result and stops at plan`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'devkit-stub-'));
    const input = join(cwd, 'in');
    const out = join(cwd, 'out');
    mkdirSync(input);
    mkdirSync(out);
    const job: Job = {
      job: 'plan-1',
      role: 'plan',
      objective: '',
      repo: 'o/r',
      issue: { number: 1, title: 'T', revision: 'rev' },
      plan: null,
      source: 'abc',
      base: null,
      candidate: null,
      artifacts: [],
      operations: [],
      attemptLimit: null,
    };
    writeFileSync(join(input, JOB_FILE), JSON.stringify(job));
    const exitCode = process.exitCode;
    vi.stubEnv('DEVKIT_STUB_FIXTURE', fixture);
    try {
      await run({ role: 'plan', executor: 'stub', cwd, in: input, out });
      const result = Result.parse(JSON.parse(readFileSync(join(out, RESULT_FILE), 'utf8')));
      assert.equal(process.exitCode, 1);
      assert.equal(result.status, 'failed');
      assert.equal(result.outcome, null);
      assert.match(result.summary, summary);
      assert.deepEqual(result.failure, { class: failureClass, resetsAt: null });
      const stop = verdict(job, 'rev', out);
      assert.ok('stage' in stop);
      assert.equal(stop.stage, 'plan');
      assert.ok(stop.reason.startsWith(`\`${failureClass}\`:`));
      assert.match(stop.reason, summary);
      const events = readFileSync(join(out, TRANSCRIPT_FILE), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(events[0].type, 'init');
      assert.equal(events[0].fixture, fixture);
    } finally {
      process.exitCode = exitCode;
      vi.unstubAllEnvs();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
