// Reloading a thread on another device rebuilds the chat from stored lines, so
// the grouping into messages must keep every line in order.
import assert from 'node:assert/strict';
import { createUIMessageStream, readUIMessageStream, type UIMessageChunk } from 'ai';
import { test, vi } from 'vite-plus/test';

import type { CoordinatorEvent } from './coordinator.ts';
import { type DashboardMessage, linesToMessages, writeEvents } from './stream.ts';

test('a quiet turn sends transient pings and keeps the note, tool and answer in order', async () => {
  async function* events(): AsyncGenerator<CoordinatorEvent> {
    yield { type: 'text', text: 'note' };
    yield { type: 'tool', name: 'mcp__github__read_issue' };
    await new Promise((resolve) => setTimeout(resolve, 60));
    yield { type: 'text', text: 'answer' };
  }
  const stream = createUIMessageStream<DashboardMessage>({
    execute: ({ writer }) => writeEvents(events(), writer, 10),
  });
  const [raw, decoded] = stream.tee();
  const [chunks, messages] = await Promise.all([
    Array.fromAsync(raw),
    Array.fromAsync(readUIMessageStream<DashboardMessage>({ stream: decoded })),
  ]);
  const tool = chunks.findIndex((chunk) => chunk.type === 'data-tool');
  const answer = chunks.findIndex((chunk) => chunk.type === 'text-start' && chunk.id === 't1');
  const pings = chunks.slice(tool + 1, answer).filter((chunk) => chunk.type === 'data-ping');
  assert.ok(pings.length > 0, 'the quiet gap must contain keep-alives');
  for (const ping of pings)
    assert.deepEqual(ping, { type: 'data-ping', data: {}, transient: true });
  assert.deepEqual(messages.at(-1)?.parts, [
    { type: 'text', text: 'note', state: 'done', providerMetadata: undefined },
    { type: 'data-tool', data: { name: 'mcp__github__read_issue' } },
    { type: 'text', text: 'answer', state: 'done', providerMetadata: undefined },
  ]);
});

for (const throws of [false, true]) {
  test(`keep-alives stop when the event generator ${throws ? 'throws' : 'ends'}`, async () => {
    vi.useFakeTimers();
    try {
      const error = new Error('coordinator failed');
      async function* events(): AsyncGenerator<CoordinatorEvent> {
        yield { type: 'text', text: 'note' };
        await new Promise((resolve) => setTimeout(resolve, 60));
        if (throws) throw error;
      }
      let failure: unknown;
      const settled = Promise.withResolvers<void>();
      const chunks: UIMessageChunk[] = [];
      const stream = createUIMessageStream<DashboardMessage>({
        execute: async ({ writer }) => {
          try {
            await writeEvents(events(), writer, 10);
          } catch (caught) {
            failure = caught;
          }
          settled.resolve();
          // Keep the writer open to detect any ping sent after writeEvents settles.
          await new Promise((resolve) => setTimeout(resolve, 40));
        },
      });
      const reading = (async () => {
        for await (const chunk of stream) chunks.push(chunk);
      })();
      await vi.advanceTimersByTimeAsync(60);
      await settled.promise;
      assert.equal(failure, throws ? error : undefined);
      assert.ok(chunks.some((chunk) => chunk.type === 'data-ping'));
      const count = chunks.length;
      await vi.advanceTimersByTimeAsync(40);
      await reading;
      assert.equal(chunks.length, count, 'no chunks after writeEvents settles');
      assert.equal(vi.getTimerCount(), 0, 'no interval left running');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
}

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
