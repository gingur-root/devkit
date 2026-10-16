import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test, vi } from 'vite-plus/test';

import { refreshGhToken } from './app-token.ts';

test('the dashboard requests only the permissions its GitHub calls need', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env: NodeJS.ProcessEnv = {
    PIPELINE_APP_CLIENT_ID: 'client',
    PIPELINE_APP_INSTALLATION_ID: '42',
    PIPELINE_APP_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  const requests: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(
      JSON.stringify({
        token: 'test-token',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
  });
  try {
    await refreshGhToken(env);
    assert.equal(requests.length, 1);
    const { url, init } = requests[0]!;
    assert.equal(url, 'https://api.github.com/app/installations/42/access_tokens');
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(String(init.body)), {
      permissions: {
        issues: 'write',
        organization_projects: 'write',
        actions: 'write',
        pull_requests: 'read',
        checks: 'read',
      },
    });
    assert.equal(env.GH_TOKEN, 'test-token');
  } finally {
    vi.unstubAllGlobals();
  }
});
