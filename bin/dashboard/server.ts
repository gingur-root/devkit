import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import { type FetchKeys, verifyAccessToken } from './access.ts';
import { ACCESS_JWT_HEADER, DASHBOARD_ORIGIN, REPO_NAME } from './constants.ts';
import { createStore, HOME_THREAD, threadKey } from './store.ts';

/** Where `devkit dashboard serve` builds the page (web/). */
export const WEB_DIST = new URL('./web/dist/', import.meta.url);
const ASSET = /^\/assets\/[\w.-]+\.(js|css)$/;
const TYPES = { js: 'text/javascript', css: 'text/css' } as const;
const MAX_BODY = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error('Body too large.');
  }
  return JSON.parse(body) as Record<string, unknown>;
}

/** A repo and issue number from a request, or undefined for the home thread. */
function issueRef(repo: unknown, number: unknown) {
  if (repo === undefined || repo === null || repo === '') return undefined;
  const n = Number(number);
  if (typeof repo !== 'string' || !REPO_NAME.test(repo) || !Number.isInteger(n) || n < 1) {
    throw new Error('Bad repo or issue number.');
  }
  return { repo, number: n };
}

export function createDashboard(
  aud: string,
  keys: FetchKeys,
  store = createStore(),
  web: URL = WEB_DIST,
): Server {
  return createServer(async (req, res) => {
    const header = req.headers[ACCESS_JWT_HEADER];
    const email = await verifyAccessToken(
      typeof header === 'string' ? header : undefined,
      aud,
      keys,
    );
    if (!email) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden\n');
      return;
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && req.url === '/') {
        const page = await readFile(new URL('index.html', web));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
      } else if (req.method === 'GET' && ASSET.test(url.pathname)) {
        // The pattern allows no slashes or dots before the name, so no path escapes dist.
        const ext = url.pathname.split('.').pop() as keyof typeof TYPES;
        const file = await readFile(new URL(`.${url.pathname}`, web));
        res
          .writeHead(200, {
            'content-type': TYPES[ext],
            'cache-control': 'max-age=31536000, immutable',
          })
          .end(file);
      } else if (req.method === 'GET' && req.url === '/api/threads') {
        const { threads } = await import('./threads.ts');
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(await threads()));
      } else if (req.method === 'POST' && req.headers.origin !== DASHBOARD_ORIGIN) {
        // The Access cookie rides along on cross-site requests too, so a write
        // must come from the dashboard's own page.
        res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden\n');
      } else if (req.method === 'POST' && req.url === '/api/start') {
        const { repo, number } = await readJson(req);
        const { startPlan } = await import('./coordinator.ts');
        await startPlan(String(repo), Number(number));
        res.writeHead(204).end();
      } else if (req.method === 'GET' && url.pathname === '/api/thread') {
        const ref = issueRef(url.searchParams.get('repo'), url.searchParams.get('number'));
        const key = ref ? threadKey(ref.repo, ref.number) : HOME_THREAD;
        const { lines } = await store.get(key);
        const { linesToMessages } = await import('./stream.ts');
        const issue = ref
          ? await (await import('./issue.ts')).readThread(ref.repo, ref.number)
          : null;
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ issue, messages: linesToMessages(lines) }));
      } else if (req.method === 'POST' && req.url === '/api/chat') {
        const { text, repo, number } = await readJson(req);
        if (typeof text !== 'string' || !text.trim()) throw new Error('A message is required.');
        const ref = issueRef(repo, number);
        const { chatTurn } = await import('./chat.ts');
        const { writeEvents } = await import('./stream.ts');
        const { createUIMessageStream, pipeUIMessageStreamToResponse } = await import('ai');
        const stream = createUIMessageStream({
          execute: ({ writer }) => writeEvents(chatTurn(store, text, ref), writer as never),
          // Troy is the only reader, so he sees the real error.
          onError: (error) => (error instanceof Error ? error.message : String(error)),
        });
        await pipeUIMessageStreamToResponse({ response: res, stream });
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found\n');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (res.headersSent) res.end();
      else res.writeHead(500, { 'content-type': 'text/plain' }).end(`${message}\n`);
    }
  });
}
