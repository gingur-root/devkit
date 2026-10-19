// The card buttons (devkit#99): a wrong button queues a second run behind a
// live one, or acts on a card that moved since the page loaded.
import assert from 'node:assert/strict';
import { test, vi } from 'vite-plus/test';

import { STATUSES } from '../agent/constants.ts';
import { act, ActionError, dispatchedRuns, liveRuns, type LiveCard } from './actions.ts';
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

test('Stop finds central dispatches by their final issue token', () => {
  const run = {
    id: 1,
    status: 'in_progress',
    event: 'workflow_dispatch',
    display_title: 'build scratch#1',
  };
  const runs = [
    run,
    { ...run, id: 2, status: 'queued', display_title: 'plan gingur-root/scratch#1' },
    { ...run, id: 3, status: 'completed' },
    { ...run, id: 4, event: 'push' },
    { ...run, id: 5, display_title: 'build scratch#12' },
    { ...run, id: 6, display_title: 'build otherscratch#1' },
    { ...run, id: 7, display_title: 'build scratch#1 x' },
    { ...run, id: 8, display_title: 'build other-org/scratch#1' },
  ];
  assert.deepEqual(
    dispatchedRuns(runs, 'scratch', 1).map((r) => r.id),
    [1, 2],
  );
});

test('Stop cancels each run in its hosting repo and refuses only when both lists are empty', async () => {
  const run = { id: 11, status: 'in_progress', event: 'issues', display_title: 'Fix it' };
  const central = { ...run, id: 22, event: 'workflow_dispatch', display_title: 'build scratch#1' };
  const card: LiveCard = {
    nodeId: 'I_1',
    title: 'Fix it',
    state: { column: 'Building', live: true },
  };
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubEnv('PIPELINE_APP_KEY', '');
  try {
    for (const [localRuns, centralRuns, expected] of [
      [[], [central], ['/repos/gingur-root/pipeline/actions/runs/22/cancel']],
      [[run], [], ['/repos/gingur-root/scratch/actions/runs/11/cancel']],
      [
        [run],
        [central],
        [
          '/repos/gingur-root/scratch/actions/runs/11/cancel',
          '/repos/gingur-root/pipeline/actions/runs/22/cancel',
        ],
      ],
      [[], [], []],
    ] as const) {
      const writes: string[] = [];
      const reads: string[] = [];
      vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        if (init.method === 'GET') {
          reads.push(new URL(url).pathname + new URL(url).search);
          const workflow_runs =
            path === '/repos/gingur-root/pipeline/actions/runs' ? centralRuns : localRuns;
          return new Response(JSON.stringify({ workflow_runs }));
        }
        writes.push(path);
        return new Response(null, { status: 204 });
      });
      const result = act(
        { repo: 'scratch', number: 1, action: 'stop', seen: card.state, note: '' },
        undefined,
        async () => card,
      );
      if (expected.length) await result;
      else
        await assert.rejects(
          result,
          (error: unknown) =>
            error instanceof ActionError &&
            error.status === 409 &&
            error.message === 'No live run to stop.',
        );
      assert.deepEqual(writes, expected);
      assert.deepEqual(reads.sort(), [
        '/repos/gingur-root/pipeline/actions/runs?event=workflow_dispatch&per_page=100',
        '/repos/gingur-root/scratch/actions/runs?per_page=100',
      ]);
    }
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
