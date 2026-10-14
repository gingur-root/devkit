// The build runs whatever plan this gate returns, so it must accept only the
// App's ready plan, unedited, for the issue as it is now.

import assert from 'node:assert/strict';
import { test, vi } from 'vite-plus/test';

import { OPERATOR_ID } from './constants.ts';
import { CONTRACT_PREFIX, marker, PLAN_END, PLAN_START, revision } from './job.ts';
import { approvedPlan, render } from './render.ts';

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

test('a build the App started without a Continue never renders, even with a ready plan', async () => {
  const bot = 340770692;
  const routes: Record<string, unknown> = {
    '/repos/o/r/issues/1': { number: 1, title: 'Title', body: 'Body', user: { id: OPERATOR_ID } },
    '/repos/o/r/issues/1/comments': [comment()],
    '/repos/o/r/issues/1/events': [
      {
        event: 'labeled',
        created_at: '2026-10-14T10:00:00Z',
        actor: { id: bot },
        label: { name: 'agent:build' },
      },
    ],
  };
  const writes: string[] = [];
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (init.method !== 'GET') writes.push(`${init.method} ${path}`);
    const body = init.method === 'GET' ? (routes[path] ?? []) : {};
    return new Response(JSON.stringify(body), { status: 200 });
  });
  try {
    await assert.rejects(
      render({
        repo: 'o/r',
        issue: 1,
        role: 'build',
        source: 'abc',
        appId: APP,
        actor: bot,
        out: '/nonexistent',
      }),
      /Not approved/,
    );
    // It says why on the issue and drops the label, as any refusal does.
    assert.deepEqual(writes, [
      'POST /repos/o/r/issues/1/comments',
      'DELETE /repos/o/r/issues/1/labels/agent%3Abuild',
    ]);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
