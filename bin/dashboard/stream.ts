// The coordinator's events in the AI SDK's UI message format, so the page can
// use `useChat` (devkit#91). Text is sent as whole parts; tool calls and routes
// are data parts the page draws itself.
import type { UIMessage, UIMessageStreamWriter } from 'ai';

import { KEEP_ALIVE_MS } from './constants.ts';
import type { CoordinatorEvent } from './coordinator.ts';
import type { Line } from './store.ts';

export type DashboardMessage = UIMessage<
  never,
  { tool: { name: string }; route: { repo: string; number: number }; ping: Record<string, never> }
>;

// The SDK's writer ignores writes after the page goes away, so the turn still
// runs to the end and its lines are stored.
export async function writeEvents(
  events: AsyncIterable<CoordinatorEvent>,
  writer: UIMessageStreamWriter<DashboardMessage>,
  keepAliveMs = KEEP_ALIVE_MS,
): Promise<void> {
  let part = 0;
  // Like /api/events, keep quiet turns below Cloudflare's idle cutoff.
  const keepAlive = setInterval(
    () => writer.write({ type: 'data-ping', data: {}, transient: true }),
    keepAliveMs,
  );
  try {
    for await (const event of events) {
      if (event.type === 'text') {
        const id = `t${part++}`;
        writer.write({ type: 'text-start', id });
        writer.write({ type: 'text-delta', id, delta: event.text });
        writer.write({ type: 'text-end', id });
      } else if (event.type === 'tool') {
        writer.write({ type: 'data-tool', data: { name: event.name } });
      } else if (event.type === 'route') {
        writer.write({ type: 'data-route', data: { repo: event.repo, number: event.number } });
      }
    }
  } finally {
    clearInterval(keepAlive);
  }
}

/** A thread's stored lines as chat messages: Troy's lines alone, the rest grouped into replies. */
export function linesToMessages(lines: Line[]): DashboardMessage[] {
  const messages: DashboardMessage[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.role === 'me') {
      messages.push({ id: `l${index}`, role: 'user', parts: [{ type: 'text', text: line.text }] });
      continue;
    }
    let reply = messages.at(-1);
    if (reply?.role !== 'assistant') {
      reply = { id: `l${index}`, role: 'assistant', parts: [] };
      messages.push(reply);
    }
    reply.parts.push(
      line.role === 'bot'
        ? { type: 'text', text: line.text }
        : { type: 'data-tool', data: { name: line.text } },
    );
  }
  return messages;
}
