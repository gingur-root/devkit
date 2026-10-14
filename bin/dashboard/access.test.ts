// The Access check is the only thing between a runner job on the same box and
// a dashboard that writes GitHub as the App, so each way it can say no is
// pinned here.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'vite-plus/test';

import { verifyAccessToken } from './access.ts';
import { ACCESS_TEAM_URL, OPERATOR_EMAIL } from './constants.ts';

const AUD = 'dashboard-aud';
const NOW = 1_800_000_000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keys = async () => [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1' }];

function token(claims: object, { alg = 'RS256', key = privateKey } = {}): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg, kid: 'k1' })}.${encode(claims)}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}

const valid = { aud: [AUD], iss: ACCESS_TEAM_URL, email: OPERATOR_EMAIL, exp: NOW + 60 };

test('accepts the operator with a valid token', async () => {
  assert.equal(await verifyAccessToken(token(valid), AUD, keys, NOW), OPERATOR_EMAIL);
});

test('rejects a missing or malformed token', async () => {
  assert.equal(await verifyAccessToken(undefined, AUD, keys, NOW), null);
  assert.equal(await verifyAccessToken('a.b', AUD, keys, NOW), null);
  assert.equal(await verifyAccessToken('a.b.c', AUD, keys, NOW), null);
});

test('rejects a token signed by another key, or a non-RS256 one', async () => {
  assert.equal(
    await verifyAccessToken(token(valid, { key: other.privateKey }), AUD, keys, NOW),
    null,
  );
  assert.equal(await verifyAccessToken(token(valid, { alg: 'none' }), AUD, keys, NOW), null);
});

test('rejects another app, another issuer, another user, or an expired token', async () => {
  for (const claims of [
    { ...valid, aud: ['vps-ssh'] },
    { ...valid, iss: 'https://evil.cloudflareaccess.com' },
    { ...valid, email: 'someone@example.com' },
    { ...valid, exp: NOW - 1 },
    { ...valid, nbf: NOW + 60 },
  ]) {
    assert.equal(
      await verifyAccessToken(token(claims), AUD, keys, NOW),
      null,
      JSON.stringify(claims),
    );
  }
});
