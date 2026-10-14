// The status line is what Troy reads to know whether a thread waits on him.
import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import { statusLine } from './issue.ts';

test('the status line says done, waiting on you, or column and running stage', () => {
  assert.equal(
    statusLine({ state: 'closed', status: 'Building', labels: ['agent:build'] }),
    'Done',
  );
  assert.equal(statusLine({ state: 'open', status: 'Needs you', labels: [] }), 'Waiting on you');
  assert.equal(
    statusLine({ state: 'open', status: 'Planning', labels: ['agent:plan'] }),
    'Planning · agent:plan running',
  );
  assert.equal(
    statusLine({ state: 'open', status: null, labels: ['ready-for-agent'] }),
    'Not on the board',
  );
});
