import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import { PIPELINE_BOT } from './constants.ts';
import { holdUntil, parseHeld } from './hold.ts';

const now = new Date('2026-10-20T14:00:00Z');

test('only a Claude usage limit holds, until its reset or the one-hour fallback', () => {
  const failure = { class: 'rate_limit', resetsAt: '2026-10-20T16:00:00Z' } as const;
  assert.equal(holdUntil(failure, 'claude', now)?.toISOString(), '2026-10-20T16:00:00.000Z');
  assert.equal(
    holdUntil({ ...failure, resetsAt: null }, 'claude', now)?.toISOString(),
    '2026-10-20T15:00:00.000Z',
  );
  for (const resetsAt of ['2026-10-20T13:00:00Z', now.toISOString()])
    assert.equal(holdUntil({ ...failure, resetsAt }, 'claude', now), null);
  for (const executor of ['codex', 'stub'] as const)
    assert.equal(holdUntil(failure, executor, now), null);
  for (const kind of ['overloaded', 'server_error', 'timeout', 'unknown'] as const)
    assert.equal(holdUntil({ class: kind, resetsAt: null }, 'claude', now), null);
});

test('held state must be a valid marker on a pipeline-bot comment', () => {
  const held = {
    state: 'held',
    until: '2026-10-20T16:00:00.000Z',
    dispatch: { stage: 'plan', repo: 'scratch', issue: 5, actor: PIPELINE_BOT.id },
  };
  const comment = {
    id: 10,
    body: `<!-- devkit:held -->\n\n<!-- devkit:held ${JSON.stringify(held)} -->`,
    user: { id: PIPELINE_BOT.id },
  };
  assert.deepEqual(parseHeld([comment]), { ...held, comment: 10 });
  const replaying = { ...held, state: 'replaying' };
  assert.deepEqual(
    parseHeld([
      {
        ...comment,
        body: `<!-- devkit:held -->\n\n<!-- devkit:held ${JSON.stringify(replaying)} -->`,
      },
    ]),
    { ...replaying, comment: 10 },
  );
  assert.equal(parseHeld([{ ...comment, body: `<!-- devkit:plan -->\n\n${comment.body}` }]), null);
  for (const user of [null, { id: 1 }, { id: 2553213 }])
    assert.equal(parseHeld([{ ...comment, user }]), null);
  for (const data of [
    '{bad',
    '{"until":"bad","dispatch":null}',
    '{"until":"2026-10-20T16:00:00Z","dispatch":{}}',
  ])
    assert.equal(
      parseHeld([{ ...comment, body: `<!-- devkit:held -->\n\n<!-- devkit:held ${data} -->` }]),
      null,
    );
  assert.equal(parseHeld([{ ...comment, body: 'Hold ended.' }]), null);
});
