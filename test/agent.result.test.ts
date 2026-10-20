import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vite-plus/test';
import { parse } from 'yaml';

test('agent.run requests criticism only for complete ready plans that opt in', () => {
  const action = parse(
    readFileSync(new URL('../actions/agent.run/action.yml', import.meta.url), 'utf8'),
  );
  const step = action.runs.steps.find((step: { id?: string }) => step.id === 'result');
  assert.equal(action.outputs.critique.value, '${{ steps.result.outputs.critique }}');
  const root = mkdtempSync(join(tmpdir(), 'agent-result-'));
  mkdirSync(join(root, 'agent/out'), { recursive: true });
  const result = join(root, 'agent/out/result.json');
  const output = join(root, 'github-output');
  try {
    for (const [text, expected] of [
      [JSON.stringify({ status: 'complete', outcome: 'ready', critique: true }), 'true'],
      [JSON.stringify({ status: 'complete', outcome: 'ready', critique: false }), ''],
      [JSON.stringify({ status: 'failed', outcome: null, critique: true }), ''],
      [JSON.stringify({ status: 'complete', outcome: 'needs-input', critique: true }), ''],
      ['{}', ''],
      ['{', ''],
      [null, ''],
    ]) {
      if (text === null) rmSync(result);
      else writeFileSync(result, text!);
      writeFileSync(output, '');
      execFileSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
        env: { PATH: process.env.PATH, RUNNER_TEMP: root, GITHUB_OUTPUT: output },
      });
      assert.equal(readFileSync(output, 'utf8'), `critique=${expected}\n`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
