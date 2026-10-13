// The eval's hidden checks only measure anything while no agent can read them,
// and a passing review over a failing check is the number it exists to report.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { evaluate } from './eval.ts';

test('a case runs without its eval folder or history, and a passed review over a failing check is missed', () => {
  const repo = mkdtempSync(join(tmpdir(), 'devkit-eval-'));
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  for (const [name, check] of [
    ['good', 'test -f STUB.md'],
    ['bad', 'exit 1'],
  ] as const) {
    mkdirSync(join(repo, 'eval', name, 'seed'), { recursive: true });
    writeFileSync(join(repo, 'eval', name, 'issue.md'), `# Case ${name}\n\nDo it.\n`);
    writeFileSync(join(repo, 'eval', name, 'case.json'), '{ "plan": "ready" }\n');
    writeFileSync(join(repo, 'eval', name, 'check.sh'), `${check}\n`);
    writeFileSync(join(repo, 'eval', name, 'seed', 'seeded.txt'), 'seed\n');
  }
  execFileSync('git', ['init', '--quiet'], { cwd: repo });

  const out = join(repo, '..', `${repo.split('/').pop()}-out`);
  const scores = evaluate({ repo, out, executor: 'stub' });

  const good = scores.find((s) => s.case === 'good');
  assert.deepEqual(
    [good?.plan, good?.check, good?.review, good?.missed, good?.stopped],
    ['ready', true, 'pass', false, null],
  );
  assert.equal(scores.find((s) => s.case === 'bad')?.missed, true);

  const work = join(out, 'good', 'repo');
  assert.ok(existsSync(join(work, 'seeded.txt')));
  assert.ok(!existsSync(join(work, 'eval')));
  // The base plus the build's commit: nothing older to dig a check out of.
  assert.equal(
    execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim(),
    '2',
  );
});
