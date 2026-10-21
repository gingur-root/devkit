import { z } from 'zod';

import { Dispatch } from '../webhooks/constants.ts';
import {
  HOLD_FALLBACK_MINUTES,
  HOLD_STATES,
  HELD_LABEL,
  PIPELINE_BOT,
  STAGE_LABELS,
  type Executor,
} from './constants.ts';
import { rest, upsertStageComment } from './github.ts';
import { marker } from './job.ts';
import type { Failure } from './result.ts';

const Held = z.strictObject({
  until: z.iso.datetime(),
  dispatch: Dispatch.nullable(),
  state: z.enum(HOLD_STATES),
});
export type Held = z.infer<typeof Held>;

export function holdUntil(failure: Failure, executor: Executor, now: Date): Date | null {
  if (executor !== 'claude' || failure.class !== 'rate_limit') return null;
  const until =
    failure.resetsAt === null
      ? new Date(now.getTime() + HOLD_FALLBACK_MINUTES * 60_000)
      : new Date(failure.resetsAt);
  return until > now ? until : null;
}

export function retry(role: string): string {
  if (role === 'plan' || role === 'research') return `add \`${STAGE_LABELS[role]}\``;
  return 'reply `/approve`';
}

export function parseHeld(
  comments: { id: number; body: string | null; user: { id: number } | null }[],
): (Held & { comment: number }) | null {
  for (const comment of comments) {
    // Other bot comments contain agent-written reports, which can quote markers.
    if (comment.user?.id !== PIPELINE_BOT.id || !comment.body?.startsWith(marker('held'))) continue;
    const json = /<!-- devkit:held (.+) -->/.exec(comment.body ?? '')?.[1];
    if (!json) continue;
    try {
      const held = Held.safeParse(JSON.parse(json));
      if (held.success) return { ...held.data, comment: comment.id };
    } catch {
      // A malformed marker is not pipeline state.
    }
  }
  return null;
}

export async function markHeld(
  repo: string,
  issue: number,
  held: Held,
  role: string,
): Promise<void> {
  const time = held.until.slice(0, 16).replace('T', ' ');
  const next = held.dispatch
    ? `${held.dispatch.stage} starts again then.`
    : `This card stays in Needs you; after the reset, ${retry(role)}.`;
  await upsertStageComment(
    repo,
    issue,
    'held',
    [
      marker('held'),
      `<!-- devkit:held ${JSON.stringify(held)} -->`,
      `**Held until ${time} UTC:** Claude usage limit. ${next}`,
    ].join('\n\n'),
  );
  await rest('POST', `/repos/${repo}/issues/${issue}/labels`, { labels: [HELD_LABEL] });
}
