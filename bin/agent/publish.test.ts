// The review gate: a pass tells the operator the PR is safe to merge, so only a
// clean pass may say so.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vite-plus/test';

import { commitMessage, gated, passes, repairable } from './publish.ts';
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

test('only a clean pass passes', () => {
  assert.ok(passes(pass));
  assert.ok(!passes({ ...pass, outcome: 'changes-requested' }));
  assert.ok(!passes({ ...pass, outcome: 'inconclusive' }));
  assert.ok(!passes({ ...pass, axes: null }));
  assert.ok(!passes({ ...pass, axes: { ...pass.axes!, spec: 'changes-requested' } }));
  assert.ok(!passes({ ...pass, findings: [finding] }), 'a blocking finding');
  assert.ok(passes({ ...pass, findings: [{ ...finding, blocking: false }] }), 'advisory only');
  assert.ok(!passes({ ...pass, questions: ['Ship it?'] }), 'a question for the operator');
});

test('only findings with nothing to ask go to repair', () => {
  const asks = { ...pass, outcome: 'changes-requested' as const, findings: [finding] };
  assert.ok(repairable(asks));
  assert.ok(!repairable(pass), 'a pass');
  assert.ok(!repairable({ ...asks, findings: [] }), 'nothing to fix');
  assert.ok(!repairable({ ...asks, questions: ['Which API?'] }), 'a decision for the operator');
  assert.ok(!repairable({ ...asks, outcome: 'inconclusive' }), 'an inconclusive review');
});

test('only CI green on the reviewed commit itself reaches Ready', () => {
  const head = 'b'.repeat(40);
  assert.ok(passes(gated(pass, head, head)));
  assert.ok(!passes(gated(pass, head, '')), 'CI failed');
  assert.ok(!passes(gated(pass, head, 'a'.repeat(40))), 'CI passed on an earlier commit');
  assert.ok(!passes(gated(pass, null, '')), 'no candidate');
  assert.ok(repairable(gated(pass, head, '')), 'red CI goes to repair');
  const asks = { ...pass, outcome: 'inconclusive' as const };
  assert.ok(!repairable(gated(asks, head, '')), 'an inconclusive review still needs the operator');
});

test('every pushed commit lists the operator as co-author', () => {
  const issue = { number: 76, title: 'Add a thing', revision: '' };
  for (const role of ['build', 'repair', 'elevated']) {
    const trailers = commitMessage({ role, issue }).split('\n\n').at(-1);
    assert.equal(
      trailers,
      'Co-authored-by: Troy Rhinehart <2553213+gingur@users.noreply.github.com>',
      role,
    );
  }
});
