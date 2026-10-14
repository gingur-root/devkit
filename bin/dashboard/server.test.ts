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

import { ACCESS_JWT_HEADER, ACCESS_TEAM_URL, OPERATOR_EMAIL } from './constants.ts';
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
