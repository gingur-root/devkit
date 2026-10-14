// The receiver is public with no Access in front: an unsigned or forged post
// must never reach a handler, and a redelivery must not run handlers twice.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test } from 'vite-plus/test';

import { createDedupe, createReceiver, type Delivery, WEBHOOK_PATH } from './receiver.ts';

const SECRET = 'test-secret';
const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

test('a signed delivery reaches every handler once; forged, unsigned and repeated ones do not', async () => {
  const seen: Delivery[] = [];
  const server = createReceiver(SECRET, [
    (delivery) => void seen.push(delivery),
    () => {
      throw new Error('a failing handler must not stop the others');
    },
  ]).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${WEBHOOK_PATH}`;
  const body = JSON.stringify({ action: 'labeled', issue: { number: 7 } });
  const post = (headers: Record<string, string>, payload = body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'x-github-event': 'issues', 'x-github-delivery': 'd1', ...headers },
      body: payload,
    });
  try {
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ 'x-hub-signature-256': sign(body, 'wrong') })).status, 401);
    // Signed for one body, sent with another.
    assert.equal((await post({ 'x-hub-signature-256': sign(body) }, `${body} `)).status, 401);
    assert.equal(seen.length, 0);

    assert.equal((await post({ 'x-hub-signature-256': sign(body) })).status, 202);
    assert.equal((await post({ 'x-hub-signature-256': sign(body) })).status, 202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(seen, [
      { id: 'd1', event: 'issues', payload: { action: 'labeled', issue: { number: 7 } } },
    ]);

    assert.equal((await fetch(url.replace(WEBHOOK_PATH, '/'), { method: 'POST' })).status, 404);
  } finally {
    server.close();
  }
});

test('dedupe forgets the oldest id past its limit', () => {
  const fresh = createDedupe(2);
  assert.equal(fresh('a'), true);
  assert.equal(fresh('a'), false);
  fresh('b');
  fresh('c');
  assert.equal(fresh('b'), false);
  assert.equal(fresh('a'), true);
});
