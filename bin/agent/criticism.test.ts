import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vite-plus/test';

import { criticismPasses } from './approval.ts';
import { PlanContract } from './job.ts';

const old = {
  planRevision: 'plan',
  outcome: 'ready',
  source: 'base',
  issueRevision: 'issue',
  checks: {},
  critique: true,
};

test('old contracts parse and criticism binds to the plan, issue and source', () => {
  const contract = PlanContract.parse(old);
  assert.equal(contract.criticism, null);
  const pass = { outcome: 'pass', planRevision: 'plan', issueRevision: 'issue', source: 'base' };
  for (const [required, criticism, expected] of [
    [false, null, true],
    [true, pass, true],
    [true, null, false],
    ...['planRevision', 'issueRevision', 'source'].map((key) => [
      true,
      { ...pass, [key]: 'other' },
      false,
    ]),
    ...['changes-requested', 'inconclusive', 'failed'].map((outcome) => [
      true,
      { ...pass, outcome },
      false,
    ]),
  ] as const) {
    assert.equal(
      criticismPasses(
        PlanContract.parse({ ...old, critique: required, criticism }),
        'plan',
        'issue',
        'base',
      ),
      expected,
    );
  }
  assert.ok(
    readFileSync(new URL('../../agents/critique.md', import.meta.url), 'utf8').includes(
      'credentials, permissions or fetches',
    ),
  );
});
