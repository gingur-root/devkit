import assert from 'node:assert/strict';
import { test, vi } from 'vite-plus/test';

import { providerStatus } from './status.ts';

test('provider status reports operational, incident and unavailable pages without throwing', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  try {
    assert.equal(await providerStatus('stub'), null);
    assert.equal(fetch.mock.calls.length, 0);
    fetch.mockResolvedValue(
      Response.json({ status: { indicator: 'none', description: 'All Systems Operational' } }),
    );
    assert.equal(
      await providerStatus('claude'),
      'Provider status (status.claude.com): All Systems Operational.',
    );
    assert.equal(fetch.mock.calls[0]![0], 'https://status.claude.com/api/v2/status.json');
    fetch.mockResolvedValue(
      Response.json({ status: { indicator: 'major', description: 'Service disruption' } }),
    );
    assert.equal(
      await providerStatus('codex'),
      'Provider status (status.openai.com): open incident, Service disruption (major). https://status.openai.com',
    );
    for (const response of [new Response(null, { status: 503 }), Response.json({ bad: true })]) {
      fetch.mockResolvedValue(response);
      assert.equal(
        await providerStatus('claude'),
        'Provider status: unknown, status.claude.com did not answer.',
      );
    }
    fetch.mockRejectedValue(new Error('network down'));
    assert.equal(
      await providerStatus('claude'),
      'Provider status: unknown, status.claude.com did not answer.',
    );
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      assert.equal(ms, 5000);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    fetch.mockImplementation(
      (_url, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener('abort', () => reject(new Error('timeout')));
        }),
    );
    const pending = providerStatus('claude');
    await vi.advanceTimersByTimeAsync(5000);
    assert.equal(await pending, 'Provider status: unknown, status.claude.com did not answer.');
    timeout.mockRestore();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
