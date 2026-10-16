// The build runs whatever plan this gate returns, so it must accept only the
// App's ready plan, unedited, for the issue as it is now.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { test, vi } from 'vite-plus/test';

import renderCommand from '../commands/agent/render.ts';
import { OPERATOR_ID, PIPELINE_BOT } from './constants.ts';
import { CONTRACT_PREFIX, marker, PLAN_END, PLAN_START, revision } from './job.ts';
import { approvedPlan, openIssues, render } from './render.ts';

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
  assert.equal(approvedPlan([comment()], APP, ISSUE).contract.triage, null, 'a pre-triage plan');
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

test("a retro plan's issue list holds only the operator's and the App's issues", () => {
  const base = { body: '', created_at: '', labels: [{ name: 'retro' }] };
  const list = openIssues(
    [
      { ...base, number: 1, title: 'Mine', user: { id: OPERATOR_ID } },
      { ...base, number: 2, title: 'App', user: { id: 1 }, performed_via_github_app: { id: APP } },
      { ...base, number: 3, title: 'Stranger', user: { id: 1 } },
      { ...base, number: 5, title: 'Retro', user: { id: PIPELINE_BOT.id } },
      { ...base, number: 4, title: 'A PR', user: { id: OPERATOR_ID }, pull_request: {} },
    ],
    APP,
  );
  assert.equal(list, '- #1 Mine `retro`\n- #2 App `retro`\n- #5 Retro `retro`');
});

test('only the operator dispatcher bypasses the history gate for build and elevated', async () => {
  const out = mkdtempSync(join(tmpdir(), 'render-dispatcher-'));
  const reads: string[] = [];
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (init.method !== 'GET') return new Response(JSON.stringify({}));
    reads.push(path);
    const routes: Record<string, unknown> = {
      '/repos/o/r/issues/1': { number: 1, title: 'Title', body: 'Body', user: { id: OPERATOR_ID } },
      '/repos/o/r/issues/1/comments': [comment()],
      '/repos/o/r/issues/1/events': [],
    };
    return new Response(JSON.stringify(routes[path] ?? []));
  });
  try {
    for (const role of ['build', 'elevated'] as const) {
      const options = {
        repo: 'o/r',
        issue: 1,
        role,
        source: 'abc',
        appId: APP,
        actor: OPERATOR_ID,
        out,
      };
      const job = await render({ ...options, dispatcher: OPERATOR_ID });
      assert.equal(job.role, role);
      assert.equal(JSON.parse(readFileSync(join(out, 'job.json'), 'utf8')).role, role);
      assert.equal(reads.includes('/repos/o/r/issues/1/events'), false);
      for (const dispatcher of [PIPELINE_BOT.id, undefined]) {
        await assert.rejects(render({ ...options, dispatcher }), /Not approved/);
      }
      reads.length = 0;
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

test('the render CLI defaults the dispatcher from GitHub and accepts an explicit override', () => {
  const parse = (args: string[] = []) => {
    const command = new Command();
    renderCommand.configure(command);
    command.parse(
      [
        '--repo',
        'o/r',
        '--issue',
        '1',
        '--role',
        'build',
        '--app-id',
        '7',
        '--out',
        'out',
        ...args,
      ],
      { from: 'user' },
    );
    return command.opts();
  };
  try {
    vi.stubEnv('GITHUB_ACTOR_ID', String(OPERATOR_ID));
    assert.equal(parse().dispatcher, OPERATOR_ID);
    assert.equal(parse(['--dispatcher', String(PIPELINE_BOT.id)]).dispatcher, PIPELINE_BOT.id);
    vi.stubEnv('GITHUB_ACTOR_ID', undefined);
    assert.equal(parse().dispatcher, undefined);
    assert.equal(parse(['--actor', String(OPERATOR_ID)]).dispatcher, undefined);
  } finally {
    vi.unstubAllEnvs();
  }
});
