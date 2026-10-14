// The card buttons as a state machine (devkit#99, docs/board.md). The page and
// the server both read this file: the page to draw the buttons, the server to
// refuse a press the card no longer allows.
import { STAGE_LABELS, type Status } from '../agent/constants.ts';

export const CARD_ACTIONS = [
  'plan',
  'close',
  'stop',
  'continue',
  'merge',
  'request-changes',
  'reopen',
] as const;
export type CardAction = (typeof CARD_ACTIONS)[number];

/** What a card's buttons depend on: its own column, and whether a run is live or queued. */
export interface CardState {
  column: Status;
  live: boolean;
}

const STAGES = new Set<string>(Object.values(STAGE_LABELS));

export function cardState(issue: {
  open: boolean;
  status: Status | null;
  labels: string[];
}): CardState {
  const column = issue.open ? (issue.status ?? 'Ask') : 'Done';
  // A stage label is a run that started or waits to; the loop moves a dead run out of Planning and Building.
  const live =
    issue.open &&
    (column === 'Planning' || column === 'Building' || issue.labels.some((l) => STAGES.has(l)));
  return { column, live };
}

const BY_COLUMN: Record<Status, readonly CardAction[]> = {
  Ask: ['plan', 'close'],
  Planning: [],
  'Needs you': ['continue', 'close'],
  Building: [],
  Ready: ['merge', 'request-changes'],
  Done: ['reopen'],
};

/** The buttons a card shows. A live run shows only Stop, so nothing queues behind it. */
export function buttons(state: CardState): readonly CardAction[] {
  return state.live ? ['stop'] : BY_COLUMN[state.column];
}

/**
 * Why a press must be refused, or null: the card moved or its run started or
 * ended since the page loaded, or the press is not one of its buttons.
 */
export function refusal(seen: CardState, now: CardState, action: CardAction): string | null {
  if (seen.column !== now.column || seen.live !== now.live)
    return `The card changed since the page loaded (now ${now.column}${now.live ? ', running' : ''}).`;
  if (!buttons(now).includes(action)) return `${action} is not a move from ${now.column}.`;
  return null;
}
