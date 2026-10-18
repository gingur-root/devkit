// A page on another site can make the browser POST here with Troy's Access
// cookie, so a write must come from the dashboard's own origin.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { test } from 'vite-plus/test';

import {
  ACCESS_JWT_HEADER,
  ACCESS_TEAM_URL,
  BOARD_EVENT,
  DASHBOARD_ORIGIN,
  OPERATOR_EMAIL,
} from './constants.ts';
import { createHub } from './events.ts';
import { createDashboard } from './server.ts';
import { createStore } from './store.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keys = async () => [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1' }];
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const body = `${encode({ alg: 'RS256', kid: 'k1' })}.${encode({ aud: ['aud'], iss: ACCESS_TEAM_URL, email: OPERATOR_EMAIL, exp: Date.now() / 1000 + 60 })}`;
const jwt = `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;

const web = mkdtempSync(join(tmpdir(), 'web-'));
writeFileSync(join(web, 'index.html'), '<!doctype html>');
mkdirSync(join(web, 'assets'));
writeFileSync(join(web, 'assets', 'a.js'), 'export {};');

test('serves the page and its assets to Troy, nothing else, and refuses a chat from another origin', async () => {
  const server = createDashboard(
    'aud',
    keys,
    createStore(join(web, 'state.json')),
    pathToFileURL(`${web}/`),
    createHub(),
  ).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${url}/`, { headers: { [ACCESS_JWT_HEADER]: jwt } });
    assert.equal(page.status, 200);
    const asset = await fetch(`${url}/assets/a.js`, { headers: { [ACCESS_JWT_HEADER]: jwt } });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('content-type'), 'text/javascript');
    // Only built assets: the state file next to them never leaves the box.
    for (const path of ['/assets/%2e%2e%2fstate.json', '/assets/../state.json', '/state.json']) {
      const res = await fetch(`${url}${path}`, { headers: { [ACCESS_JWT_HEADER]: jwt } });
      assert.equal(res.status, 404, path);
    }
    const chat = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: {
        [ACCESS_JWT_HEADER]: jwt,
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prompt: 'file an issue' }),
    });
    assert.equal(chat.status, 403);
  } finally {
    server.close();
  }
});

test('streams board events to a connected page, and lets go when it leaves', async () => {
  const hub = createHub();
  const server = createDashboard(
    'aud',
    keys,
    createStore(join(web, 'state.json')),
    pathToFileURL(`${web}/`),
    hub,
  ).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events`;
  const leave = new AbortController();
  try {
    assert.equal((await fetch(url)).status, 403);
    const res = await fetch(url, { headers: { [ACCESS_JWT_HEADER]: jwt }, signal: leave.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    await reader.read();
    hub.emit({ type: BOARD_EVENT.cardChanged, repo: 'devkit', number: 7 });
    let text = '';
    while (!/data: .*\n\n/.test(text)) text += (await reader.read()).value;
    assert.match(text, /data: {"type":"card.changed","repo":"devkit","number":7}\n\n/);
    leave.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(hub.size, 0);
  } finally {
    leave.abort();
    server.close();
  }
});

test('clears only home and only for an authenticated dashboard-origin POST', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dash-')), 'state.json');
  const store = createStore(file);
  await store.update('home', (thread) => {
    thread.session = 'old-session';
    thread.lines.push({ role: 'me', text: 'keep until confirmed' });
  });
  await store.update('devkit#7', (thread) => {
    thread.lines.push({ role: 'me', text: 'keep this issue' });
  });
  const server = createDashboard('aud', keys, store, pathToFileURL(`${web}/`), createHub()).listen(
    0,
    '127.0.0.1',
  );
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { [ACCESS_JWT_HEADER]: jwt };
  const readHome = async () => {
    const response = await fetch(`${url}/api/thread`, { headers });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const before = await readHome();
    assert.equal(before.messages.length, 1);
    const unauthenticated = await fetch(`${url}/api/clear`, {
      method: 'POST',
      headers: { origin: DASHBOARD_ORIGIN },
    });
    assert.equal(unauthenticated.status, 403);
    for (const origin of ['https://evil.example', undefined]) {
      const denied = await fetch(`${url}/api/clear`, {
        method: 'POST',
        headers: { ...headers, ...(origin ? { origin } : {}) },
      });
      assert.equal(denied.status, 403);
      assert.deepEqual(await readHome(), before);
    }
    const cleared = await fetch(`${url}/api/clear`, {
      method: 'POST',
      headers: { ...headers, origin: DASHBOARD_ORIGIN },
    });
    assert.equal(cleared.status, 204);
    assert.equal(await cleared.text(), '');
    assert.deepEqual(await readHome(), { issue: null, messages: [] });
    const saved = createStore(file);
    assert.deepEqual(await saved.get('home'), { lines: [] });
    assert.deepEqual((await saved.get('devkit#7')).lines, [
      { role: 'me', text: 'keep this issue' },
    ]);
  } finally {
    server.close();
  }
});
