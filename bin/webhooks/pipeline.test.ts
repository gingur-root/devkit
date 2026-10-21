// This is the gate for every webhook-started run: the Actions admission in
// gingur-root/pipeline admits any dispatch from the App. A loosened rule here
// would let anyone's label start an agent with the pipeline's credentials.
import assert from 'node:assert/strict';
import { test, vi } from 'vite-plus/test';

import { HELD_LABEL, OPERATOR_ID, PIPELINE_BOT } from '../agent/constants.ts';
import type { Held } from '../agent/hold.ts';
import type { Dispatch } from './pipeline.ts';
import { dispatchFor, pipelineHandler } from './pipeline.ts';

const STRANGER = 1;
const repository = { name: 'scratch', owner: { login: 'gingur-root' } };
const labeled = (label: string, sender = OPERATOR_ID, extra = {}) => ({
  id: 'd',
  event: 'issues',
  payload: {
    action: 'labeled',
    sender: { id: sender },
    repository,
    issue: { number: 5 },
    label: { name: label },
    ...extra,
  },
});
const commented = (body: string, sender = OPERATOR_ID, issue: object = { number: 5 }) => ({
  id: 'd',
  event: 'issue_comment',
  payload: {
    action: 'created',
    sender: { id: sender },
    repository,
    issue,
    comment: { id: 77, body },
  },
});
const stage = (delivery: Parameters<typeof dispatchFor>[0]) => dispatchFor(delivery)?.stage ?? null;

test("Troy's labels and commands start their stage, carrying him as the actor", () => {
  assert.deepEqual(dispatchFor(labeled('agent:plan')), {
    stage: 'plan',
    repo: 'scratch',
    issue: 5,
    actor: OPERATOR_ID,
  });
  assert.equal(stage(labeled('agent:build')), 'build');
  assert.equal(stage(labeled('agent:research')), 'research');
  assert.equal(stage(labeled('ready-for-agent')), 'loop');
  assert.equal(stage(commented('/plan please')), 'plan');
  assert.equal(stage(commented('/approve')), 'build');
});

test('the App starts only its hand-offs, and nobody else starts anything', () => {
  assert.deepEqual(dispatchFor(labeled('agent:build', PIPELINE_BOT.id))?.actor, PIPELINE_BOT.id);
  assert.equal(stage(labeled('agent:plan', PIPELINE_BOT.id)), 'plan');
  assert.equal(stage(labeled('ready-for-agent', PIPELINE_BOT.id)), null);
  assert.equal(stage(labeled('agent:research', PIPELINE_BOT.id)), null);
  assert.equal(stage(labeled('agent:filed', PIPELINE_BOT.id)), null);
  assert.equal(stage(labeled('agent:filed')), null);
  assert.equal(stage(commented('/approve', PIPELINE_BOT.id)), null);
  for (const label of ['agent:plan', 'agent:build', 'agent:research', 'ready-for-agent']) {
    assert.equal(stage(labeled(label, STRANGER)), null, label);
  }
  assert.equal(stage(commented('/approve', STRANGER)), null);
});

test('nothing starts from other events, other actions, PRs, other orgs or skipped repos', () => {
  assert.equal(stage(labeled('bug')), null);

  assert.equal(stage(commented('/revise')), null);
  assert.equal(stage(commented('please /approve')), null);
  assert.equal(stage(commented('/approve', OPERATOR_ID, { number: 5, pull_request: {} })), null);
  const unlabeled = labeled('agent:plan');
  assert.equal(
    stage({ ...unlabeled, payload: { ...unlabeled.payload, action: 'unlabeled' } }),
    null,
  );
  assert.equal(stage({ ...labeled('agent:plan'), event: 'pull_request' }), null);
  for (const repo of [
    { name: 'pipeline', owner: { login: 'gingur-root' } },
    { name: 'scratch', owner: { login: 'someone-else' } },
  ]) {
    assert.equal(
      stage(labeled('agent:plan', OPERATOR_ID, { repository: repo })),
      null,
      `${repo.owner.login}/${repo.name}`,
    );
  }
});

test("a run's 👀 goes on the comment that started it, else on the issue, and a loop tick gets none", async () => {
  assert.equal(dispatchFor(commented('/plan'))?.comment, 77);
  assert.ok(!('comment' in dispatchFor(labeled('agent:plan'))!));
  const calls: string[] = [];
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubEnv('PIPELINE_APP_KEY', '');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (new URL(url).pathname === '/search/issues') return Response.json({ items: [] });
    calls.push(`${init.method} ${new URL(url).pathname} ${String(init.body)}`);
    return new Response(null, { status: 204 });
  });
  const handle = await pipelineHandler();
  try {
    await handle(commented('/plan'));
    assert.equal(calls.length, 2);
    assert.match(
      calls[0]!,
      /^POST \/repos\/gingur-root\/pipeline\/actions\/workflows\/agents\.yml\/dispatches /,
    );
    assert.ok(!calls[0]!.includes('77'), 'the dispatch carries no comment input');
    assert.equal(
      calls[1],
      'POST /repos/gingur-root/scratch/issues/comments/77/reactions {"content":"eyes"}',
    );
    for (const sender of [OPERATOR_ID, PIPELINE_BOT.id]) {
      calls.length = 0;
      await handle(labeled('agent:plan', sender));
      assert.equal(
        calls[1],
        'POST /repos/gingur-root/scratch/issues/5/reactions {"content":"eyes"}',
      );
    }
    calls.length = 0;
    await handle(labeled('ready-for-agent'));
    assert.equal(calls.length, 1, 'only the loop dispatch');
    assert.match(calls[0]!, /\/dispatches /);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

const merged = (sender = OPERATOR_ID, extra = {}) => ({
  id: 'merge',
  event: 'pull_request',
  payload: {
    action: 'closed',
    repository: { ...repository, default_branch: 'main' },
    sender: { id: sender },
    pull_request: { number: 12, merged: true, base: { ref: 'main' } },
    ...extra,
  },
});

test('only a trusted merge starts memory, and skipped repositories cannot loop', () => {
  for (const sender of [OPERATOR_ID, PIPELINE_BOT.id])
    assert.deepEqual(dispatchFor(merged(sender)), {
      stage: 'memory',
      repo: 'scratch',
      issue: 12,
      actor: sender,
    });
  for (const extra of [
    { action: 'opened' },
    { pull_request: { number: 12, merged: false, base: { ref: 'main' } } },
    { pull_request: { number: 12, merged: true, base: { ref: 'agent/issue-1' } } },
    { repository: { ...repository, name: 'pipeline' } },
  ])
    assert.equal(dispatchFor(merged(OPERATOR_ID, extra)), null);
  assert.equal(dispatchFor(merged(STRANGER)), null);
});

test('a memory dispatch gets no receipt', async () => {
  const calls: string[] = [];
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubEnv('PIPELINE_APP_KEY', '');
  vi.stubGlobal('fetch', async (url: string) => {
    if (new URL(url).pathname === '/search/issues') return Response.json({ items: [] });
    calls.push(url);
    return new Response(null, { status: 204 });
  });
  try {
    await (
      await pipelineHandler()
    )(merged());
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /dispatches$/);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

test('infra uses the central caller for every stage', () => {
  const infra = { ...repository, name: 'infra', default_branch: 'main' };
  for (const [label, expected] of [
    ['agent:plan', 'plan'],
    ['agent:build', 'build'],
    ['agent:research', 'research'],
    ['ready-for-agent', 'loop'],
  ])
    assert.equal(stage(labeled(label!, OPERATOR_ID, { repository: infra })), expected);
  assert.equal(stage(merged(OPERATOR_ID, { repository: infra })), 'memory');
});

const reset = '2026-10-20T15:00:00.000Z';
const replay: Dispatch = {
  stage: 'plan',
  repo: 'scratch',
  issue: 5,
  actor: OPERATOR_ID,
  comment: 77,
};

function holdsFixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T14:00:00Z'));
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubEnv('PIPELINE_APP_KEY', '');
  const cards = new Map<
    string,
    {
      repo: string;
      number: number;
      labeled: boolean;
      comments: { id: number; body: string; user: { id: number; type: string } }[];
    }
  >();
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  let failure = '';
  let cleanupFails = false;
  let markerFails = false;
  const statuses: string[] = [];
  function put(
    repo: string,
    number: number,
    dispatch: Dispatch | null,
    until = reset,
    author: number = PIPELINE_BOT.id,
    state: Held['state'] = 'held',
  ) {
    const held: Held = { until, dispatch, state };
    cards.set(`${repo}#${number}`, {
      repo,
      number,
      labeled: true,
      comments: [
        {
          id: number * 100,
          body: `<!-- devkit:held -->\n\n<!-- devkit:held ${JSON.stringify(held)} -->`,
          user: { id: author, type: 'Bot' },
        },
      ],
    });
  }
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method, path, body });
    if (path === '/graphql') {
      const { query, variables } = body;
      if (query.includes('organization('))
        return Response.json({
          data: {
            organization: {
              projectsV2: {
                nodes: [
                  {
                    id: 'P',
                    title: 'Pipeline',
                    field: { id: 'F', options: [{ id: 'needs-you', name: 'Needs you' }] },
                  },
                ],
              },
            },
          },
        });
      if (query.includes('addProjectV2ItemById'))
        return Response.json({
          data: { addProjectV2ItemById: { item: { id: variables.content, current: null } } },
        });
      statuses.push(`${variables.item} ${variables.option}`);
      return Response.json({ data: {} });
    }
    const issuePath = /^\/repos\/gingur-root\/([^/]+)\/issues\/(\d+)$/.exec(path);
    if (issuePath) return Response.json({ node_id: `I_${issuePath[1]}_${issuePath[2]}` });
    if (path === '/search/issues') {
      assert.equal(new URL(url).searchParams.get('q'), 'org:gingur-root label:agent:held');
      return Response.json({
        items: [...cards.values()]
          .filter((c) => c.labeled)
          .map((c) => ({
            number: c.number,
            repository_url: `https://api.github.com/repos/gingur-root/${c.repo}`,
          })),
      });
    }
    if (path.endsWith('/dispatches'))
      return failure ? new Response(failure, { status: 503 }) : new Response(null, { status: 204 });
    if (path.endsWith('/reactions')) return Response.json({ id: 100 });
    const commentPath = /^\/repos\/gingur-root\/([^/]+)\/issues\/comments\/(\d+)$/.exec(path);
    if (commentPath) {
      if (markerFails && String(body.body).includes('"state":"replaying"')) {
        markerFails = false;
        return new Response('marker unavailable', { status: 503 });
      }
      const comment = [...cards.values()]
        .flatMap((c) => c.comments)
        .find((c) => c.id === Number(commentPath[2]))!;
      comment.body = String(body.body);
      return Response.json(comment);
    }
    const target =
      /^\/repos\/gingur-root\/([^/]+)\/issues\/(\d+)\/(comments|labels)(?:\/agent%3Aheld)?$/.exec(
        path,
      );
    assert.ok(target, `${method} ${path}`);
    const key = `${target[1]}#${target[2]}`;
    if (!cards.has(key))
      cards.set(key, { repo: target[1]!, number: Number(target[2]), labeled: false, comments: [] });
    const card = cards.get(key)!;
    if (target[3] === 'comments') {
      if (method === 'GET') return Response.json(card.comments);
      const comment = {
        id: card.number * 100,
        body: String(body.body),
        user: { id: PIPELINE_BOT.id, type: 'Bot' },
      };
      card.comments.push(comment);
      return Response.json(comment);
    }
    if (method === 'DELETE' && cleanupFails) {
      cleanupFails = false;
      return new Response('try again', { status: 503 });
    }
    card.labeled = method !== 'DELETE';
    return Response.json([]);
  });
  return {
    cards,
    calls,
    statuses,
    put,
    failDispatch(message: string) {
      failure = message;
    },
    failMarkerOnce() {
      markerFails = true;
    },
    failCleanupOnce() {
      cleanupFails = true;
    },
    dispatches() {
      return calls.filter((c) => c.path.endsWith('/dispatches'));
    },
    cleanup() {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    },
  };
}

test('a hold gates every Claude-bound stage across repos, preserves the replay and still dispatches loop', async () => {
  const f = holdsFixture();
  f.put('infra', 1, null);
  try {
    const handle = await pipelineHandler();
    const deliveries = [
      commented('/plan'),
      labeled('agent:build'),
      labeled('agent:research'),
      merged(),
    ];
    for (const delivery of deliveries) {
      f.calls.length = 0;
      await handle(delivery);
      assert.equal(f.dispatches().length, 0);
      const held =
        f.calls.find((c) => c.path.endsWith('/comments') && c.method === 'POST') ??
        f.calls.find((c) => c.method === 'PATCH');
      assert.ok(held);
      assert.match(String(held.body.body), /Held until 2026-10-20 15:00 UTC/);
      assert.ok(String(held.body.body).includes(`"stage":"${stage(delivery)}"`));
      assert.ok(
        f.calls.some(
          (c) =>
            c.method === 'POST' &&
            c.path.endsWith('/labels') &&
            JSON.stringify(c.body) === '{"labels":["agent:held"]}',
        ),
      );
      if (stage(delivery) !== 'memory')
        assert.ok(f.calls.some((c) => c.path.endsWith('/reactions')));
      if (stage(delivery) === 'plan') assert.match(String(held.body.body), /"comment":77/);
    }
    await handle(labeled('ready-for-agent'));
    assert.equal(f.dispatches().length, 1);
    assert.equal((f.dispatches()[0]!.body.inputs as Record<string, string>).stage, 'loop');
  } finally {
    f.cleanup();
  }
});

test('reset replays valid holds once, clears manual holds and refuses foreign actors or targets', async () => {
  const f = holdsFixture();
  f.put('scratch', 5, replay);
  f.put('infra', 12, { stage: 'memory', repo: 'infra', issue: 12, actor: PIPELINE_BOT.id });
  f.put('infra', 3, null);
  f.put('scratch', 6, { ...replay, issue: 6, actor: STRANGER });
  f.put('scratch', 7, { ...replay, issue: 999 });
  try {
    await pipelineHandler();
    assert.equal(f.dispatches().length, 0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    assert.equal(f.dispatches().length, 2);
    for (const call of f.dispatches()) {
      const next = call.body.inputs as Record<string, string>;
      const marked = f.calls.findIndex(
        (c) =>
          c.method === 'PATCH' &&
          c.path ===
            `/repos/gingur-root/${next.repo}/issues/comments/${Number(next.issue) * 100}` &&
          String(c.body.body).includes('"state":"replaying"'),
      );
      assert.ok(marked >= 0 && marked < f.calls.indexOf(call));
    }
    for (const c of f.cards.values()) {
      assert.equal(c.labeled, false);
      assert.match(c.comments[0]!.body, /Hold ended/);
      assert.ok(!c.comments[0]!.body.includes('<!-- devkit:held {'));
    }
    assert.match(f.cards.get('infra#3')!.comments[0]!.body, /reply `\/approve`/);
    assert.match(f.cards.get('scratch#6')!.comments[0]!.body, /replay refused/);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await pipelineHandler();
    assert.equal(f.dispatches().length, 2);
  } finally {
    f.cleanup();
  }
});

test('startup resumes expired holds, and a failed replay says why on the card', async () => {
  const f = holdsFixture();
  f.put('scratch', 5, replay, '2026-10-20T13:00:00.000Z');
  f.failDispatch('Service unavailable');
  try {
    await pipelineHandler();
    assert.equal(f.dispatches().length, 1);
    assert.equal(f.cards.get('scratch#5')!.labeled, false);
    assert.deepEqual(f.statuses, ['I_scratch_5 needs-you']);
    assert.match(
      f.cards.get('scratch#5')!.comments[0]!.body,
      /dispatch failed:.*503 Service unavailable/,
    );
  } finally {
    f.cleanup();
  }
});

test('only bot held-label deliveries raise the hold, including merged PRs, and a later reset rearms it', async () => {
  const f = holdsFixture();
  try {
    const handle = await pipelineHandler();
    f.put('scratch', 10, null);
    await handle(labeled(HELD_LABEL, STRANGER, { issue: { number: 10 } }));
    await handle(labeled('agent:plan'));
    assert.equal(f.dispatches().length, 1);
    await handle(labeled(HELD_LABEL, PIPELINE_BOT.id, { issue: { number: 10 } }));
    await handle(labeled('agent:build'));
    assert.equal(f.dispatches().length, 1);
    f.put('infra', 12, { ...replay, repo: 'infra', issue: 12 }, '2026-10-20T16:00:00.000Z');
    await handle({
      id: 'held-pr',
      event: 'pull_request',
      payload: {
        action: 'labeled',
        sender: { id: PIPELINE_BOT.id },
        repository: { ...repository, name: 'infra' },
        pull_request: { number: 12 },
        label: { name: HELD_LABEL },
      },
    });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    assert.equal(f.dispatches().length, 1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    assert.equal(f.dispatches().length, 3);
  } finally {
    f.cleanup();
  }
});

test('startup ignores held markers written by anyone except the pipeline bot', async () => {
  const f = holdsFixture();
  f.put('infra', 10, null, reset, STRANGER);
  try {
    const handle = await pipelineHandler();
    await handle(labeled('agent:plan'));
    assert.equal(f.dispatches().length, 1);
  } finally {
    f.cleanup();
  }
});

test('a cleanup failure retries the card update without dispatching it twice', async () => {
  const f = holdsFixture();
  f.put('scratch', 5, replay);
  try {
    await pipelineHandler();
    f.failCleanupOnce();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    assert.equal(f.dispatches().length, 1);
    assert.equal(f.cards.get('scratch#5')!.labeled, true);
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(f.dispatches().length, 1);
    assert.equal(f.cards.get('scratch#5')!.labeled, false);
    assert.match(f.cards.get('scratch#5')!.comments[0]!.body, /plan replay's outcome is unknown/);
    assert.deepEqual(f.statuses, ['I_scratch_5 needs-you']);
  } finally {
    f.cleanup();
  }
});

test('startup survives failed cleanup and retries without dispatching the replay twice', async () => {
  const f = holdsFixture();
  f.put('scratch', 5, replay, '2026-10-20T13:00:00.000Z');
  f.failCleanupOnce();
  try {
    const handle = await pipelineHandler();
    assert.equal(typeof handle, 'function');
    assert.equal(f.dispatches().length, 1);
    assert.match(f.cards.get('scratch#5')!.comments[0]!.body, /"state":"replaying"/);
    await vi.advanceTimersByTimeAsync(59_999);
    assert.equal(f.cards.get('scratch#5')!.labeled, true);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(f.dispatches().length, 1);
    assert.equal(f.cards.get('scratch#5')!.labeled, false);
    assert.match(
      f.cards.get('scratch#5')!.comments[0]!.body,
      /plan replay's outcome is unknown.*add `agent:plan`/,
    );
    assert.deepEqual(f.statuses, ['I_scratch_5 needs-you']);
    await pipelineHandler();
    assert.equal(f.dispatches().length, 1);
  } finally {
    f.cleanup();
  }
});

test('startup retries a failed search even before any held cards are cached', async () => {
  const f = holdsFixture();
  f.put('scratch', 5, replay, '2026-10-20T13:00:00.000Z');
  const request = globalThis.fetch;
  let searches = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (new URL(url).pathname === '/search/issues' && ++searches === 1)
      return new Response('search unavailable', { status: 503 });
    return request(url, init);
  });
  try {
    const handle = await pipelineHandler();
    assert.equal(typeof handle, 'function');
    assert.equal(f.dispatches().length, 0);
    await vi.advanceTimersByTimeAsync(59_999);
    assert.equal(searches, 1);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(f.dispatches().length, 1);
    assert.equal(f.cards.get('scratch#5')!.labeled, false);
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(searches, 2);
    assert.equal(f.dispatches().length, 1);
  } finally {
    f.cleanup();
  }
});

test('a durable replaying marker without a known dispatch never dispatches on startup', async () => {
  const f = holdsFixture();
  f.put('scratch', 5, replay, '2026-10-20T13:00:00.000Z', PIPELINE_BOT.id, 'replaying');
  try {
    await pipelineHandler();
    assert.equal(f.dispatches().length, 0);
    assert.equal(f.cards.get('scratch#5')!.labeled, false);
    assert.match(f.cards.get('scratch#5')!.comments[0]!.body, /outcome is unknown/);
    assert.deepEqual(f.statuses, ['I_scratch_5 needs-you']);
  } finally {
    f.cleanup();
  }
});

test('a failed replaying PATCH dispatches nothing and retries after one minute', async () => {
  const f = holdsFixture();
  f.put('scratch', 5, replay);
  f.failMarkerOnce();
  try {
    await pipelineHandler();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    assert.equal(f.dispatches().length, 0);
    assert.equal(f.cards.get('scratch#5')!.labeled, true);
    assert.match(f.cards.get('scratch#5')!.comments[0]!.body, /"state":"held"/);
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(f.dispatches().length, 1);
    assert.equal(f.cards.get('scratch#5')!.labeled, false);
  } finally {
    f.cleanup();
  }
});
