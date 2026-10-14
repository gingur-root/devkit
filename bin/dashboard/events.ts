// Live updates (devkit#100): a source tells the page which card or the board
// changed. Polling stands in until a webhook source emits the same events.
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
