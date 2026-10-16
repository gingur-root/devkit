// The events inbox: one ordered log of what happened, whatever sent it.
// GitHub deliveries land through the receiver's handler; any other source
// posts to /events/<source> with the inbox token. Readers page through it
// with /events?since=<id>, so a subscriber only keeps its last id.
import { createHash, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { WebhookHandler } from './receiver.ts';

export const EVENTS_PATH = '/events';
export const GITHUB_SOURCE = 'github';
const MAX_EVENTS = 10_000;
// Small, so a full log stays well under 100 MB in memory.
const MAX_POST = 8 * 1024;
const PAGE = 100;
const SOURCE = /^[a-z0-9-]{1,32}$/;

const PostedEvent = z.object({
  type: z.string().min(1).max(64),
  data: z.unknown().optional(),
});

export interface InboxEvent {
  id: number;
  at: string;
  source: string;
  type: string;
  data?: unknown;
}

/**
 * The log, kept in memory and appended to `file` when given. Ids only grow,
 * so a restart continues where it left off.
 */
export function createInbox(file?: string, max = MAX_EVENTS) {
  let events: InboxEvent[] =
    file && existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .flatMap((line) => {
            // A crash mid-append leaves a cut line; skipping it beats a dashboard that won't start.
            try {
              return [JSON.parse(line) as InboxEvent];
            } catch {
              return [];
            }
          })
          .slice(-max)
      : [];
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    // Compacted at start, so the file stays near `max` lines across restarts.
    writeFileSync(file, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }
  // shortcut: the file grows past `max` until the next restart; compact while running if restarts get rare.
  let next = (events.at(-1)?.id ?? 0) + 1;
  return {
    add(source: string, type: string, data?: unknown): InboxEvent {
      const event: InboxEvent = { id: next++, at: new Date().toISOString(), source, type, data };
      events.push(event);
      if (events.length > max) events = events.slice(-max);
      // A failed write costs one event's durability; throwing here would kill the dashboard.
      if (file) {
        try {
          appendFileSync(file, `${JSON.stringify(event)}\n`);
        } catch (error) {
          console.error('inbox: could not save event', error);
        }
      }
      return event;
    },
    /** Events after `since`, oldest first, at most one page. */
    since(since: number, source?: string, limit = PAGE): InboxEvent[] {
      return events.filter((e) => e.id > since && (!source || e.source === source)).slice(0, limit);
    },
  };
}
export type Inbox = ReturnType<typeof createInbox>;

interface GithubPayload {
  action?: string;
  sender?: { login?: string };
  repository?: { name?: string };
  issue?: { number?: number; title?: string; html_url?: string };
  pull_request?: { number?: number; title?: string; html_url?: string };
}

/** The receiver's handler: every GitHub delivery, as a short summary rather than its payload. */
export function githubInboxHandler(inbox: Inbox): WebhookHandler {
  return ({ id, event, payload }) => {
    const { action, sender, repository, issue, pull_request } = payload as GithubPayload;
    const item = issue ?? pull_request;
    inbox.add(GITHUB_SOURCE, action ? `${event}.${action}` : event, {
      repo: repository?.name,
      number: item?.number,
      title: item?.title,
      url: item?.html_url,
      sender: sender?.login,
      // A redelivery after a failed handler lands twice; readers can drop repeats by this id.
      delivery: id,
    });
  };
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Whether the request carries `Authorization: Bearer <token>`. Hashed first, so the compare is constant time. */
export function hasToken(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  return timingSafeEqual(digest(header), digest(`Bearer ${token}`));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_POST) throw new Error('Too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * The inbox's HTTP routes, for the receiver's server: `GET /events?since=&source=`
 * and `POST /events/<source>`. Returns false for any other path. Both need the
 * token: the receiver is public, with no Access in front.
 */
export function inboxRoutes(inbox: Inbox, token: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://inbox');
    if (url.pathname !== EVENTS_PATH && !url.pathname.startsWith(`${EVENTS_PATH}/`)) return false;
    const json = (status: number, body: unknown) =>
      res
        .writeHead(status, { 'content-type': 'application/json' })
        .end(`${JSON.stringify(body)}\n`);
    if (!hasToken(req, token)) return (json(401, { error: 'Bad token' }), true);
    if (req.method === 'GET' && url.pathname === EVENTS_PATH) {
      const since = Number(url.searchParams.get('since') ?? 0);
      if (!Number.isSafeInteger(since) || since < 0)
        return (json(400, { error: 'Bad since' }), true);
      const events = inbox.since(since, url.searchParams.get('source') ?? undefined);
      return (json(200, { events, next: events.at(-1)?.id ?? since }), true);
    }
    const source = url.pathname.slice(EVENTS_PATH.length + 1);
    if (req.method !== 'POST' || !SOURCE.test(source))
      return (json(404, { error: 'Not found' }), true);
    // GitHub events only come in signed, through /github.
    if (source === GITHUB_SOURCE) return (json(403, { error: 'Reserved source' }), true);
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (error) {
      return (json(400, { error: error instanceof Error ? error.message : 'Bad body' }), true);
    }
    const parsed = PostedEvent.safeParse(body);
    if (!parsed.success) return (json(400, { error: parsed.error.message }), true);
    const { id } = inbox.add(source, parsed.data.type, parsed.data.data);
    return (json(201, { id }), true);
  };
}
