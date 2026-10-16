// A run's receipt is the operator's only sign on the issue that an agent picked
// it up and how it ended (devkit#148). A wrong mapping or a stacked reaction
// reads as the wrong outcome, and a failed reaction must never fail the run.
import assert from 'node:assert/strict';
import { test, vi } from 'vite-plus/test';

import { OPERATOR_ID, PIPELINE_BOT } from './constants.ts';
import { RECEIPTS, react, receiptFor, settle, swap } from './reactions.ts';

test('each end state maps to its reaction, and a stage with a later stage after it leaves none', () => {
  assert.deepEqual(RECEIPTS, { done: 'rocket', question: 'confused', failed: '-1' });
  for (const [role, status, stopped, planReady, expected] of [
    ['plan', 'Needs you', false, true, 'done'],
    ['plan', 'Needs you', false, false, 'question'],
    ['plan', 'Building', false, true, 'done'],
    ['plan', 'Needs you', true, false, 'failed'],
    ['build', 'Needs you', true, false, 'failed'],
    ['build', 'Ready', false, false, null],
    ['repair', 'Building', false, false, null],
    ['review', 'Building', false, false, null],
    ['review', 'Ready', false, false, 'done'],
    ['review', 'Needs you', false, false, 'question'],
    ['elevated', 'Ready', false, false, 'done'],
    ['build', 'Done', false, false, 'done'],
    ['retro', 'Needs you', false, false, null],
  ] as const) {
    assert.equal(
      receiptFor(role, status, stopped, planReady),
      expected,
      `${role} ${status}${stopped ? ' stopped' : ''}`,
    );
  }
});

test("a swap removes only the writer's own reactions, and only when its eyes is there", () => {
  const own = PIPELINE_BOT.id;
  const reactions = [
    { id: 1, content: 'eyes', user: { id: own } },
    { id: 2, content: 'rocket', user: { id: own } },
    { id: 3, content: 'eyes', user: { id: OPERATOR_ID } },
    { id: 4, content: 'heart', user: { id: OPERATOR_ID } },
    { id: 5, content: 'heart', user: null },
  ];
  assert.deepEqual(swap(reactions, own), { remove: [1, 2], add: true });
  assert.deepEqual(swap(reactions.slice(1), own), { remove: [], add: false });
});

test('settle swaps the eyes on the issue and on command comments for one end reaction', async () => {
  const calls: string[] = [];
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path}${init.body ? ` ${String(init.body)}` : ''}`);
    const own = { id: PIPELINE_BOT.id };
    const body =
      path === '/repos/o/r/issues/5/comments'
        ? [
            { id: 70, body: '/plan', user: { id: OPERATOR_ID }, reactions: { eyes: 1 } },
            { id: 71, body: '/approve', user: { id: OPERATOR_ID }, reactions: { eyes: 0 } },
            { id: 72, body: 'thanks', user: { id: OPERATOR_ID }, reactions: { eyes: 1 } },
          ]
        : path === '/repos/o/r/issues/5/reactions'
          ? [{ id: 1, content: 'heart', user: { id: OPERATOR_ID } }]
          : path === '/repos/o/r/issues/comments/70/reactions'
            ? [{ id: 2, content: 'eyes', user: own }]
            : {};
    return new Response(init.method === 'DELETE' ? null : JSON.stringify(body), {
      status: init.method === 'DELETE' ? 204 : 200,
    });
  });
  try {
    await settle('o/r', 5, 'done');
    assert.deepEqual(
      calls.filter((c) => !c.startsWith('GET')),
      [
        'DELETE /repos/o/r/issues/comments/70/reactions/2',
        'POST /repos/o/r/issues/comments/70/reactions {"content":"rocket"}',
      ],
    );
    assert.ok(!calls.some((c) => /comments\/7[12]\//.test(c)), 'only command comments with eyes');
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

test('a failed reaction never throws: it logs a warning', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }));
  try {
    await react('o/r', 5, 70);
    await react('o/r', 5);
    await settle('o/r', 5, 'failed');
    const warnings = log.mock.calls.map(([line]) => String(line));
    assert.equal(warnings.length, 3);
    for (const line of warnings) assert.match(line, /^::warning::.*500 boom/);
  } finally {
    log.mockRestore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
