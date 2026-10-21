import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vite-plus/test';

import { criterionVerdict, gated, nextStep } from './publish.ts';
import { Result } from './result.ts';

const review = Result.parse(
  JSON.parse(readFileSync(new URL('fixtures/review.ready.json', import.meta.url), 'utf8')),
);
const evidence = {
  criterion: 'A1',
  check: 'exercise the candidate',
  expected: 'works',
  observed: 'works',
  exit: 0,
  location: 'checks/A1.sh',
  result: 'pass' as const,
};
const checked = {
  ...review,
  role: 'verify',
  outcome: 'verified' as const,
  inputs: { ...review.inputs, candidate: 'head' },
  evidence: [evidence],
  axes: null,
};
const gate = {
  candidate: 'head',
  head: 'head',
  review: { result: review },
  verified: 'head',
  round: 0,
  rounds: 10,
  checks: { A1: 'agent' },
  check: { result: checked },
  outputs: ['checks/A1.sh'],
  rechecked: ['A1'],
};

for (const exit of [1, null]) {
  test(`a verifier pass with exit ${exit} stops at verify`, () => {
    const input = {
      ...gate,
      check: { result: { ...checked, evidence: [{ ...evidence, exit }] } },
    };
    const verdict = criterionVerdict(input);
    assert.equal(verdict.kind, 'stop');
    if (verdict.kind === 'stop') {
      assert.equal(verdict.stage, 'verify');
      assert.ok(verdict.reason.includes(`A1: exit ${exit}`), verdict.reason);
    }
    assert.equal(nextStep(input), 'stop');
  });
}

for (const [location, outputs] of [
  ['check.log', []],
  ['/etc/passwd', ['/etc/passwd']],
  ['../in/job.json', ['../in/job.json']],
  ['checks/../check.log', ['check.log']],
  ['checks/A1.sh', []],
  ['steps.json', ['steps.json']],
  ['candidate.patch', ['candidate.patch']],
  ['A1.log', ['A1.log']],
  ['check.log', ['check.log']],
  ['result.json', ['result.json']],
  ['./result.json', ['result.json']],
  ['check log', ['check log']],
  ['C:/check.log', ['C:/check.log']],
] as const) {
  test(`a verifier pass with location ${location} and outputs ${outputs.join(', ')} stops at verify`, () => {
    const input = {
      ...gate,
      outputs: [...outputs],
      check: { result: { ...checked, evidence: [{ ...evidence, location }] } },
    };
    const verdict = criterionVerdict(input);
    assert.equal(verdict.kind, 'stop');
    if (verdict.kind === 'stop') {
      assert.equal(verdict.stage, 'verify');
      assert.ok(verdict.reason.includes(`A1: location ${location}`), verdict.reason);
    }
    assert.equal(nextStep(input), 'stop');
  });
}

test('verifier scripts accept a leading dot at the fixed criterion path', () => {
  for (const location of ['checks/A1.sh', './checks/A1.sh']) {
    const input = {
      ...gate,
      outputs: ['checks/A1.sh'],
      check: { result: { ...checked, evidence: [{ ...evidence, location }] } },
    };
    assert.deepEqual(criterionVerdict(input), { kind: 'verified' });
    assert.equal(nextStep(input), 'ready');
  }
});

for (const rechecked of [[], undefined, ['A2']]) {
  test(`an agent pass stops unless its script was re-run: ${JSON.stringify(rechecked)}`, () => {
    const input = { ...gate, rechecked };
    const verdict = criterionVerdict(input);
    assert.equal(verdict.kind, 'stop');
    if (verdict.kind === 'stop') {
      assert.equal(verdict.stage, 'verify');
      assert.match(verdict.reason, /A1: checks\/A1\.sh.*re-run/);
    }
    assert.equal(nextStep(input), 'stop');
  });
}

test('agent criteria need passing evidence, a complete verified result, review and CI on the candidate', () => {
  assert.equal(nextStep(gate), 'ready');
  assert.equal(nextStep({ ...gate, verified: '' }), 'repair');
  assert.equal(
    nextStep({ ...gate, review: { result: { ...review, outcome: 'inconclusive' } } }),
    'stop',
  );
  for (const result of [
    { ...checked, evidence: [] },
    { ...checked, evidence: [{ ...evidence, result: 'not-verified' as const }] },
    { ...checked, outcome: 'inconclusive' as const },
    { ...checked, status: 'blocked' as const },
  ])
    assert.equal(nextStep({ ...gate, check: { result } }), 'stop');
  assert.equal(nextStep({ ...gate, checks: { A1: 'agent', A2: 'agent' } }), 'stop');
  assert.equal(nextStep({ ...gate, check: null }), 'stop');
});

test('no agent criteria leaves the review and CI gate unchanged', () => {
  for (const check of [null, gate.check, { stage: 'verify', reason: 'missing' }])
    assert.equal(nextStep({ ...gate, checks: { A1: 'ci', A2: 'operator' }, check }), 'ready');
});

test('a failed agent criterion requests repair even when the verifier claims verified', () => {
  const check = { result: { ...checked, evidence: [{ ...evidence, result: 'fail' as const }] } };
  assert.equal(nextStep({ ...gate, check }), 'repair');
  assert.equal(nextStep({ ...gate, check, round: 10 }), 'stop');
});

test('stale verifier results stop at verify unless the PR head moved', () => {
  for (const check of [
    { stage: 'stale', reason: 'candidate changed' },
    { result: { ...checked, inputs: { ...checked.inputs, candidate: 'old' } } },
  ]) {
    for (const round of [0, 10]) {
      assert.equal(nextStep({ ...gate, check, round }), 'stop');
      const verdict = criterionVerdict({ ...gate, check });
      assert.equal(verdict.kind, 'stop');
      if (verdict.kind === 'stop') {
        assert.equal(verdict.stage, 'verify');
        assert.match(verdict.reason, /could not check A1:/);
      }
    }
    assert.equal(nextStep({ ...gate, check, head: 'newer' }), 'rerun');
    assert.equal(nextStep({ ...gate, check, head: 'newer', round: 10 }), 'stop');
  }
});

test('other verifier stages stop', () => {
  assert.equal(
    nextStep({ ...gate, check: { stage: 'validate', reason: 'invalid result' } }),
    'stop',
  );
});

test('criterion evidence creates one stable finding per failed ID and reports gaps by ID', () => {
  const check = {
    result: {
      ...checked,
      evidence: [
        { ...evidence, result: 'fail' as const },
        { ...evidence, result: 'fail' as const },
      ],
    },
  };
  assert.deepEqual(criterionVerdict({ ...gate, check }), {
    kind: 'findings',
    findings: [
      {
        id: 'V-A1',
        axis: 'spec',
        blocking: true,
        criterion: 'A1',
        path: null,
        line: null,
        evidence: 'checks/A1.sh',
        scenario: 'exercise the candidate',
        impact: 'Criterion A1 fails on head.',
        fix: 'Make A1 pass: works.',
      },
    ],
  });
  const missing = criterionVerdict({ ...gate, checks: { A1: 'agent', A2: 'agent' } });
  assert.equal(missing.kind, 'stop');
  if (missing.kind === 'stop') assert.match(missing.reason, /could not check A2:/);
  const absent = criterionVerdict({ ...gate, check: null });
  assert.equal(absent.kind, 'stop');
  if (absent.kind === 'stop') assert.match(absent.reason, /A1.*did not run/);
  const conflicting = {
    result: { ...checked, evidence: [evidence, { ...evidence, result: 'not-verified' as const }] },
  };
  assert.equal(criterionVerdict({ ...gate, check: conflicting }).kind, 'stop');
});

test('a reviewer reusing V-A1 does not duplicate the independent finding', () => {
  const check = { result: { ...checked, evidence: [{ ...evidence, result: 'fail' as const }] } };
  const verdict = criterionVerdict({ ...gate, check });
  assert.equal(verdict.kind, 'findings');
  if (verdict.kind !== 'findings') return;
  const review = {
    ...checked,
    findings: verdict.findings.map((f) => ({ ...f, evidence: 'reviewer evidence' })),
  };
  const result = gated(review, 'head', 'head', verdict.findings);
  assert.deepEqual(result.findings, verdict.findings);
});
