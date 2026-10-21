import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vite-plus/test';
import { parse } from 'yaml';

test('report mode emits failed checks in run order and passes them to the verdict', () => {
  const workflow = parse(readFileSync('.github/workflows/toolchain.verify.yml', 'utf8'));
  const step = workflow.jobs.verify.steps.find((s: { id?: string }) => s.id === 'failed');
  assert.ok(step, 'missing failed-check reporter');
  assert.equal(step.if, 'inputs.report');
  assert.equal(workflow.on.workflow_call.outputs.failed.value, '${{ jobs.verify.outputs.failed }}');
  assert.equal(workflow.jobs.verify.outputs.failed, '${{ steps.failed.outputs.failed }}');
  const round = parse(readFileSync('.github/workflows/agent.round.yml', 'utf8'));
  const publish = round.jobs.verdict.steps.find((s: { id?: string }) => s.id === 'publish');
  assert.equal(publish.env.FAILED, '${{ needs.verify.outputs.failed }}');
  assert.match(publish.run, /--ci-failed "\$FAILED"/);
  const dir = mkdtempSync(join(tmpdir(), 'verify-failed-'));
  try {
    for (const [lint, testOutcome, expected] of [
      ['failure', 'failure', 'failed=lint,test\n'],
      ['success', 'success', 'failed=\n'],
      ['skipped', 'cancelled', 'failed=\n'],
    ]) {
      const output = join(dir, `${lint}-${testOutcome}`);
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
        env: {
          PATH: process.env.PATH,
          FORMAT: 'success',
          LINT: lint,
          TYPECHECK: 'success',
          TEST: testOutcome,
          BUILD: 'skipped',
          GITHUB_OUTPUT: output,
        },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, 'utf8'), expected);
    }
    for (const id of ['format', 'lint', 'typecheck', 'test', 'build'])
      assert.equal(step.env[id.toUpperCase()], `\${{ steps.${id}.outcome }}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
