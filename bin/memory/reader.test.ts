import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vite-plus/test';

import { githubReader } from './reader.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('GitHub reader encodes path segments, decodes UTF-8, and uses the default branch', async () => {
  vi.stubEnv('GH_TOKEN', 'fixture');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    assert.equal(
      url,
      'https://api.github.com/repos/gingur-root/devkit/contents/docs/a%20file%23%3F.md',
    );
    assert.equal(init.method, 'GET');
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer fixture');
    return Response.json({
      encoding: 'base64',
      content: Buffer.from('A fact: café\n').toString('base64'),
    });
  });
  assert.equal(await githubReader('gingur-root/devkit:docs/a file#?.md'), 'A fact: café\n');
});

test('GitHub reader returns null only for a 404', async () => {
  vi.stubEnv('GH_TOKEN', 'fixture');
  vi.stubGlobal('fetch', async () => new Response('missing', { status: 404 }));
  assert.equal(await githubReader('gingur-root/devkit:missing.md'), null);
  vi.stubGlobal('fetch', async () => new Response('permission denied', { status: 403 }));
  await assert.rejects(githubReader('gingur-root/devkit:private.md'), /403 permission denied/);
});

test('GitHub reader refuses unsupported content encoding', async () => {
  vi.stubEnv('GH_TOKEN', 'fixture');
  vi.stubGlobal('fetch', async () => Response.json({ encoding: 'none', content: '' }));
  await assert.rejects(
    githubReader('gingur-root/devkit:large.md'),
    /expected base64 encoding, got none/,
  );
});
