// The review gate: a pass tells the operator the PR is safe to merge, so only a
// clean pass may say so. Filing subtasks and follow-ups writes new issues, so a
// retry must never file them twice.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vite-plus/test';

import { ELEVATED_NOTE, OPERATOR_ID, PIPELINE_BOT } from './constants.ts';
import {
  commitMessage,
  failureReason,
  fileFollowups,
  fileSubtasks,
  followupLine,
  gated,
  passes,
  publish,
  publishRetro,
  readyToBuild,
  repairable,
  stopped,
  verdict,
} from './publish.ts';
import {
  ISSUES_FILE,
  JOB_FILE,
  type Job,
  marker,
  PLAN_FILE,
  RESULT_FILE,
  revision,
} from './job.ts';
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

test("a stop names the CLI's failure class and a rate limit's reset time", () => {
  const limited = { class: 'rate_limit', resetsAt: '2026-10-14T04:00:00.000Z' } as const;
  const body = stopped('plan', { stage: 'plan', reason: failureReason(limited, 'Hit a limit.') });
  assert.match(
    body,
    /stopped at `plan`:\*\* `rate_limit`, resets 2026-10-14 04:00 UTC: Hit a limit\./,
  );
  assert.match(failureReason({ ...limited, resetsAt: null }, 'x'), /reset time unknown/);
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

test('a plan hands off to a build only when it is ready with nothing to ask', () => {
  const plan = Result.parse(
    JSON.parse(readFileSync(new URL('fixtures/plan.ready.json', import.meta.url), 'utf8')),
  );
  assert.ok(readyToBuild(plan));
  assert.ok(!readyToBuild({ ...plan, questions: ['Which file?'] }));
  assert.ok(!readyToBuild({ ...plan, outcome: 'needs-input' }));
});

test("only a retro issue's plan triages, and every other plan sets a priority", () => {
  const plan = Result.parse(
    JSON.parse(readFileSync(new URL('fixtures/plan.ready.json', import.meta.url), 'utf8')),
  );
  const job: Job = {
    job: 'plan-1',
    role: 'plan',
    objective: '',
    repo: 'o/r',
    issue: { number: 1, title: 'T', revision: 'rev' },
    plan: null,
    source: 'abc',
    base: null,
    candidate: null,
    artifacts: [],
    operations: [],
    attemptLimit: null,
  };
  const retro = { ...job, artifacts: [ISSUES_FILE] };
  const triage = [
    { title: 'Fix', body: 'b', link: null, start: 'plan', elevated: false, priority: 'P2' },
  ] as const;
  const check = (j: Job, r: Result) => {
    const out = mkdtempSync(join(tmpdir(), 'verdict-'));
    writeFileSync(join(out, PLAN_FILE), 'plan');
    writeFileSync(
      join(out, RESULT_FILE),
      JSON.stringify({ ...r, job: j.job, role: j.role, inputs: { ...r.inputs, issue: 'rev' } }),
    );
    return verdict(j, 'rev', out);
  };
  assert.ok('result' in check(job, plan), 'an ordinary plan');
  assert.ok('result' in check(retro, { ...plan, triage: [...triage] }), 'a retro plan');
  assert.ok(
    'result' in check(retro, { ...plan, triage: [] }),
    'a retro plan that drops everything',
  );
  assert.match(
    String((check(job, { ...plan, triage: [...triage] }) as { reason: string }).reason),
    /only a retro/,
  );
  assert.match(String((check(retro, plan) as { reason: string }).reason), /no `triage`/);
  assert.ok(
    'result' in check(retro, { ...plan, outcome: 'needs-input', questions: ['Q?'] }),
    'a retro plan may still ask first',
  );
  assert.match(
    String((check(job, { ...plan, priority: null }) as { reason: string }).reason),
    /no `priority`/,
  );
  assert.ok('result' in check(retro, { ...plan, priority: null, triage: [] }), 'a retro plan');
});

test('a retro files one issue to plan, but only comments on a retro issue or with no findings', async () => {
  const retro = Result.parse(
    JSON.parse(readFileSync(new URL('fixtures/retro.ready.json', import.meta.url), 'utf8')),
  );
  const job = {
    repo: 'gingur-root/scratch',
    issue: { number: 1, title: 'T', revision: '' },
  } as Job;
  const issue = {
    id: 1,
    number: 1,
    html_url: '',
    node_id: '',
    title: 'T',
    body: '',
    labels: [],
    created_at: '',
    user: null,
  };
  const writes: string[] = [];
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');
  vi.stubEnv('GITHUB_REPOSITORY', 'gingur-root/pipeline');
  vi.stubEnv('GITHUB_RUN_ID', '123');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    writes.push(`${init.method} ${new URL(url).pathname} ${String(init.body)}`);
    return new Response(JSON.stringify({ number: 9 }), { status: 200 });
  });
  try {
    await publishRetro(job, issue, retro);
    assert.equal(writes.length, 3);
    assert.match(writes[0]!, /^POST \/repos\/gingur-root\/scratch\/issues .*"labels":\["retro"\]/);
    assert.ok(writes[0]!.includes('https://github.com/gingur-root/pipeline/actions/runs/123'));
    assert.ok(!writes[0]!.includes('/gingur-root/scratch/actions/runs/'));
    assert.match(writes[1]!, /^POST \/repos\/gingur-root\/scratch\/issues\/9\/labels .*agent:plan/);
    assert.match(writes[2]!, /^POST \/repos\/gingur-root\/scratch\/issues\/1\/comments .*#9/);
    for (const [why, i, r] of [
      ['on a retro issue', { ...issue, labels: [{ name: 'retro' }] }, retro],
      ['no findings', issue, { ...retro, followups: [] }],
    ] as [string, typeof issue, Result][]) {
      writes.length = 0;
      await publishRetro(job, i, r);
      assert.equal(writes.length, 1, why);
      assert.match(writes[0]!, /^POST \/repos\/gingur-root\/scratch\/issues\/1\/comments /, why);
    }
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

const CARD = {
  id: 100,
  number: 1,
  html_url: '',
  node_id: 'I_1',
  title: 'Story',
  body: 'Body',
  labels: [],
  created_at: '2026-10-16T00:00:00Z',
  user: { id: OPERATOR_ID },
};

const fixtureResult = (name: string) =>
  Result.parse(JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8')));

interface FakeIssue {
  id: number;
  number: number;
  node_id: string;
  title: string;
  body: string;
  labels: string[];
  user: { id: number };
}

/**
 * GitHub for the filing tests: the issues it files are listed on the next try,
 * and the board records each Status it sets. Every request lands in `calls` as
 * `<method> <path> <body>`.
 */
function fakeGitHub(card = CARD, comments: unknown[] = [], events: unknown[] = []) {
  const user = { id: PIPELINE_BOT.id };
  const issues: FakeIssue[] = [];
  const linked = new Set<number>();
  const statuses: string[] = [];
  const calls: string[] = [];
  const board = {
    id: 'P',
    title: 'Pipeline',
    field: {
      id: 'F',
      options: ['Ask', 'Needs you', 'Building', 'P2'].map((name) => ({ id: name, name })),
    },
  };
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');
  vi.stubEnv('GITHUB_REPOSITORY', 'gingur-root/pipeline');
  vi.stubEnv('GITHUB_RUN_ID', '123');
  vi.stubEnv('GITHUB_OUTPUT', '');
  vi.stubEnv('GITHUB_STEP_SUMMARY', '');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const { pathname: path, search } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push(`${method} ${path} ${init.body === undefined ? '' : String(init.body)}`);
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    const issuesPath = `/repos/o/r/issues`;
    const cardPath = `${issuesPath}/${card.number}`;
    if (method === 'GET' && path === issuesPath) {
      assert.ok(search.includes(`since=${encodeURIComponent(card.created_at)}`), search);
      return json(search.includes('page=1') ? issues : []);
    }
    if (method === 'POST' && path === issuesPath) {
      const n = issues.length + 2;
      const issue = { id: 1000 + n, number: n, node_id: `I_${n}`, labels: [], user, ...body };
      issues.push(issue);
      return json(issue);
    }
    if (path === `${cardPath}/sub_issues`) {
      if (method === 'POST') linked.add(body.sub_issue_id);
      return json(method === 'GET' ? issues.filter((i) => linked.has(i.id)) : {});
    }
    if (method === 'GET' && path === cardPath) return json(card);
    if (method === 'GET' && path === `${cardPath}/comments`) return json(comments);
    if (method === 'GET' && path === `${cardPath}/events`) return json(events);
    if (method === 'POST' && path === '/graphql') {
      const { query, variables } = body as { query: string; variables: Record<string, string> };
      if (query.includes('organization('))
        return json({ data: { organization: { projectsV2: { nodes: [board] } } } });
      if (query.includes('addProjectV2ItemById'))
        return json({
          data: {
            addProjectV2ItemById: { item: { id: `item-${variables.content}`, current: null } },
          },
        });
      statuses.push(`${variables.item} ${variables.option}`);
      return json({ data: {} });
    }
    return json({ id: 1 });
  });
  return { issues, linked, statuses, calls };
}

function teardown() {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
}

const planJob: Job = {
  job: 'plan-1',
  role: 'plan',
  objective: '',
  repo: 'o/r',
  issue: { number: 1, title: CARD.title, revision: revision(CARD.title, CARD.body) },
  plan: null,
  source: 'abc',
  base: null,
  candidate: null,
  artifacts: [],
  operations: [],
  attemptLimit: null,
};

test('subtasks become sub-issues in Ask, and a retry files none twice', async () => {
  const github = fakeGitHub();
  const subtasks = fixtureResult('plan.story').subtasks!;
  try {
    const filed = await fileSubtasks(planJob, CARD, subtasks);
    const posts = () => github.calls.filter((c) => c.startsWith('POST /repos/o/r/issues '));
    const links = () =>
      github.calls.filter((c) => c.startsWith('POST /repos/o/r/issues/1/sub_issues '));
    assert.equal(posts().length, 2);
    // The numeric id, not the number.
    assert.deepEqual(
      links().map((c) => JSON.parse(c.split(' ').slice(2).join(' '))),
      github.issues.map((i) => ({ sub_issue_id: i.id })),
    );
    assert.deepEqual(github.statuses, ['item-I_2 Ask', 'item-I_3 Ask']);
    assert.deepEqual(filed, [
      { number: 2, title: subtasks[0]!.title, elevated: false },
      { number: 3, title: subtasks[1]!.title, elevated: true },
    ]);

    // An elevated subtask asks for the desk; nothing adds a stage label.
    const [plain, elevated] = github.issues;
    assert.deepEqual(plain!.labels, []);
    assert.deepEqual(elevated!.labels, ['needs:elevated']);
    assert.equal(
      elevated!.body,
      `${subtasks[1]!.body}\n\nPart of #1.\n\n${ELEVATED_NOTE}\n\n<!-- devkit:subtask #1 -->`,
    );
    assert.equal(plain!.body, `${subtasks[0]!.body}\n\nPart of #1.\n\n<!-- devkit:subtask #1 -->`);

    // A retry after a partial filing that never linked the second subtask.
    github.linked.delete(elevated!.id);
    github.calls.length = 0;
    github.statuses.length = 0;
    await fileSubtasks(planJob, CARD, subtasks);
    assert.equal(posts().length, 0, 'no duplicate issue');
    assert.deepEqual(links(), [
      `POST /repos/o/r/issues/1/sub_issues {"sub_issue_id":${elevated!.id}}`,
    ]);
    assert.deepEqual(github.statuses, ['item-I_3 Ask'], 'a started subtask stays where it is');
    assert.equal(github.issues.length, 2);

    // Someone else's copy of a subtask, marker and all, is never taken for it.
    github.issues.length = 0;
    github.issues.push({ ...plain!, id: 7, number: 7, user: { id: 1 } });
    github.calls.length = 0;
    await fileSubtasks(planJob, CARD, subtasks.slice(0, 1));
    assert.equal(posts().length, 1);
    assert.ok(!links().some((c) => c.includes('"sub_issue_id":7')));
  } finally {
    teardown();
  }
});

test('follow-ups are filed unlabelled in Ask, capped at 5 per stage, and once', async () => {
  const github = fakeGitHub();
  const job = { ...planJob, job: 'build-1', role: 'build' };
  const seven = fixtureResult('build.followups').followups!;
  try {
    const line = await fileFollowups(job, CARD, 'build', seven.slice(0, 2));
    assert.equal(line, 'Filed 2 follow-ups, listed below.');
    const posts = github.calls.filter((c) => c.startsWith('POST /repos/o/r/issues '));
    assert.equal(posts.length, 2);
    for (const [i, issue] of github.issues.entries()) {
      assert.ok(!('labels' in JSON.parse(posts[i]!.split(' ').slice(2).join(' '))), 'no labels');
      assert.equal(
        issue.body,
        `${seven[i]!.body}\n\nFrom #1's \`build\` stage ([run](https://github.com/gingur-root/pipeline/actions/runs/123)).\n\n<!-- devkit:followup #1 build -->`,
      );
    }
    assert.deepEqual(github.statuses, ['item-I_2 Ask', 'item-I_3 Ask']);
    const listing = github.calls.filter((c) => c.startsWith('POST /repos/o/r/issues/1/comments '));
    assert.equal(listing.length, 1);
    const comment = JSON.parse(listing[0]!.split(' ').slice(2).join(' ')).body as string;
    assert.ok(comment.startsWith(marker('followups:build')));
    assert.match(comment, /- #2 Stub follow-up 1\n- #3 Stub follow-up 2/);

    // Seven: the first five are filed, and a retry files nothing new.
    github.calls.length = 0;
    assert.equal(
      await fileFollowups(job, CARD, 'build', seven),
      'Filed 5 follow-ups, listed below. 2 more were dropped: the cap is 5 per stage.',
    );
    assert.equal(github.issues.length, 5);
    assert.deepEqual(
      github.issues.map((i) => i.title),
      seven.slice(0, 5).map((f) => f.title),
    );
    const before = github.calls.length;
    await fileFollowups(job, CARD, 'build', seven);
    assert.equal(github.issues.length, 5, 'a retry files nothing');
    assert.ok(!github.calls.slice(before).some((c) => c.startsWith('POST /repos/o/r/issues ')));
    // Another stage instance has its own cap and marker.
    await fileFollowups(job, CARD, 'review.r1', seven.slice(0, 1));
    assert.equal(github.issues.length, 6);
  } finally {
    teardown();
  }
  assert.equal(followupLine(0), '');
  assert.equal(followupLine(1), 'Filed 1 follow-up, listed below.');
  assert.equal(
    followupLine(6),
    'Filed 5 follow-ups, listed below. 1 more was dropped: the cap is 5 per stage.',
  );
});

/** Writes the job and the agent's result as the run left them, and returns publish's options. */
function staged(job: Job, result: Result): { in: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'publish-'));
  const paths = { in: join(dir, 'in'), out: join(dir, 'out') };
  mkdirSync(paths.in);
  mkdirSync(paths.out);
  writeFileSync(join(paths.in, JOB_FILE), JSON.stringify(job));
  writeFileSync(join(paths.out, PLAN_FILE), 'plan');
  writeFileSync(
    join(paths.out, RESULT_FILE),
    JSON.stringify({
      ...result,
      job: job.job,
      role: job.role,
      inputs: { ...result.inputs, issue: job.issue.revision },
    }),
  );
  return paths;
}

test('a story plan lists its subtasks and never hands off, even after a Continue', async () => {
  // A dashboard Continue armed a hand-off: the App's comment, then its agent:plan.
  const comments = [
    { body: marker('continue'), created_at: '2026-10-16T01:00:00Z', user: { id: PIPELINE_BOT.id } },
  ];
  const events = [
    {
      event: 'labeled',
      created_at: '2026-10-16T01:00:10Z',
      actor: { id: PIPELINE_BOT.id },
      label: { name: 'agent:plan' },
    },
  ];
  const github = fakeGitHub(CARD, comments, events);
  const story = fixtureResult('plan.story');
  try {
    await publish(staged(planJob, { ...story, followups: [{ title: 'Later', body: 'b' }] }));
    const posts = github.calls.filter((c) => c.startsWith('POST '));
    assert.ok(!posts.some((c) => c.includes('/labels')), 'no hand-off label');
    assert.ok(!github.calls.some((c) => c.includes('agent:build')));
    const stage = JSON.parse(
      posts
        .find((c) => c.includes(marker('plan')))!
        .split(' ')
        .slice(2)
        .join(' '),
    ).body as string;
    assert.ok(
      stage.includes(
        '**Plan: ready. This card is a story: approve and build each subtask, not this card**',
      ),
    );
    assert.ok(
      stage.includes(
        `## Subtasks\n\n- #2 ${story.subtasks![0]!.title}\n- #3 ${story.subtasks![1]!.title}, needs the WSL desk`,
      ),
    );
    assert.ok(stage.includes('Filed 1 follow-up, listed below.'));
    assert.ok(stage.endsWith('@gingur'), 'a story plan waits on the operator');
    // The stage's comment comes before its follow-up is filed.
    const order = posts.map((c) =>
      c.includes(marker('plan')) ? 'stage' : c.includes('"Later"') ? 'followup' : '',
    );
    assert.ok(order.indexOf('stage') < order.indexOf('followup'));
    assert.equal(github.linked.size, 2);

    // The control: the same Continue hands an ordinary ready plan to its build.
    github.calls.length = 0;
    await publish(staged(planJob, fixtureResult('plan.ready')));
    assert.ok(github.calls.includes('POST /repos/o/r/issues/1/labels {"labels":["agent:build"]}'));
  } finally {
    teardown();
  }
});

test('a retro files its findings as one retro issue, never as follow-ups', async () => {
  const github = fakeGitHub();
  const job = { ...planJob, job: 'retro-1', role: 'retro' };
  try {
    await publish(staged(job, fixtureResult('retro.ready')));
    const filed = github.issues;
    assert.equal(filed.length, 1);
    assert.deepEqual(filed[0]!.labels, ['retro']);
    assert.ok(!github.calls.some((c) => c.includes('devkit:followup')));
  } finally {
    teardown();
  }
});
