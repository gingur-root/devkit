// The eval's hidden checks only measure anything while no agent can read them,
// and a passing review over a failing check is the number it exists to report.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished, test, vi } from 'vite-plus/test';

import { evaluate } from './eval.ts';

test('eval stops after two repairs even when reviews keep requesting changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'devkit-eval-cap-'));
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  vi.stubEnv('DEVKIT_STUB_FIXTURE', 'never');
  const repo = join(root, 'repo');
  const caseDir = join(repo, 'eval', 'never');
  mkdirSync(caseDir, { recursive: true });
  mkdirSync(join(repo, 'eval', 'fixture'), { recursive: true });
  writeFileSync(join(repo, 'eval', 'fixture', 'README.md'), '# Eval fixture\n');
  writeFileSync(join(caseDir, 'issue.md'), '# Never passes\n\nKeep trying.\n');
  writeFileSync(join(caseDir, 'case.json'), '{ "plan": "ready" }\n');
  writeFileSync(join(caseDir, 'check.sh'), 'test -f STUB.md\n');
  execFileSync('git', ['init', '--quiet'], { cwd: repo });

  const out = join(root, 'out');
  const [score] = evaluate({ repo, out, executor: 'stub' });
  assert.equal(score?.repairs, 2);
  assert.equal(score?.review, 'changes-requested');
  assert.equal(score?.stopped, null);
  assert.deepEqual(score?.checks, [true, true, true]);
  assert.equal(score?.overRejected, 3);
  for (const round of [0, 1, 2]) assert.ok(existsSync(join(out, 'never', `check-${round}.log`)));
  assert.ok(!existsSync(join(out, 'never', 'check.log')));
  const card = readFileSync(join(out, 'scorecard.md'), 'utf8');
  assert.match(card, /\| Over-rejected \|/);
  assert.match(card, /Over-rejected: 3\./);
  assert.ok(existsSync(join(out, 'never', 'review-2', 'out', 'result.json')));
  assert.ok(!existsSync(join(out, 'never', 'repair-3')));
});

test.each([1, 3])(
  'fixture cases keep hidden checks out and report missed reviews over %i runs',
  (runs) => {
    const repo = mkdtempSync(join(tmpdir(), 'devkit-eval-'));
    mkdirSync(join(repo, 'eval', 'fixture'), { recursive: true });
    writeFileSync(join(repo, 'eval', 'fixture', 'README.md'), '# repo\n');
    writeFileSync(join(repo, 'smoke.sh'), 'exit 0\n');
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
    onTestFinished(() => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    });
    const scores = evaluate({ repo, out, executor: 'stub', runs });
    assert.equal(scores.length, 2 * runs);
    for (const name of ['good', 'bad']) {
      assert.deepEqual(
        scores.filter((s) => s.case === name).map((s) => s.run),
        Array.from({ length: runs }, (_, i) => i + 1),
      );
    }
    assert.ok(scores.every((s) => !s.invalid && s.overRejected === 0));
    const card = readFileSync(join(out, 'scorecard.md'), 'utf8');
    if (runs > 1) {
      assert.match(card, /\| good \| 3 \| 3\/3 \| 3\/3 \| 0\/3 \| 0\/3 \|/);
      assert.match(card, /\| bad \| 3 \| 3\/3 \| 0\/3 \| 3\/3 \| 0\/3 \|/);
      for (let run = 1; run <= runs; run++)
        assert.ok(existsSync(join(out, 'good', `run-${run}`, 'repo')));
    } else assert.doesNotMatch(card, /\| Case \| Runs \|/);

    const good = scores.find((s) => s.case === 'good');
    assert.deepEqual(
      [good?.plan, good?.check, good?.review, good?.missed, good?.stopped],
      ['ready', true, 'pass', false, null],
    );
    assert.equal(scores.find((s) => s.case === 'bad')?.missed, true);

    const work = join(out, 'good', ...(runs > 1 ? ['run-1'] : []), 'repo');
    assert.ok(existsSync(join(work, 'README.md')));
    assert.ok(!existsSync(join(work, 'smoke.sh')));
    assert.ok(existsSync(join(work, 'seeded.txt')));
    assert.ok(!existsSync(join(work, 'eval')));
    // The base plus the build's commit: nothing older to dig a check out of.
    assert.equal(
      execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim(),
      '2',
    );
  },
);

test('a passing base is invalid before planning, while a case without a check still runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'devkit-eval-invalid-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'eval', 'fixture'), { recursive: true });
  writeFileSync(join(repo, 'eval', 'fixture', 'README.md'), '# repo\n');
  for (const name of ['trivial', 'no-check']) {
    const dir = join(repo, 'eval', name);
    mkdirSync(dir);
    writeFileSync(join(dir, 'issue.md'), '# Do it\n');
    writeFileSync(join(dir, 'case.json'), '{ "plan": "ready" }\n');
  }
  writeFileSync(join(repo, 'eval', 'trivial', 'check.sh'), 'true\n');
  const out = join(root, 'out');
  const scores = evaluate({ repo, out, executor: 'stub' });
  const trivial = scores.find((s) => s.case === 'trivial');
  assert.equal(trivial?.invalid, true);
  assert.equal(trivial?.stopped, 'invalid: check passes on the base');
  assert.equal(trivial?.check, null);
  assert.ok(existsSync(join(out, 'trivial', 'check-base.log')));
  assert.ok(!existsSync(join(out, 'trivial', 'plan')));
  assert.equal(scores.find((s) => s.case === 'no-check')?.invalid, false);
  assert.ok(existsSync(join(out, 'no-check', 'review-0')));
  assert.match(readFileSync(join(out, 'scorecard.md'), 'utf8'), /Invalid: 1\./);
});
