// Receipts on the event that started a run (devkit#148): 👀 while it works,
// then one end-state reaction. The writer is the App, or on the WSL desk the
// operator's own `gh`. Best effort: a failed reaction logs a warning and never
// fails a job.

import { OPERATOR_ID, PIPELINE_BOT, STAGE_COMMANDS, type Status } from './constants.ts';
import { rest, restAll } from './github.ts';

export const RECEIPTS = { done: 'rocket', question: 'confused', failed: '-1' } as const;
export type Receipt = keyof typeof RECEIPTS;

const EYES = 'eyes';

interface Reaction {
  id: number;
  content: string;
  user: { id: number } | null;
}

interface Comment {
  id: number;
  body: string | null;
  user: { id: number } | null;
  reactions?: { eyes?: number };
}

/** Whoever github.ts writes as: the App with GH_TOKEN, else the operator's `gh` login. */
function writer(): number {
  return process.env.GH_TOKEN ? PIPELINE_BOT.id : OPERATOR_ID;
}

function warn(what: string, error: unknown): void {
  console.log(`::warning::${what}: ${error instanceof Error ? error.message : String(error)}`);
}

/** Adds 👀 to the comment, or to the issue when there's no comment. Never throws; logs `::warning::`. */
export async function react(repo: string, issue: number, comment?: number): Promise<void> {
  const target =
    comment === undefined
      ? `/repos/${repo}/issues/${issue}`
      : `/repos/${repo}/issues/comments/${comment}`;
  try {
    await rest('POST', `${target}/reactions`, { content: EYES });
  } catch (error) {
    warn(`Could not add 👀 to ${repo}#${issue}`, error);
  }
}

/** Pure: the writer's reaction IDs to delete on one target, and whether to add the end reaction (only when its eyes is there). */
export function swap(reactions: Reaction[], own: number): { remove: number[]; add: boolean } {
  // On the WSL desk the writer is the operator, whose other reactions must stay.
  const receipts: string[] = [EYES, ...Object.values(RECEIPTS)];
  const mine = reactions.filter((r) => r.user?.id === own && receipts.includes(r.content));
  const add = mine.some((r) => r.content === EYES);
  return { remove: add ? mine.map((r) => r.id) : [], add };
}

/** Swaps the writer's own eyes on the issue and its command comments for one end reaction. Never throws. */
export async function settle(repo: string, issue: number, receipt: Receipt): Promise<void> {
  const own = writer();
  const path = `/repos/${repo}/issues/${issue}`;
  try {
    const commands = (await restAll<Comment>(`${path}/comments`)).filter(
      (c) =>
        c.user?.id === OPERATOR_ID &&
        (c.reactions?.eyes ?? 0) > 0 &&
        Object.keys(STAGE_COMMANDS).some((command) => c.body?.startsWith(command)),
    );
    const targets = [path, ...commands.map((c) => `/repos/${repo}/issues/comments/${c.id}`)];
    for (const target of targets) {
      const { remove, add } = swap(await restAll<Reaction>(`${target}/reactions`), own);
      for (const id of remove) await rest('DELETE', `${target}/reactions/${id}`);
      if (add) await rest('POST', `${target}/reactions`, { content: RECEIPTS[receipt] });
    }
  } catch (error) {
    warn(`Could not settle the receipt on ${repo}#${issue}`, error);
  }
}

/** Pure: the receipt a publish leaves, or null when a later stage in the same run has the last word. */
export function receiptFor(
  role: string,
  status: Status,
  stopped: boolean,
  planReady: boolean,
): Receipt | null {
  if (stopped) return 'failed';
  if (role === 'retro') return null;
  // The build's review follows in the same run.
  if (role === 'build' && status === 'Ready') return null;
  // Only a plan handing off ends in Building; a review or repair in Building has a repair or review next.
  if (status === 'Building') return role === 'plan' ? 'done' : null;
  if (status === 'Needs you') return role === 'plan' && planReady ? 'done' : 'question';
  return 'done';
}
