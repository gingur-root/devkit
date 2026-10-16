// The inbox is public through the receiver's tunnel: without the token nobody
// reads or writes it, and only signed deliveries may speak for GitHub.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vite-plus/test';

import { createInbox, githubInboxHandler, inboxRoutes } from './inbox.ts';
import { createReceiver } from './receiver.ts';

const TOKEN = 'inbox-token';

test('the token gates every read and write, and github is reserved for signed deliveries', async () => {
  const inbox = createInbox();
  const server = createReceiver('secret', [], undefined, inboxRoutes(inbox, TOKEN)).listen(
    0,
    '127.0.0.1',
  );
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, token?: string, body?: object) =>
    fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: body && JSON.stringify(body),
    });
  try {
    assert.equal((await call('/events')).status, 401);
    assert.equal((await call('/events', 'wrong')).status, 401);
    assert.equal((await call('/events/stripe', undefined, { type: 'paid' })).status, 401);
    assert.equal((await call('/events/github', TOKEN, { type: 'issues.opened' })).status, 403);
    assert.equal((await call('/events/stripe', TOKEN, { nope: 1 })).status, 400);
    assert.equal(
      (await call('/events/stripe', TOKEN, { type: 'paid', data: { cents: 5 } })).status,
      201,
    );
    const read = (await (await call('/events?since=0', TOKEN)).json()) as {
      events: { source: string; type: string }[];
      next: number;
    };
    assert.deepEqual(
      read.events.map((e) => [e.source, e.type]),
      [['stripe', 'paid']],
    );
    assert.equal(read.next, 1);
    // The GitHub webhook path still answers as before.
    assert.equal((await fetch(`${base}/github`, { method: 'POST' })).status, 401);
  } finally {
    server.close();
  }
});

test('ids keep growing across a restart, and GitHub deliveries land as summaries', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'inbox-')), 'events.jsonl');
  const first = createInbox(file, 2);
  githubInboxHandler(first)({
    id: 'd1',
    event: 'issues',
    payload: { action: 'opened', repository: { name: 'devkit' }, issue: { number: 9, title: 'x' } },
  });
  assert.deepEqual(first.since(0, 'github')[0], {
    ...first.since(0)[0],
    type: 'issues.opened',
    data: {
      repo: 'devkit',
      number: 9,
      title: 'x',
      url: undefined,
      sender: undefined,
      delivery: 'd1',
    },
  });
  first.add('stripe', 'paid');
  first.add('stripe', 'refunded');
  const second = createInbox(file, 2);
  assert.deepEqual(
    second.since(0).map((e) => [e.id, e.type]),
    [
      [2, 'paid'],
      [3, 'refunded'],
    ],
  );
  assert.equal(second.add('stripe', 'paid').id, 4);
});
