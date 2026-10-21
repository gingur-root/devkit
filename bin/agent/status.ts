import { z } from 'zod';

import { STATUS_PAGES, type Executor } from './constants.ts';

const ProviderStatus = z.object({
  status: z.object({
    indicator: z.enum(['none', 'minor', 'major', 'critical']),
    description: z.string(),
  }),
});

export async function providerStatus(executor: Executor): Promise<string | null> {
  if (executor === 'stub') return null;
  const page = STATUS_PAGES[executor];
  const host = new URL(page).hostname;
  try {
    const response = await fetch(`${page}/api/v2/status.json`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { status } = ProviderStatus.parse(await response.json());
    return status.indicator === 'none'
      ? `Provider status (${host}): ${status.description.replace(/\.$/, '')}.`
      : `Provider status (${host}): open incident, ${status.description} (${status.indicator}). ${page}`;
  } catch {
    return `Provider status: unknown, ${host} did not answer.`;
  }
}
