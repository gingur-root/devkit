// A page on another site can make the browser POST here with Troy's Access
// cookie, so a write must come from the dashboard's own origin.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test } from 'vite-plus/test';

import { ACCESS_JWT_HEADER, ACCESS_TEAM_URL, OPERATOR_EMAIL } from './constants.ts';
import { createDashboard } from './server.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keys = async () => [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1' }];
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const body = `${encode({ alg: 'RS256', kid: 'k1' })}.${encode({ aud: ['aud'], iss: ACCESS_TEAM_URL, email: OPERATOR_EMAIL, exp: Date.now() / 1000 + 60 })}`;
const jwt = `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;

test('serves the page to Troy, and refuses a chat from another origin', async () => {
  const server = createDashboard('aud', keys).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${url}/`, { headers: { [ACCESS_JWT_HEADER]: jwt } });
    assert.equal(page.status, 200);
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
