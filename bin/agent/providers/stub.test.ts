import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vite-plus/test';

import { JOB_FILE, type Job, RESULT_FILE, TRANSCRIPT_FILE } from '../job.ts';
import { verdict } from '../publish.ts';
import { Result } from '../result.ts';
import { run } from '../run.ts';

for (const [fixture, failureClass, reason] of [
  ['crash', 'unknown', 'stub crash'],
  ['timeout', 'timeout', 'stub timeout'],
  ['missing', 'unknown', 'without a structured result'],
] as const) {
  test(`the ${fixture} stub writes a failed result and stops publication`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'stub-'));
    const input = join(cwd, 'in');
    const out = join(cwd, 'out');
    mkdirSync(input);
    mkdirSync(out);
    const job: Job = {
      job: 'plan-1',
      role: 'plan',
      objective: '',
      repo: 'o/r',
      issue: { number: 1, title: 'T', revision: 'rev', bodySeen: true },
      plan: null,
      source: 'abc',
      base: null,
      candidate: null,
      memory: null,
      artifacts: [],
      operations: [],
      attemptLimit: null,
      baseMoved: false,
    };
    writeFileSync(join(input, JOB_FILE), JSON.stringify(job));
    const exitCode = process.exitCode;
    vi.stubEnv('DEVKIT_STUB_FIXTURE', fixture);
    try {
      await run({ role: 'plan', executor: 'stub', cwd, in: input, out });
      const result = Result.parse(JSON.parse(readFileSync(join(out, RESULT_FILE), 'utf8')));
      assert.equal(result.status, 'failed');
      assert.equal(result.outcome, null);
      assert.deepEqual(result.failure, { class: failureClass, resetsAt: null });
      assert.ok(result.summary.includes(reason), result.summary);
      assert.equal(process.exitCode, 1);
      const events = readFileSync(join(out, TRANSCRIPT_FILE), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(events[0].type, 'init');
      assert.equal(events[0].fixture, fixture);
      assert.deepEqual(verdict(job, 'rev', out), {
        stage: 'plan',
        reason: `\`${failureClass}\`: ${result.summary.replace(/\.$/, '')}`,
        failure: { class: failureClass, resetsAt: null },
      });
    } finally {
      process.exitCode = exitCode;
      vi.unstubAllEnvs();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test('stub replans answer open threads without modifying the candidate, and spec converges after approval', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'stub-replan-'));
  const input = join(cwd, 'in');
  const out = join(cwd, 'out');
  mkdirSync(input);
  mkdirSync(out);
  const job: Job = {
    job: 'replan-1',
    role: 'replan',
    objective: '',
    repo: 'o/r',
    issue: { number: 1, title: 'T', revision: 'rev', bodySeen: true },
    plan: { revision: 'plan', criteria: ['A1'], checks: { A1: 'ci' } },
    source: 'head',
    base: 'base',
    candidate: 'head',
    memory: null,
    artifacts: [],
    operations: [],
    attemptLimit: null,
    baseMoved: false,
  };
  writeFileSync(join(input, JOB_FILE), JSON.stringify(job));
  writeFileSync(
    join(input, 'threads.json'),
    JSON.stringify([
      { id: 'F1', resolved: false },
      { id: 'old', resolved: true },
    ]),
  );
  const exitCode = process.exitCode;
  try {
    for (const fixture of ['ready', 'spec', 'never']) {
      vi.stubEnv('DEVKIT_STUB_FIXTURE', fixture);
      await run({ role: 'replan', executor: 'stub', cwd, in: input, out });
      const result = Result.parse(JSON.parse(readFileSync(join(out, RESULT_FILE), 'utf8')));
      assert.equal(result.status, 'complete');
      assert.deepEqual(
        result.changes?.map((c) => c.ref),
        ['F1'],
      );
      assert.equal(existsSync(join(cwd, 'STUB.md')), false);
      if (fixture === 'spec') {
        assert.equal(result.criteria?.[1]?.id, 'A2');
        assert.match(readFileSync(join(out, 'plan.md'), 'utf8'), /A2/);
        rmSync(join(out, 'plan.md'));
      } else assert.equal(existsSync(join(out, 'plan.md')), false);
    }
    vi.stubEnv('DEVKIT_STUB_FIXTURE', 'spec');
    const repair = readFileSync(new URL('../fixtures/repair.md', import.meta.url), 'utf8');
    for (const [content, expected] of [
      ['not yet repaired', 'changes-requested'],
      [repair, 'pass'],
    ]) {
      writeFileSync(join(cwd, 'STUB.md'), content!);
      writeFileSync(join(input, JOB_FILE), JSON.stringify({ ...job, role: 'review' }));
      await run({ role: 'review', executor: 'stub', cwd, in: input, out });
      const result = Result.parse(JSON.parse(readFileSync(join(out, RESULT_FILE), 'utf8')));
      assert.equal(result.outcome, expected);
    }
  } finally {
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the verifier stub checks ready and unverified fixtures without changing the candidate', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'stub-verify-'));
  const input = join(cwd, 'in');
  const out = join(cwd, 'out');
  mkdirSync(input);
  mkdirSync(out);
  const job: Job = {
    job: 'verify-1',
    role: 'verify',
    objective: '',
    repo: 'o/r',
    issue: { number: 1, title: 'T', revision: 'rev', bodySeen: true },
    plan: { revision: 'plan', criteria: ['A1'], checks: { A1: 'agent' } },
    source: 'head',
    base: 'base',
    candidate: 'head',
    memory: null,
    artifacts: [],
    operations: [],
    attemptLimit: null,
    baseMoved: false,
  };
  writeFileSync(join(input, JOB_FILE), JSON.stringify(job));
  const content = 'unrepaired candidate';
  writeFileSync(join(cwd, 'STUB.md'), content);
  const exitCode = process.exitCode;
  try {
    for (const fixture of ['ready', 'unverified']) {
      vi.stubEnv('DEVKIT_STUB_FIXTURE', fixture);
      await run({ role: 'verify', executor: 'stub', cwd, in: input, out });
      const result = Result.parse(JSON.parse(readFileSync(join(out, RESULT_FILE), 'utf8')));
      assert.equal(result.outcome, fixture === 'ready' ? 'verified' : 'failed');
      assert.equal(result.evidence[0]?.criterion, 'A1');
      assert.equal(result.evidence[0]?.result, fixture === 'ready' ? 'pass' : 'fail');
      assert.equal(
        readFileSync(join(out, result.evidence[0]!.location), 'utf8'),
        result.evidence[0]?.check,
      );
      if (fixture === 'ready') {
        assert.equal(result.evidence[0]?.location, 'checks/A1.sh');
        const script = join(out, 'checks/A1.sh');
        assert.equal(spawnSync('bash', [script], { cwd }).status, 0);
        rmSync(join(cwd, 'STUB.md'));
        assert.equal(spawnSync('bash', [script], { cwd }).status, 1);
        writeFileSync(join(cwd, 'STUB.md'), content);
      }
      assert.equal(result.inputs.candidate, 'head');
      assert.equal(readFileSync(join(cwd, 'STUB.md'), 'utf8'), content);
    }
    writeFileSync(
      join(cwd, 'STUB.md'),
      readFileSync(new URL('../fixtures/repair.md', import.meta.url)),
    );
    await run({ role: 'verify', executor: 'stub', cwd, in: input, out });
    const result = Result.parse(JSON.parse(readFileSync(join(out, RESULT_FILE), 'utf8')));
    assert.equal(result.outcome, 'verified');
    assert.equal(result.evidence[0]?.result, 'pass');
    assert.equal(
      readFileSync(join(out, result.evidence[0]!.location), 'utf8'),
      result.evidence[0]?.check,
    );
  } finally {
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('critique fixtures request criticism and return pass or changes-requested without editing the checkout', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'stub-critique-'));
  const input = join(cwd, 'in'),
    out = join(cwd, 'out');
  mkdirSync(input);
  mkdirSync(out);
  const job = {
    job: 'plan-1',
    role: 'plan',
    objective: '',
    repo: 'o/r',
    issue: { number: 1, title: 'T', revision: 'issue', bodySeen: true },
    plan: null,
    source: 'base',
    base: null,
    candidate: null,
    memory: null,
    baseMoved: false,
    artifacts: [],
    operations: [],
    attemptLimit: null,
  };
  const exit = process.exitCode;
  try {
    for (const fixture of ['critique', 'critique-pass']) {
      vi.stubEnv('DEVKIT_STUB_FIXTURE', fixture);
      writeFileSync(join(input, JOB_FILE), JSON.stringify(job));
      await run({ role: 'plan', executor: 'stub', cwd, in: input, out });
      const plan = Result.parse(JSON.parse(readFileSync(join(out, RESULT_FILE), 'utf8')));
      assert.equal(plan.critique, true);
      writeFileSync(
        join(input, JOB_FILE),
        JSON.stringify({
          ...job,
          role: 'critique',
          plan: { revision: 'plan', criteria: ['A1'], checks: { A1: 'agent' } },
        }),
      );
      await run({ role: 'critique', executor: 'stub', cwd, in: input, out });
      const critic = Result.parse(JSON.parse(readFileSync(join(out, RESULT_FILE), 'utf8')));
      assert.equal(critic.outcome, fixture === 'critique' ? 'changes-requested' : 'pass');
      assert.equal(critic.inputs.base, 'base');
      assert.equal(existsSync(join(cwd, 'STUB.md')), false);
    }
  } finally {
    process.exitCode = exit;
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});
for (const fixture of ['ready', 'docs', 'inconclusive']) {
  test(`research stub ${fixture} writes a report that passes verdict`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'research-stub-'));
    const input = join(cwd, 'in');
    const out = join(cwd, 'out');
    mkdirSync(input);
    mkdirSync(out);
    const job: Job = {
      job: 'research-1',
      role: 'research',
      objective: '',
      repo: 'o/r',
      issue: { number: 1, title: 'T', revision: 'rev', bodySeen: true },
      plan: null,
      source: 'abc',
      base: null,
      candidate: null,
      memory: null,
      baseMoved: false,
      artifacts: [],
      operations: [],
      attemptLimit: null,
    };
    writeFileSync(join(input, JOB_FILE), JSON.stringify(job));
    const exitCode = process.exitCode;
    vi.stubEnv('DEVKIT_STUB_FIXTURE', fixture);
    try {
      await run({ role: 'research', executor: 'stub', cwd, in: input, out });
      const checked = verdict(job, 'rev', out);
      assert.ok('result' in checked, JSON.stringify(checked));
      assert.equal(
        checked.result.outcome,
        fixture === 'inconclusive' ? 'inconclusive' : 'answered',
      );
      assert.equal(checked.result.docs, fixture === 'docs');
      assert.match(readFileSync(join(out, 'research.md'), 'utf8'), /Research/);
      assert.equal(existsSync(join(cwd, 'STUB.md')), false);
    } finally {
      process.exitCode = exitCode;
      vi.unstubAllEnvs();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
