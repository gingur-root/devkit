// The build runs whatever plan this gate returns, so it must accept only the
// App's ready plan, unedited, for the issue as it is now.

import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import { OPERATOR_ID } from './constants.ts';
import { CONTRACT_PREFIX, marker, PLAN_END, PLAN_START, revision } from './job.ts';
import { approvedPlan } from './render.ts';

const APP = 7;
const ISSUE = revision('Title', 'Body');
const PLAN = '## Criteria\n\n- **A1:** it works.';

function comment(plan = PLAN, overrides: Record<string, unknown> = {}, app = APP) {
  const contract = {
    planRevision: revision(PLAN),
    outcome: 'ready',
    source: 'abc',
    issueRevision: ISSUE,
    checks: { A1: 'ci' },
    critique: false,
    ...overrides,
  };
  const body = [
    marker('plan'),
    `${PLAN_START}\n${plan}\n${PLAN_END}`,
    `${CONTRACT_PREFIX}${JSON.stringify(contract)} -->`,
  ].join('\n\n');
  return { body, user: { id: 1 }, performed_via_github_app: { id: app }, created_at: '' };
}

test('only the App’s ready, unedited plan for the live issue is approved', () => {
  assert.equal(approvedPlan([comment()], APP, ISSUE).plan, PLAN);
  assert.equal(
    approvedPlan([{ ...comment(), body: comment().body.replace(/\n/g, '\r\n') }], APP, ISSUE).plan,
    PLAN,
    'CRLF from GitHub still matches',
  );
  assert.throws(() => approvedPlan([comment(PLAN, {}, 99)], APP, ISSUE), /No plan comment/);
  const desk = { ...comment(PLAN, {}, 99), user: { id: OPERATOR_ID } };
  assert.equal(approvedPlan([desk], APP, ISSUE).plan, PLAN, 'the operator’s gh published it');
  assert.throws(() => approvedPlan([comment(`${PLAN}!`)], APP, ISSUE), /edited/);
  assert.throws(
    () => approvedPlan([comment(PLAN, { outcome: 'needs-input' })], APP, ISSUE),
    /not ready/,
  );
  assert.throws(() => approvedPlan([comment()], APP, revision('Title', 'New body')), /changed/);
});
