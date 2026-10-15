// The org webhook receiver (devkit#118): GitHub posts every gingur-root event
// here. It keeps gingur/hooks' shape: verify the signature, drop a delivery it
// has seen, then hand the event to each handler.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { dirname } from 'node:path';

export const WEBHOOK_PATH = '/github';
// Anyone can post here, and the body is read before its signature can be
// checked, so it is capped well under GitHub's 25 MB: the events subscribed
// to (issues, comments, items, PRs, runs) are far smaller.
const MAX_BODY = 1024 * 1024;
const SEEN_MAX = 10_000;

export interface Delivery {
  id: string;
  /** The `X-GitHub-Event` name, e.g. `issues`. */
  event: string;
  payload: unknown;
}
export type WebhookHandler = (delivery: Delivery) => void | Promise<void>;

/** Whether `header` is GitHub's `X-Hub-Signature-256` for `body` under `secret`. */
export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * `fresh` is true the first time it sees an id. It remembers the last `max`
 * ids, in `file` when given, so a restart or a redelivery can't start a run
 * twice. `forget` lets a delivery whose handler failed be redelivered.
 */
export function createDedupe(file?: string, max = SEEN_MAX) {
  const seen = new Set<string>(
    file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [],
  );
  if (file) mkdirSync(dirname(file), { recursive: true });
  // Renamed into place, so a crash mid-write never leaves a file that fails to parse.
  const save = () => {
    if (!file) return;
    writeFileSync(`${file}.tmp`, JSON.stringify([...seen]));
    renameSync(`${file}.tmp`, file);
  };
  return {
    fresh(id: string) {
      if (seen.has(id)) return false;
      seen.add(id);
      if (seen.size > max) seen.delete(seen.values().next().value!);
      // Saved before any handler runs, so a crash mid-handler never repeats it.
      save();
      return true;
    },
    forget(id: string) {
      if (seen.delete(id)) save();
    },
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The receiver's own server. It is public through the tunnel with no Access in
 * front, so the signature is the only gate.
 */
export function createReceiver(
  secret: string,
  handlers: WebhookHandler[],
  dedupe = createDedupe(),
): Server {
  return createServer(async (req, res) => {
    const text = (status: number, message: string) =>
      res.writeHead(status, { 'content-type': 'text/plain' }).end(`${message}\n`);
    if (req.method !== 'POST' || req.url !== WEBHOOK_PATH) return text(404, 'Not found');
    if (!req.headers['x-hub-signature-256']) return text(401, 'Bad signature');
    const body = await readBody(req);
    if (!body) return text(413, 'Too large');
    const header = (name: string) => {
      const value = req.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    if (!verifySignature(secret, body, header('x-hub-signature-256'))) {
      return text(401, 'Bad signature');
    }
    const id = header('x-github-delivery');
    const event = header('x-github-event');
    if (!id || !event) return text(400, 'Missing delivery headers');
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      return text(400, 'The hook must send application/json');
    }
    // Answer before the handlers run: GitHub gives up on a delivery after 10 s.
    res.writeHead(202).end();
    // A redelivery is answered like the first, so GitHub's log shows it landed.
    if (!dedupe.fresh(id)) return;
    for (const handle of handlers) {
      Promise.resolve()
        .then(() => handle({ id, event, payload }))
        .catch((error: unknown) => {
          // Redelivering it from the hook's log runs every handler again; the board's is idempotent.
          dedupe.forget(id);
          console.error(
            `Webhook handler failed on ${event} ${id}:`,
            error instanceof Error ? error.message : error,
          );
        });
    }
  });
}
