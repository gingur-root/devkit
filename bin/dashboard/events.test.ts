// A delivery mapped to the wrong event leaves the page stale with no error.
import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import { BOARD_EVENT } from './constants.ts';
import { webhookBoard } from './events.ts';

test('a webhook delivery names its card or the board, and reaches only current listeners', () => {
  const { source, handle } = webhookBoard();
  const seen: unknown[] = [];
  const unsubscribe = source.subscribe((event) => seen.push(event));
  const issue = { repository: { name: 'scratch' }, issue: { number: 4 } };
  handle({ id: '1', event: 'issues', payload: { action: 'labeled', ...issue } });
  handle({ id: '2', event: 'issue_comment', payload: { action: 'created', ...issue } });
  handle({ id: '3', event: 'projects_v2_item', payload: { action: 'edited' } });
  handle({ id: '4', event: 'workflow_run', payload: { action: 'completed' } });
  const card = { type: BOARD_EVENT.cardChanged, repo: 'scratch', number: 4 };
  assert.deepEqual(seen, [card, card, { type: BOARD_EVENT.boardChanged }]);
  unsubscribe();
  handle({ id: '5', event: 'issues', payload: issue });
  assert.equal(seen.length, 3);
});
