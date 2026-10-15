// This is the gate for every webhook-started run: the Actions admission in
// gingur-root/pipeline admits any dispatch from the App. A loosened rule here
// would let anyone's label start an agent with the pipeline's credentials.
import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import { OPERATOR_ID, PIPELINE_BOT } from '../agent/constants.ts';
import { dispatchFor } from './pipeline.ts';

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
  payload: { action: 'created', sender: { id: sender }, repository, issue, comment: { body } },
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
  assert.equal(stage(labeled('agent:elevated')), 'elevated');
  assert.equal(stage(labeled('ready-for-agent')), 'loop');
  assert.equal(stage(commented('/plan please')), 'plan');
  assert.equal(stage(commented('/approve')), 'build');
});

test('the App starts only its hand-offs, and nobody else starts anything', () => {
  assert.deepEqual(dispatchFor(labeled('agent:build', PIPELINE_BOT.id))?.actor, PIPELINE_BOT.id);
  assert.equal(stage(labeled('agent:plan', PIPELINE_BOT.id)), 'plan');
  assert.equal(stage(labeled('agent:elevated', PIPELINE_BOT.id)), 'elevated');
  assert.equal(stage(labeled('ready-for-agent', PIPELINE_BOT.id)), null);
  assert.equal(stage(commented('/approve', PIPELINE_BOT.id)), null);
  for (const label of ['agent:plan', 'agent:build', 'agent:elevated', 'ready-for-agent']) {
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
