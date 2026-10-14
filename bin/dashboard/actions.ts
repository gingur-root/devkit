// What each card button does on GitHub, as the pipeline App (devkit#99).
// Troy's Access login is the approval; the server re-reads the card first and
// refuses a press the card no longer allows.
import { z } from 'zod';

import { setStatus } from '../agent/board.ts';
import {
  BOARD_TITLE,
  CONTINUE_ROLES,
  type Handoff,
  STAGE_LABELS,
  STATUS_FIELD,
  STATUSES,
  type Status,
} from '../agent/constants.ts';
import { graphql, rest } from '../agent/github.ts';
import { marker } from '../agent/job.ts';
import { refreshGhToken } from './app-token.ts';
import { CARD_ACTIONS, type CardState, cardState, refusal } from './buttons.ts';
import { ORG, REPO_NAME } from './constants.ts';

const MAX_NOTE = 10_000;

export const CardRequest = z.object({
  repo: z.string().regex(REPO_NAME),
  number: z.number().int().positive(),
  action: z.enum(CARD_ACTIONS),
  /** The card as the page drew it. */
  seen: z.object({ column: z.enum(STATUSES), live: z.boolean() }),
  note: z.string().max(MAX_NOTE).default(''),
  /** Continue only: build on the WSL desk (`agent:elevated`). The page confirms it first. */
  elevated: z.boolean().default(false),
});
export type CardRequest = z.infer<typeof CardRequest>;

/** A press the server refused, with the HTTP status the page gets. */
export class ActionError extends Error {
  constructor(
    readonly status: 400 | 409 | 501,
    message: string,
  ) {
    super(message);
  }
}

/** Merges a Ready card's PR with Troy's own merge token. Not built: that token does not exist yet. */
export type MergeHook = (repo: string, issue: number) => Promise<void>;

export interface LiveCard {
  nodeId: string;
  title: string;
  state: CardState;
}

interface IssueQuery {
  repository: {
    issue: {
      id: string;
      title: string;
      state: string;
      labels: { nodes: { name: string }[] };
      projectItems: {
        nodes: { project: { title: string }; status: { name: string } | null }[];
      };
    } | null;
  };
}

/** The card as GitHub has it now. */
export async function readCard(repo: string, number: number): Promise<LiveCard> {
  const { repository } = await graphql<IssueQuery>(
    `
      query ($owner: String!, $name: String!, $number: Int!, $field: String!) {
        repository(owner: $owner, name: $name) {
          issue(number: $number) {
            id
            title
            state
            labels(first: 50) {
              nodes {
                name
              }
            }
            projectItems(first: 20) {
              nodes {
                project {
                  title
                }
                status: fieldValueByName(name: $field) {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                  }
                }
              }
            }
          }
        }
      }
    `,
    { owner: ORG, name: repo, number, field: STATUS_FIELD },
  );
  const issue = repository.issue;
  if (!issue) throw new ActionError(409, `${repo}#${number} is not an issue.`);
  const status = issue.projectItems.nodes.find((i) => i.project.title === BOARD_TITLE)?.status
    ?.name as Status | undefined;
  return {
    nodeId: issue.id,
    title: issue.title,
    state: cardState({
      open: issue.state === 'OPEN',
      status: status ?? null,
      labels: issue.labels.nodes.map((l) => l.name),
    }),
  };
}

export interface Run {
  id: number;
  status: string;
  event: string;
  display_title: string;
}

/**
 * The runs still going for an issue: an issue event's run is titled after it.
 * shortcut: two open issues with one title in a repo share their runs here;
 * name runs by issue number in the callers (`run-name`) if that ever bites.
 */
export function liveRuns(runs: Run[], title: string): Run[] {
  return runs.filter(
    (r) =>
      r.status !== 'completed' &&
      r.display_title === title &&
      (r.event === 'issues' || r.event === 'issue_comment'),
  );
}

/** The App comment a Continue leaves: the planner reads the note, and the gate reads the marker. */
export function continueComment(to: Handoff, heading: string, note: string): string {
  const where = to === 'elevated' ? ' Build it elevated, on the WSL desk.' : '';
  return [marker(CONTINUE_ROLES[to]), `**${heading} from the dashboard.**${where}`, note.trim()]
    .filter(Boolean)
    .join('\n\n');
}

const HEADINGS = { continue: 'Continue', 'request-changes': 'Changes requested' } as const;

/** Carries out a press, after checking the card still allows it. */
export async function act(
  req: CardRequest,
  merge?: MergeHook,
  read: typeof readCard = readCard,
): Promise<void> {
  await refreshGhToken();
  const card = await read(req.repo, req.number);
  const why = refusal(req.seen, card.state, req.action);
  if (why) throw new ActionError(409, why);
  const repo = `${ORG}/${req.repo}`;
  const issue = `/repos/${repo}/issues/${req.number}`;
  switch (req.action) {
    case 'plan':
      await rest('POST', `${issue}/labels`, { labels: [STAGE_LABELS.plan] });
      return;
    case 'close':
      await rest('PATCH', issue, { state: 'closed', state_reason: 'not_planned' });
      await setStatus(repo, card.nodeId, 'Done');
      return;
    case 'reopen':
      await rest('PATCH', issue, { state: 'open' });
      await setStatus(repo, card.nodeId, 'Ask');
      return;
    case 'stop': {
      const { workflow_runs } = await rest<{ workflow_runs: Run[] }>(
        'GET',
        `/repos/${repo}/actions/runs?per_page=100`,
      );
      const live = liveRuns(workflow_runs, card.title);
      // The run ended between the read and now; the loop moves the card.
      if (!live.length) throw new ActionError(409, 'No live run to stop.');
      for (const run of live) await rest('POST', `/repos/${repo}/actions/runs/${run.id}/cancel`);
      return;
    }
    case 'continue':
    case 'request-changes': {
      // shortcut: no /revise yet (devkit#13), so the planner takes the change request as a Continue note.
      if (req.action === 'request-changes' && !req.note.trim())
        throw new ActionError(400, 'Say what to change.');
      const to: Handoff = req.action === 'continue' && req.elevated ? 'elevated' : 'build';
      await rest('POST', `${issue}/comments`, {
        body: continueComment(to, HEADINGS[req.action], req.note),
      });
      await rest('POST', `${issue}/labels`, { labels: [STAGE_LABELS.plan] });
      return;
    }
    case 'merge':
      if (!merge)
        throw new ActionError(501, 'Merge needs the merge token, which is not set up yet.');
      await merge(req.repo, req.number);
      return;
  }
}
