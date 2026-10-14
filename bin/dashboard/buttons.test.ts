// The card buttons (devkit#99): a wrong button queues a second run behind a
// live one, or acts on a card that moved since the page loaded.
import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import { STATUSES } from '../agent/constants.ts';
import { act, ActionError, liveRuns, type LiveCard } from './actions.ts';
import { buttons, type CardState, cardState, refusal } from './buttons.ts';

const idle = (column: CardState['column']): CardState => ({ column, live: false });

test('each column shows the moves docs/board.md allows', () => {
  assert.deepEqual(buttons(idle('Ask')), ['plan', 'close']);
  assert.deepEqual(buttons(idle('Needs you')), ['continue', 'close']);
  assert.deepEqual(buttons(idle('Ready')), ['merge', 'request-changes']);
  assert.deepEqual(buttons(idle('Done')), ['reopen']);
});

test('a live run shows only Stop, in every column', () => {
  for (const column of STATUSES) assert.deepEqual(buttons({ column, live: true }), ['stop']);
});

test('a card is live in Planning or Building, or while it carries a stage label', () => {
  const issue = { open: true, status: 'Ask' as const, labels: [] };
  assert.equal(cardState(issue).live, false);
  assert.equal(cardState({ ...issue, labels: ['agent:plan'] }).live, true);
  assert.equal(cardState({ ...issue, status: 'Planning' }).live, true);
  assert.equal(cardState({ ...issue, status: 'Building' }).live, true);
  assert.deepEqual(cardState({ ...issue, open: false, labels: ['agent:build'] }), idle('Done'));
  assert.equal(cardState({ ...issue, status: null }).column, 'Ask');
});

test('a press is refused when the card moved, its run changed, or the move is not allowed', () => {
  assert.equal(refusal(idle('Needs you'), idle('Needs you'), 'continue'), null);
  assert.match(refusal(idle('Needs you'), idle('Ready'), 'continue') ?? '', /changed/);
  assert.match(
    refusal(idle('Needs you'), { column: 'Needs you', live: true }, 'continue') ?? '',
    /changed/,
  );
  assert.match(refusal(idle('Ask'), idle('Ask'), 'continue') ?? '', /not a move/);
  assert.match(
    refusal({ column: 'Planning', live: true }, { column: 'Planning', live: true }, 'close') ?? '',
    /not a move/,
  );
});

test('the server answers 409 on a stale card and writes nothing', async () => {
  const now: LiveCard = { nodeId: 'I_1', title: 't', state: { column: 'Planning', live: true } };
  await assert.rejects(
    act(
      {
        repo: 'scratch',
        number: 1,
        action: 'continue',
        seen: idle('Needs you'),
        note: '',
        elevated: false,
      },
      undefined,
      async () => now,
    ),
    (error: unknown) => error instanceof ActionError && error.status === 409,
  );
});

test('Merge answers 501 until the merge token exists', async () => {
  const ready: LiveCard = { nodeId: 'I_1', title: 't', state: idle('Ready') };
  const req = {
    repo: 'scratch',
    number: 1,
    action: 'merge',
    seen: idle('Ready'),
    note: '',
    elevated: false,
  } as const;
  await assert.rejects(
    act(req, undefined, async () => ready),
    (error: unknown) => error instanceof ActionError && error.status === 501,
  );
});

test('Stop finds only the issue’s own runs that are still going', () => {
  const run = { id: 1, status: 'in_progress', event: 'issues', display_title: 'Fix it' };
  const runs = [
    run,
    { ...run, id: 2, status: 'completed' },
    { ...run, id: 3, display_title: 'Other' },
    { ...run, id: 4, event: 'push' },
    { ...run, id: 5, status: 'queued', event: 'issue_comment' },
  ];
  assert.deepEqual(
    liveRuns(runs, 'Fix it').map((r) => r.id),
    [1, 5],
  );
});
