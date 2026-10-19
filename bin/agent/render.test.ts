// The build runs whatever plan this gate returns, so it must accept only the
// App's ready plan, unedited, for the issue as it is now, and never a story.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { test, vi } from 'vite-plus/test';

import renderCommand from '../commands/agent/render.ts';
import { OPERATOR_ID, PIPELINE_BOT } from './constants.ts';
import { CONTRACT_PREFIX, Job, marker, PLAN_END, PLAN_START, revision } from './job.ts';
import { approvedPlan, issueSnapshot, openIssues, render } from './render.ts';

const APP = 7;
const ISSUE = revision('Title', 'Body');
const PLAN = '## Criteria\n\n- **A1:** it works.';

test('render snapshots only the trusted manifest and propagates non-404 failures', async () => {
  const out = mkdtempSync(join(tmpdir(), 'render-tools-'));
  const requests: string[] = [];
  // Deliberately invalid JSON: validation belongs to agent tools, after render.
  const text = '{invalid-manifest';
  let status = 200;
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubGlobal('fetch', async (url: string) => {
    const request = new URL(url);
    if (request.pathname === '/repos/o/r/contents/.devkit/tools.json') {
      requests.push(`${request.pathname}${request.search}`);
      return new Response(
        JSON.stringify(
          status === 200
            ? { content: Buffer.from(text).toString('base64') }
            : { message: 'fixture API failure' },
        ),
        { status },
      );
    }
    const routes: Record<string, unknown> = {
      '/repos/o/r/issues/1': {
        number: 1,
        title: 'Title',
        body: 'Body',
        user: { id: OPERATOR_ID },
        labels: [],
      },
      '/repos/o/r/issues/1/comments': [comment()],
    };
    return new Response(JSON.stringify(routes[request.pathname] ?? []));
  });
  try {
    for (const role of ['plan', 'build', 'review', 'repair'] as const) {
      const source = role === 'review' || role === 'repair' ? 'cand' : 'source';
      const base = role === 'review' || role === 'repair' ? 'base' : undefined;
      const job = await render({
        repo: 'o/r',
        issue: 1,
        role,
        source,
        base,
        appId: APP,
        dispatcher: OPERATOR_ID,
        out,
      });
      assert.equal(requests.at(-1), `/repos/o/r/contents/.devkit/tools.json?ref=${base ?? source}`);
      assert.equal(readFileSync(join(out, 'tools.json'), 'utf8'), text);
      assert.equal(job.base ?? job.source, base ?? source);
    }
    assert.ok(!requests.some((request) => request.endsWith('ref=cand')));
    status = 404;
    await render({ repo: 'o/r', issue: 1, role: 'plan', source: 'source', appId: APP, out });
    assert.equal(existsSync(join(out, 'tools.json')), false);
    status = 403;
    await assert.rejects(
      render({ repo: 'o/r', issue: 1, role: 'plan', source: 'source', appId: APP, out }),
      /403.*fixture API failure/,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

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

test('a plan that edits workflow files builds like any other', async () => {
  const out = mkdtempSync(join(tmpdir(), 'render-workflows-'));
  const plan = 'Edit `.github/workflows/agent.build.yml`.';
  const writes: { method: string | undefined; path: string; body: unknown }[] = [];
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.includes('/contents/')) return new Response('{}', { status: 404 });
    const routes: Record<string, unknown> = {
      '/repos/o/r/issues/1': {
        number: 1,
        title: 'Title',
        body: 'Body',
        user: { id: OPERATOR_ID },
        labels: [],
      },
      '/repos/o/r/issues/1/comments': [comment(plan, { planRevision: revision(plan) })],
    };
    if (init.method !== 'GET')
      writes.push({
        method: init.method,
        path,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
    return new Response(JSON.stringify(init.method === 'GET' ? (routes[path] ?? []) : {}));
  });
  try {
    const options = {
      repo: 'o/r',
      issue: 1,
      source: 'abc',
      appId: APP,
      dispatcher: OPERATOR_ID,
      out,
    };
    const job = await render({ ...options, role: 'build' });
    assert.equal(job.role, 'build');
    assert.deepEqual(Job.parse(JSON.parse(readFileSync(join(out, 'job.json'), 'utf8'))), job);
    assert.equal(readFileSync(join(out, 'plan.md'), 'utf8'), `${plan}\n`);
    assert.deepEqual(writes, []);
  } finally {
    rmSync(out, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

test('only the App’s ready, unedited plan for the live issue is approved', () => {
  assert.equal(approvedPlan([comment()], APP, ISSUE, true).plan, PLAN);
  assert.equal(
    approvedPlan([comment()], APP, ISSUE, true).contract.triage,
    null,
    'a pre-triage plan',
  );
  assert.equal(
    approvedPlan([{ ...comment(), body: comment().body.replace(/\n/g, '\r\n') }], APP, ISSUE, true)
      .plan,
    PLAN,
    'CRLF from GitHub still matches',
  );
  assert.throws(() => approvedPlan([comment(PLAN, {}, 99)], APP, ISSUE, true), /No plan comment/);
  const desk = { ...comment(PLAN, {}, 99), user: { id: OPERATOR_ID } };
  assert.equal(approvedPlan([desk], APP, ISSUE, true).plan, PLAN, 'the operator’s gh published it');
  assert.throws(() => approvedPlan([comment(`${PLAN}!`)], APP, ISSUE, true), /edited/);
  assert.throws(
    () => approvedPlan([comment(PLAN, { outcome: 'needs-input' })], APP, ISSUE, true),
    /not ready/,
  );
  assert.throws(
    () => approvedPlan([comment()], APP, revision('Title', 'New body'), true),
    /changed/,
  );
});

test('a plan written without the body is refused once the issue is trusted', () => {
  assert.throws(
    () => approvedPlan([comment(PLAN, { bodySeen: false })], APP, ISSUE, true),
    /The plan was written without the issue body\. Run `agent:plan` again\./,
  );
});

test('legacy plans and plans with the same body visibility are approved', () => {
  const legacy = approvedPlan([comment()], APP, ISSUE, true);
  assert.equal(legacy.plan, PLAN);
  assert.equal(legacy.contract.bodySeen, null);
  assert.equal(approvedPlan([comment(PLAN, { bodySeen: true })], APP, ISSUE, true).plan, PLAN);
  assert.equal(approvedPlan([comment(PLAN, { bodySeen: false })], APP, ISSUE, false).plan, PLAN);
});

test('render records whether the planner can see the body, and Job.parse keeps it', async () => {
  const out = mkdtempSync(join(tmpdir(), 'render-body-'));
  let author = OPERATOR_ID;
  let labels: { name: string }[] = [];
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubGlobal('fetch', async (url: string) => {
    if (new URL(url).pathname.includes('/contents/')) return new Response('{}', { status: 404 });
    const routes: Record<string, unknown> = {
      '/repos/o/r/issues/1': {
        number: 1,
        title: 'Title',
        body: 'Body',
        user: { id: author },
        labels,
      },
    };
    return new Response(JSON.stringify(routes[new URL(url).pathname] ?? []));
  });
  try {
    for (const [id, names, bodySeen] of [
      [OPERATOR_ID, [], true],
      [1, [], false],
      [PIPELINE_BOT.id, [], false],
      [PIPELINE_BOT.id, ['agent:filed'], true],
      [1, ['agent:filed'], false],
    ] as const) {
      author = id;
      labels = names.map((name) => ({ name }));
      await render({ repo: 'o/r', issue: 1, role: 'plan', source: 'abc', appId: APP, out });
      const json = JSON.parse(readFileSync(join(out, 'job.json'), 'utf8'));
      assert.equal(json.issue.bodySeen, bodySeen);
      assert.equal(Job.parse(json).issue.bodySeen, bodySeen);
      assert.equal(readFileSync(join(out, 'issue.md'), 'utf8').includes('Body'), bodySeen);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

test('refusing a plan written without the body comments and drops the stage label', async () => {
  const out = mkdtempSync(join(tmpdir(), 'render-refuse-body-'));
  const writes: { method: string | undefined; path: string; body: unknown }[] = [];
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.includes('/contents/')) return new Response('{}', { status: 404 });
    const routes: Record<string, unknown> = {
      '/repos/o/r/issues/1': {
        number: 1,
        title: 'Title',
        body: 'Body',
        user: { id: OPERATOR_ID },
        labels: [],
      },
      '/repos/o/r/issues/1/comments': [comment(PLAN, { bodySeen: false })],
    };
    if (init.method !== 'GET') {
      writes.push({
        method: init.method,
        path,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
    }
    return new Response(JSON.stringify(init.method === 'GET' ? (routes[path] ?? []) : {}));
  });
  try {
    for (const [role, label] of [
      ['build', 'agent%3Abuild'],
      ['review', 'agent%3Abuild'],
    ] as const) {
      writes.length = 0;
      await assert.rejects(
        render({
          repo: 'o/r',
          issue: 1,
          role,
          source: 'abc',
          appId: APP,
          dispatcher: OPERATOR_ID,
          out,
        }),
        /without the issue body/,
      );
      assert.equal(writes.length, 2);
      assert.equal(writes[0]!.method, 'POST');
      assert.equal(writes[0]!.path, '/repos/o/r/issues/1/comments');
      assert.match(
        (writes[0]!.body as { body: string }).body,
        /The plan was written without the issue body\. Run `agent:plan` again\./,
      );
      assert.equal(writes[1]!.method, 'DELETE');
      assert.equal(writes[1]!.path, `/repos/o/r/issues/1/labels/${label}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
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
    if (path.includes('/contents/')) return new Response('{}', { status: 404 });
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

test("a retro plan's issue list holds only the operator's and labelled pipeline issues", () => {
  const base = { body: '', created_at: '', labels: [{ name: 'retro' }] };
  const list = openIssues([
    { ...base, number: 1, title: 'Mine', user: { id: OPERATOR_ID } },
    { ...base, number: 2, title: 'App', user: { id: 1 }, performed_via_github_app: { id: APP } },
    { ...base, number: 3, title: 'Stranger', user: { id: 1 } },
    { ...base, number: 5, title: 'Retro', user: { id: PIPELINE_BOT.id } },
    {
      ...base,
      number: 6,
      title: 'Filed',
      user: { id: PIPELINE_BOT.id },
      labels: [{ name: 'agent:filed' }],
    },
    { ...base, number: 7, title: 'Label copy', user: { id: 1 }, labels: [{ name: 'agent:filed' }] },
    { ...base, number: 4, title: 'A PR', user: { id: OPERATOR_ID }, pull_request: {} },
  ]);
  assert.equal(list, '- #1 Mine `retro`\n- #6 Filed `agent:filed`');
});

test('issue trust requires operator authorship or a labelled pipeline issue; comment trust stays unchanged', () => {
  const base = { number: 3, title: 'Card', body: 'Body', created_at: '', labels: [] };
  const notes = [
    { body: 'Bot comment', created_at: 't1', user: { id: PIPELINE_BOT.id } },
    {
      body: 'App comment',
      created_at: 't2',
      user: { id: 1 },
      performed_via_github_app: { id: APP },
    },
    { body: 'Stranger comment', created_at: 't3', user: { id: 1 } },
  ];
  const thread = '\n\n## Comment, t1\n\nBot comment\n\n## Comment, t2\n\nApp comment';
  for (const [user, labels, app, trusted] of [
    [{ id: OPERATOR_ID }, [], null, true],
    [{ id: PIPELINE_BOT.id }, [], null, false],
    [{ id: PIPELINE_BOT.id }, [{ name: 'agent:filed' }], null, true],
    [{ id: 1 }, [{ name: 'agent:filed' }], { id: APP }, false],
    [null, [{ name: 'agent:filed' }], null, false],
  ] as const) {
    const issue = { ...base, user, labels: [...labels], performed_via_github_app: app };
    const head = trusted
      ? '# Card\n\nBody'
      : '# Issue #3\n\n(Written by someone else, so left out.)';
    assert.equal(issueSnapshot(issue, notes, APP), head + thread);
    const parent = trusted
      ? '# Parent story #3: Card\n\nBody'
      : '# Parent story #3\n\n(Written by someone else, so left out.)';
    assert.equal(issueSnapshot(issue, notes, APP, issue), `${parent}\n\n---\n\n${head}${thread}`);
  }
});

test('only the operator dispatcher bypasses the history gate for build', async () => {
  const out = mkdtempSync(join(tmpdir(), 'render-dispatcher-'));
  const reads: string[] = [];
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.includes('/contents/')) return new Response('{}', { status: 404 });
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
    for (const role of ['build'] as const) {
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

test("a subtask's snapshot starts with its parent story, if the operator or the App wrote it", () => {
  const issue = {
    number: 3,
    title: 'Sub',
    body: 'Do it.',
    labels: [],
    created_at: '',
    user: { id: OPERATOR_ID },
  };
  const notes = [
    { body: 'Mine', created_at: 't1', user: { id: OPERATOR_ID } },
    { body: 'Theirs', created_at: 't2', user: { id: 1 } },
  ];
  const today = '# Sub\n\nDo it.\n\n## Comment, t1\n\nMine';
  assert.equal(issueSnapshot(issue, notes, APP), today);
  assert.equal(issueSnapshot(issue, notes, APP, null), today, 'no parent: unchanged');
  const story = { ...issue, number: 1, title: 'Story', body: 'The whole story.' };
  assert.equal(
    issueSnapshot(issue, notes, APP, story),
    `# Parent story #1: Story\n\nThe whole story.\n\n---\n\n${today}`,
  );
  assert.equal(
    issueSnapshot(issue, notes, APP, { ...story, user: { id: 1 } }),
    `# Parent story #1\n\n(Written by someone else, so left out.)\n\n---\n\n${today}`,
  );
});

test("render puts the parent story in a subtask's issue.md, and nothing when it has none", async () => {
  const out = mkdtempSync(join(tmpdir(), 'render-parent-'));
  let parent: Response | null = null;
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(url).pathname;
    if (path.includes('/contents/')) return new Response('{}', { status: 404 });
    if (path === '/repos/o/r/issues/3/parent' && parent) return parent;
    const routes: Record<string, unknown> = {
      '/repos/o/r/issues/3': {
        number: 3,
        title: 'Sub',
        body: 'Do it.',
        labels: [],
        user: { id: OPERATOR_ID },
      },
    };
    return new Response(JSON.stringify(routes[path] ?? []));
  });
  try {
    const options = {
      repo: 'o/r',
      issue: 3,
      role: 'plan',
      source: 'abc',
      appId: APP,
      out,
    } as const;
    parent = new Response(
      JSON.stringify({ number: 1, title: 'Story', body: 'S', user: { id: OPERATOR_ID } }),
    );
    await render(options);
    assert.ok(
      readFileSync(join(out, 'issue.md'), 'utf8').startsWith(
        '# Parent story #1: Story\n\nS\n\n---\n\n# Sub',
      ),
    );
    parent = new Response('{"message":"Not Found"}', { status: 404 });
    await render(options);
    assert.equal(readFileSync(join(out, 'issue.md'), 'utf8'), '# Sub\n\nDo it.\n');
  } finally {
    rmSync(out, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

test('a story never builds: it goes to Needs you and says to build each subtask', async () => {
  const writes: string[] = [];
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.includes('/contents/')) return new Response('{}', { status: 404 });
    const routes: Record<string, unknown> = {
      '/repos/o/r/issues/1': {
        number: 1,
        node_id: 'I_1',
        title: 'Title',
        body: 'Body',
        labels: [],
        user: { id: OPERATOR_ID },
        sub_issues_summary: { total: 2 },
      },
      '/repos/o/r/issues/1/comments': [comment()],
    };
    if (path === '/graphql') {
      const { query, variables } = JSON.parse(String(init.body));
      const board = {
        id: 'P',
        title: 'Pipeline',
        field: { id: 'F', options: [{ id: 'NY', name: 'Needs you' }] },
      };
      if (query.includes('organization(')) {
        return new Response(
          JSON.stringify({ data: { organization: { projectsV2: { nodes: [board] } } } }),
        );
      }
      if (query.includes('addProjectV2ItemById')) {
        return new Response(
          JSON.stringify({
            data: { addProjectV2ItemById: { item: { id: 'item', current: null } } },
          }),
        );
      }
      writes.push(`status ${variables.option}`);
      return new Response(JSON.stringify({ data: {} }));
    }
    if (init.method !== 'GET') writes.push(`${init.method} ${path} ${String(init.body ?? '')}`);
    return new Response(JSON.stringify(init.method === 'GET' ? (routes[path] ?? []) : {}));
  });
  try {
    for (const role of ['build'] as const) {
      writes.length = 0;
      await assert.rejects(
        render({
          repo: 'o/r',
          issue: 1,
          role,
          source: 'abc',
          appId: APP,
          actor: OPERATOR_ID,
          dispatcher: OPERATOR_ID,
          out: '/nonexistent',
        }),
        /This card is a story with 2 subtasks\. Build each subtask instead\./,
      );
      assert.equal(writes.length, 3, role);
      assert.match(writes[0]!, /^POST \/repos\/o\/r\/issues\/1\/comments .*story with 2 subtasks/);
      assert.equal(writes[1], `DELETE /repos/o/r/issues/1/labels/agent%3A${role} `);
      assert.equal(writes[2], 'status NY');
    }
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
