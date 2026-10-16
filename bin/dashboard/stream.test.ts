// Reloading a thread on another device rebuilds the chat from stored lines, so
// the grouping into messages must keep every line in order.
import assert from 'node:assert/strict';
import { createUIMessageStream, readUIMessageStream, type UIMessageChunk } from 'ai';
import { test, vi } from 'vite-plus/test';

import type { CoordinatorEvent } from './coordinator.ts';
import { type DashboardMessage, linesToMessages, writeEvents } from './stream.ts';

for (const interval of [undefined, 10]) {
  test(`a quiet turn sends transient pings and keeps the final answer (${interval === undefined ? '25 s default' : '10 ms'})`, async () => {
    vi.useFakeTimers();
    try {
      const gap = interval === undefined ? 120_000 : 65;
      async function* events(): AsyncGenerator<CoordinatorEvent> {
        yield { type: 'text', text: 'note' };
        yield { type: 'tool', name: 'mcp__github__read_issue' };
        await new Promise((resolve) => setTimeout(resolve, gap));
        yield { type: 'text', text: 'answer' };
      }
      const stream = createUIMessageStream<DashboardMessage>({
        execute: ({ writer }) => writeEvents(events(), writer, interval),
      });
      const [raw, messages] = stream.tee();
      const chunks: UIMessageChunk[] = [];
      const readChunks = (async () => {
        for await (const chunk of raw) chunks.push(chunk);
      })();
      let last: DashboardMessage | undefined;
      const readMessages = (async () => {
        for await (const message of readUIMessageStream<DashboardMessage>({ stream: messages })) {
          last = message;
        }
      })();

      await vi.advanceTimersByTimeAsync(gap);
      await Promise.all([readChunks, readMessages]);
      const pings = chunks.filter((chunk) => chunk.type === 'data-ping');
      assert.equal(pings.length, interval === undefined ? 4 : 6);
      for (const ping of pings) {
        assert.deepEqual(ping, { type: 'data-ping', data: {}, transient: true });
      }
      const tool = chunks.findIndex((chunk) => chunk.type === 'data-tool');
      const answer = chunks.findIndex(
        (chunk) => chunk.type === 'text-delta' && chunk.delta === 'answer',
      );
      assert.ok(chunks.slice(tool + 1, answer).some((chunk) => chunk.type === 'data-ping'));
      assert.deepEqual(last?.parts, [
        { type: 'text', text: 'note', state: 'done', providerMetadata: undefined },
        { type: 'data-tool', data: { name: 'mcp__github__read_issue' } },
        { type: 'text', text: 'answer', state: 'done', providerMetadata: undefined },
      ]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
}

for (const fails of [false, true]) {
  test(`pings stop when the turn ${fails ? 'throws' : 'ends'}`, async () => {
    vi.useFakeTimers();
    try {
      const failure = new Error('coordinator failed');
      async function* events(): AsyncGenerator<CoordinatorEvent> {
        yield { type: 'text', text: 'note' };
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (fails) throw failure;
      }
      let completed = false;
      const stream = createUIMessageStream<DashboardMessage>({
        execute: async ({ writer }) => {
          const task = writeEvents(events(), writer, 10);
          if (fails) await assert.rejects(task, failure);
          else await task;
          completed = true;
          // Keep the writer open so a leaked interval would still send pings.
          await new Promise((resolve) => setTimeout(resolve, 40));
        },
      });
      const chunks: UIMessageChunk[] = [];
      const readChunks = (async () => {
        for await (const chunk of stream) chunks.push(chunk);
      })();
      await vi.advanceTimersByTimeAsync(30);
      const pings = chunks.filter((chunk) => chunk.type === 'data-ping').length;
      await vi.advanceTimersByTimeAsync(40);
      await readChunks;

      assert.equal(completed, true);
      assert.equal(pings, 2);
      assert.equal(chunks.filter((chunk) => chunk.type === 'data-ping').length, pings);
      assert.equal(vi.getTimerCount(), 0);
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
