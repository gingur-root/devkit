// Tells the Claude Project coordinator when an issue opens or closes anywhere
// in the org. The receiver comments one line on the hub issue, and a claude.ai
// routine watching that issue relays the line to the project chat (infra
// docs/runbook.md, "Board event couriers"). GitHub can only fire a routine
// from one repo, so the hub is what makes one routine cover every repo.
import { rest } from '../agent/github.ts';
import { refreshGhToken } from '../dashboard/app-token.ts';
import { ORG } from '../dashboard/constants.ts';
import { GITHUB_EVENT } from './constants.ts';
import type { Delivery, WebhookHandler } from './receiver.ts';

export const HUB = { repo: 'pipeline', issue: 3 } as const;
const ACTIONS: readonly string[] = ['opened', 'closed'];
const MAX_TITLE = 80;

interface Payload {
  action?: string;
  sender?: { login?: string };
  repository?: { name?: string; owner?: { login?: string } };
  issue?: { number?: number; title?: string; html_url?: string };
}

/** The hub line for a delivery, or null. The title is quoted so it reads as data. */
export function boardEventLine({ event, payload }: Delivery): string | null {
  const { action, sender, repository, issue } = payload as Payload;
  if (event !== GITHUB_EVENT.issues || !action || !ACTIONS.includes(action)) return null;
  if (repository?.owner?.login !== ORG || !repository.name || !issue?.number) return null;
  if (repository.name === HUB.repo && issue.number === HUB.issue) return null;
  const title = issue.title ?? '';
  const quoted = JSON.stringify(title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE)}…` : title);
  return `[board event] ${repository.name}#${issue.number} ${action} by ${sender?.login ?? 'unknown'}: ${quoted} ${issue.html_url ?? ''}`.trimEnd();
}

/** The receiver's handler: comment each line on the hub issue as the App. */
export function boardEventsHandler(): WebhookHandler {
  return async (delivery) => {
    const body = boardEventLine(delivery);
    if (!body) return;
    await refreshGhToken();
    await rest('POST', `/repos/${ORG}/${HUB.repo}/issues/${HUB.issue}/comments`, { body });
  };
}
