// Live updates (devkit#100): a source tells the page which card or the board
// changed. The org webhook (devkit#118) is the only source: a delivery that
// fails is lost, which the alpha accepts.
import { GITHUB_EVENT } from '../webhooks/constants.ts';
import type { Delivery, WebhookHandler } from '../webhooks/receiver.ts';
import { BOARD_EVENT } from './constants.ts';

export type BoardEvent =
  | { type: typeof BOARD_EVENT.cardChanged; repo: string; number: number }
  | { type: typeof BOARD_EVENT.boardChanged };
export type BoardEventListener = (event: BoardEvent) => void;

export interface BoardEventSource {
  subscribe(listener: BoardEventListener): () => void;
}

/** The in-process fan-out from the receiver to each open page. */
export function createHub() {
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
      return () => void listeners.delete(listener);
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
  const hub = createHub();
  return {
    source: { subscribe: hub.subscribe },
    handle: (delivery) => deliveryEvents(delivery).forEach(hub.emit),
  };
}
