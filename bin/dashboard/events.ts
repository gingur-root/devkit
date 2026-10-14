// Live updates (devkit#100): a source tells the page which card or the board
// changed. The org webhook (devkit#118) says so as it happens; polling is the
// safety net, since GitHub does not retry a delivery that failed.
import { GITHUB_EVENT } from '../webhooks/constants.ts';
import type { Delivery, WebhookHandler } from '../webhooks/receiver.ts';
import type { BoardCard } from './board.ts';
import { BOARD_EVENT } from './constants.ts';

export type BoardEvent =
  | { type: typeof BOARD_EVENT.cardChanged; repo: string; number: number }
  | { type: typeof BOARD_EVENT.boardChanged };
export type BoardEventListener = (event: BoardEvent) => void;

export interface BoardEventSource {
  subscribe(listener: BoardEventListener): () => void;
}

export const POLL_MS = 30_000;
// Only catches what the webhook missed, so it can be slow.
export const SAFETY_POLL_MS = 5 * 60_000;

/**
 * The in-process fan-out every source shares: `onFirst` runs when the first
 * listener arrives and `onLast` when the last one leaves.
 */
export function createHub(onFirst: () => void, onLast: () => void) {
  const listeners = new Set<BoardEventListener>();
  return {
    get size() {
      return listeners.size;
    },
    emit(event: BoardEvent) {
      for (const listener of listeners) listener(event);
    },
    subscribe(listener: BoardEventListener) {
      listeners.add(listener);
      if (listeners.size === 1) onFirst();
      return () => {
        if (listeners.delete(listener) && listeners.size === 0) onLast();
      };
    },
  };
}

type Snapshot = Map<string, string>;

/** Each card's version: a new `updatedAt` or a new column both count as a change. */
export function snapshot(cards: Pick<BoardCard, 'repo' | 'number' | 'updatedAt' | 'column'>[]) {
  return new Map(cards.map((c) => [`${c.repo}#${c.number}`, `${c.updatedAt} ${c.column}`]));
}

/** What changed between two reads: each changed card, and the board once if cards came or went. */
export function diffBoard(before: Snapshot, after: Snapshot): BoardEvent[] {
  const events: BoardEvent[] = [];
  let moved = before.size !== after.size;
  for (const [key, version] of after) {
    const was = before.get(key);
    if (was === undefined) moved = true;
    else if (was !== version) {
      const [repo, number] = key.split('#');
      events.push({ type: BOARD_EVENT.cardChanged, repo: repo!, number: Number(number) });
    }
  }
  if (moved) events.push({ type: BOARD_EVENT.boardChanged });
  return events;
}

/** Reads the board every `ms` while anyone listens, one read at a time. */
export function pollBoard(
  read: () => Promise<Parameters<typeof snapshot>[0]> = async () =>
    (await import('./board.ts')).board(),
  ms = POLL_MS,
): BoardEventSource {
  let last: Snapshot | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading = false;
  const tick = async () => {
    timer = undefined;
    reading = true;
    try {
      const next = snapshot(await read());
      if (last) for (const event of diffBoard(last, next)) hub.emit(event);
      last = next;
    } catch (error) {
      console.error('Board poll failed:', error instanceof Error ? error.message : error);
    } finally {
      reading = false;
      // The next read is scheduled only after this one ends, so reads never overlap.
      if (hub.size) timer = setTimeout(tick, ms);
    }
  };
  const hub = createHub(
    () => {
      // A read still running from before reschedules itself now that someone listens.
      if (!reading) void tick();
    },
    () => {
      clearTimeout(timer);
      timer = undefined;
    },
  );
  return { subscribe: hub.subscribe };
}

/** Every event any of `sources` sends. */
export function mergeSources(...sources: BoardEventSource[]): BoardEventSource {
  return {
    subscribe(listener) {
      const unsubscribes = sources.map((source) => source.subscribe(listener));
      return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
    },
  };
}

interface IssuePayload {
  repository?: { name?: string };
  issue?: { number?: number };
}

/** What a delivery means for the board: an issue or its comments name its card; project and sub-issue changes, the board. */
export function deliveryEvents({ event, payload }: Delivery): BoardEvent[] {
  if (event === GITHUB_EVENT.projectItem || event === GITHUB_EVENT.subIssues) {
    return [{ type: BOARD_EVENT.boardChanged }];
  }
  if (event !== GITHUB_EVENT.issues && event !== GITHUB_EVENT.issueComment) return [];
  const { repository, issue } = payload as IssuePayload;
  if (!repository?.name || !issue?.number) return [];
  return [{ type: BOARD_EVENT.cardChanged, repo: repository.name, number: issue.number }];
}

/** A source fed by the webhook receiver: `handle` is the receiver's handler. */
export function webhookBoard(): { source: BoardEventSource; handle: WebhookHandler } {
  const hub = createHub(
    () => {},
    () => {},
  );
  return {
    source: { subscribe: hub.subscribe },
    handle: (delivery) => deliveryEvents(delivery).forEach(hub.emit),
  };
}
