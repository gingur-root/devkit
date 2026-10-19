// This is the gate for every webhook-started run: the Actions admission in
// gingur-root/pipeline admits any dispatch from the App. A loosened rule here
// would let anyone's label start an agent with the pipeline's credentials.
import assert from 'node:assert/strict';
import { test, vi } from 'vite-plus/test';

import { OPERATOR_ID, PIPELINE_BOT } from '../agent/constants.ts';
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
  assert.equal(stage(labeled('ready-for-agent')), 'loop');
  assert.equal(stage(commented('/plan please')), 'plan');
  assert.equal(stage(commented('/approve')), 'build');
});

test('the App starts only its hand-offs, and nobody else starts anything', () => {
  assert.deepEqual(dispatchFor(labeled('agent:build', PIPELINE_BOT.id))?.actor, PIPELINE_BOT.id);
  assert.equal(stage(labeled('agent:plan', PIPELINE_BOT.id)), 'plan');
  assert.equal(stage(labeled('ready-for-agent', PIPELINE_BOT.id)), null);
  assert.equal(stage(labeled('agent:filed', PIPELINE_BOT.id)), null);
  assert.equal(stage(labeled('agent:filed')), null);
  assert.equal(stage(commented('/approve', PIPELINE_BOT.id)), null);
  for (const label of ['agent:plan', 'agent:build', 'ready-for-agent']) {
    assert.equal(stage(labeled(label, STRANGER)), null, label);
  }
  assert.equal(stage(commented('/approve', STRANGER)), null);
});

test('nothing starts from other events, other actions, PRs, other orgs or skipped repos', () => {
  assert.equal(stage(labeled('bug')), null);
  assert.equal(stage(labeled('agent:research')), null);
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
    { name: 'infra', owner: { login: 'gingur-root' } },
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
    calls.push(`${init.method} ${new URL(url).pathname} ${String(init.body)}`);
    return new Response(null, { status: 204 });
  });
  const handle = pipelineHandler();
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
