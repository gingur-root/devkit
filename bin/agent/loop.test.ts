// The loop's one judgement: what a tick does to each card. It acts as the App,
// so a wrong call here starts plans nobody asked for or strands a card.
import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import { OPERATOR_ID, READY_LABEL, type Status } from './constants.ts';
import { type Card, decide } from './loop.ts';

function card(number: number, status: Status | null, labels = [READY_LABEL]): Card {
  return { number, nodeId: `I_${number}`, status, labels, readyBy: OPERATOR_ID };
}

const failed = { start: { result: 'success' }, plan: { result: 'cancelled' } };

test('starts the oldest ready card when nothing is planning', () => {
  const { actions } = decide([card(9, 'Ask'), card(4, 'Ask'), card(2, 'Needs you')]);
  assert.deepEqual(actions, [{ kind: 'plan', issue: 4 }]);
});

test('a ready card the board has not added yet still counts', () => {
  assert.deepEqual(decide([card(3, null)]).actions, [{ kind: 'plan', issue: 3 }]);
});

test('starts nothing while a card is planning or carries agent:plan', () => {
  assert.deepEqual(decide([card(1, 'Planning'), card(2, 'Ask')]).actions, []);
  assert.deepEqual(
    decide([card(1, 'Ask', [READY_LABEL, 'agent:plan']), card(2, 'Ask')]).actions,
    [],
  );
});

test('a rerun after the plan started does nothing', () => {
  const before = [card(4, 'Ask'), card(5, 'Ask')];
  assert.deepEqual(decide(before).actions, [{ kind: 'plan', issue: 4 }]);
  assert.deepEqual(
    decide([card(4, 'Ask', [READY_LABEL, 'agent:plan']), card(5, 'Ask')]).actions,
    [],
  );
});

test('skips a card someone other than the operator put on the board', () => {
  const { actions, skipped } = decide([{ ...card(1, 'Ask'), readyBy: 1 }, card(2, 'Ask')]);
  assert.deepEqual(actions, [{ kind: 'plan', issue: 2 }]);
  assert.match(skipped.join(), /#1/);
  assert.deepEqual(decide([{ ...card(1, 'Ask'), readyBy: null }]).actions, []);
});

test('a card the run left in Planning or Building goes to Needs you, then the next plan starts', () => {
  const { actions } = decide([card(1, 'Planning'), card(2, 'Ask')], {
    role: 'plan',
    issue: 1,
    jobs: failed,
  });
  assert.deepEqual(actions, [
    {
      kind: 'stalled',
      issue: 1,
      role: 'plan',
      stage: 'plan',
      reason: 'the run ended (`cancelled`) before it published',
    },
    { kind: 'plan', issue: 2 },
  ]);
  const build = decide([card(1, 'Building', [])], { role: 'build', issue: 1, jobs: {} });
  assert.deepEqual(
    build.actions.map((a) => a.kind),
    ['stalled'],
  );
});

test('a run that died before setting Status still frees the repo', () => {
  const { actions } = decide([card(1, 'Ask', [READY_LABEL, 'agent:plan']), card(2, 'Ask')], {
    role: 'plan',
    issue: 1,
    jobs: { start: { result: 'failure' } },
  });
  assert.deepEqual(
    actions.map((a) => [a.kind, a.issue]),
    [
      ['stalled', 1],
      ['plan', 2],
    ],
  );
});

test('a plan that handed off to its build leaves the card in Building', () => {
  const handedOff = card(1, 'Building', ['agent:build']);
  assert.deepEqual(decide([handedOff], { role: 'plan', issue: 1, jobs: {} }).actions, []);
});

test('a run that published leaves its card alone', () => {
  assert.deepEqual(
    decide([card(1, 'Needs you')], { role: 'plan', issue: 1, jobs: failed }).actions,
    [],
  );
  assert.deepEqual(
    decide([card(1, 'Ready', [])], { role: 'build', issue: 1, jobs: {} }).actions,
    [],
  );
});

test('never starts a card past Ask', () => {
  for (const status of ['Needs you', 'Building', 'Ready', 'Done'] as const)
    assert.deepEqual(decide([card(1, status)]).actions, []);
  assert.deepEqual(decide([card(1, 'Ask', [])]).actions, []);
});

test('research left in Planning or carrying its label goes to Needs you', () => {
  for (const left of [card(1, 'Planning', []), card(1, 'Ask', ['agent:research'])]) {
    assert.deepEqual(
      decide([left], { role: 'research', issue: 1, jobs: { research: { result: 'failure' } } })
        .actions,
      [
        {
          kind: 'stalled',
          issue: 1,
          role: 'research',
          stage: 'research',
          reason: 'the run ended (`failure`) before it published',
        },
      ],
    );
  }
});
