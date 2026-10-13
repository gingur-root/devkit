// The merge gate: a review that lets a change through here ships it to main
// with nobody looking, so only a clean pass may merge.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { mergeable } from './publish.ts';
import { Result } from './result.ts';

const pass = Result.parse(
  JSON.parse(readFileSync(new URL('fixtures/review.ready.json', import.meta.url), 'utf8')),
);
const finding = {
  id: 'F1',
  axis: 'correctness',
  blocking: true,
  criterion: null,
  path: null,
  line: null,
  evidence: '',
  scenario: '',
  impact: '',
  fix: '',
} as const;

test('only a clean pass is mergeable', () => {
  assert.ok(mergeable(pass));
  assert.ok(!mergeable({ ...pass, outcome: 'changes-requested' }));
  assert.ok(!mergeable({ ...pass, outcome: 'inconclusive' }));
  assert.ok(!mergeable({ ...pass, axes: null }));
  assert.ok(!mergeable({ ...pass, axes: { ...pass.axes!, spec: 'changes-requested' } }));
  assert.ok(!mergeable({ ...pass, findings: [finding] }), 'a blocking finding');
  assert.ok(mergeable({ ...pass, findings: [{ ...finding, blocking: false }] }), 'advisory only');
  assert.ok(!mergeable({ ...pass, questions: ['Ship it?'] }), 'a question for the operator');
});
