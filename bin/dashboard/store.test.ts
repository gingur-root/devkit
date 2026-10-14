// The store is the dashboard's only write. One failed save must not stop every
// later one, or a disk hiccup leaves the chat dead until a restart.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vite-plus/test';

import { createStore } from './store.ts';

test('a save that fails does not block the next one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-'));
  const store = createStore(join(dir, 'state.json'));
  chmodSync(dir, 0o500);
  await assert.rejects(
    store.update('home', (t) => void t.lines.push({ role: 'me', text: 'lost' })),
  );
  chmodSync(dir, 0o700);
  await store.update('home', (t) => void t.lines.push({ role: 'me', text: 'kept' }));
  assert.match(readFileSync(join(dir, 'state.json'), 'utf8'), /kept/);
});
