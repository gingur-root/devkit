// Reloading a thread on another device rebuilds the chat from stored lines, so
// the grouping into messages must keep every line in order.
import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import type { CoordinatorEvent } from './coordinator.ts';
import { linesToMessages, writeEvents } from './stream.ts';

test('stored lines become user messages and grouped replies, in order', () => {
  const messages = linesToMessages([
    { role: 'me', text: 'queue a bug' },
    { role: 'tool', text: 'mcp__github__file_ask' },
    { role: 'bot', text: 'Queued #9.' },
    { role: 'me', text: 'start it' },
    { role: 'bot', text: 'Started.' },
  ]);
  assert.deepEqual(
    messages.map((m) => [
      m.role,
      m.parts.map((p) =>
        p.type === 'text' ? p.text : p.type === 'data-tool' ? `tool:${p.data.name}` : p.type,
      ),
    ]),
    [
      ['user', ['queue a bug']],
      ['assistant', ['tool:mcp__github__file_ask', 'Queued #9.']],
      ['user', ['start it']],
      ['assistant', ['Started.']],
    ],
  );
});

test('a turn runs to the end after the page goes away', async () => {
  const seen: string[] = [];
  async function* turn(): AsyncGenerator<CoordinatorEvent> {
    for (const text of ['one', 'two', 'three']) {
      seen.push(text);
      yield { type: 'text', text };
    }
  }
  let writes = 0;
  const closed = {
    write() {
      if (++writes > 1) throw new Error('Controller is already closed');
    },
  };
  await writeEvents(turn(), closed);
  assert.deepEqual(seen, ['one', 'two', 'three']);
});
