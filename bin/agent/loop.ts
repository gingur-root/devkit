// The board loop (devkit#47): one tick reads a repo's cards, decides the next
// step for each in code, and does it. It runs on events only: as the last job
// of every plan and build run, however the run ended, and when the operator
// adds `ready-for-agent`. GitHub is the only state: each action leaves its
// record on the card (the label, the Status), so a rerun finds it and does
// nothing.

import { appendFileSync } from 'node:fs';

import { setStatus } from './board.ts';
import {
  BOARD_TITLE,
  OPERATOR_ID,
  READY_LABEL,
  STAGE_LABELS,
  STATUS_FIELD,
  type Status,
} from './constants.ts';
import { graphql, removeLabel, rest, upsertStageComment } from './github.ts';
import { mention, stopped } from './publish.ts';

export interface Card {
  number: number;
  nodeId: string;
  /** Null when the issue is not on the board (yet: the board adds cards on its own). */
  status: Status | null;
  labels: string[];
  /** Who last added `ready-for-agent`, by GitHub user ID. */
  readyBy: number | null;
}

/** The run this tick ends: its stage, issue and each job's result. Absent on a `ready-for-agent` tick. */
export interface Ran {
  role: 'plan' | 'build';
  issue: number;
  jobs: Record<string, { result: string }>;
}

export type Action =
  | { kind: 'stalled'; issue: number; role: Ran['role']; stage: string; reason: string }
  | { kind: 'plan'; issue: number };

export interface Decision {
  actions: Action[];
  /** Every card the tick looked at and left alone, and why. */
  skipped: string[];
}

const ENDED = ['failure', 'cancelled'];

/**
 * The next step for each card: a card the run left in Planning or Building,
 * or still carrying its label, goes to Needs you, then the repo's oldest ready card starts planning if no
 * card is planning. One action per card.
 */
export function decide(cards: Card[], ran?: Ran): Decision {
  const actions: Action[] = [];
  const skipped: string[] = [];
  const left = ran && cards.find((c) => c.number === ran.issue);
  // Publish always removes the trigger label, so a label left behind means the
  // run died before it, even before it set the card's Status.
  if (
    ran &&
    left &&
    (left.status === 'Planning' ||
      left.status === 'Building' ||
      left.labels.includes(STAGE_LABELS[ran.role]))
  ) {
    const [stage, job] = Object.entries(ran.jobs).find(([, j]) => ENDED.includes(j.result)) ?? [
      ran.role,
      undefined,
    ];
    actions.push({
      kind: 'stalled',
      issue: ran.issue,
      role: ran.role,
      stage,
      reason: `the run ended ${job ? `(\`${job.result}\`) ` : ''}before it published`,
    });
  }

  // One action per card: the stalled card is now in Needs you.
  const open = cards.filter((c) => !actions.some((a) => a.issue === c.number));
  const busy = open.filter((c) => c.status === 'Planning' || c.labels.includes(STAGE_LABELS.plan));
  if (busy.length) {
    skipped.push(`No new plan: #${busy.map((c) => c.number).join(', #')} is planning.`);
    return { actions, skipped };
  }
  for (const card of open.sort((a, b) => a.number - b.number)) {
    if (!card.labels.includes(READY_LABEL) || (card.status !== 'Ask' && card.status !== null))
      continue;
    if (card.readyBy !== OPERATOR_ID) {
      skipped.push(`#${card.number}: \`${READY_LABEL}\` was not added by the operator.`);
      continue;
    }
    actions.push({ kind: 'plan', issue: card.number });
    break;
  }
  return { actions, skipped };
}

interface Snapshot {
  repository: {
    issues: {
      nodes: {
        number: number;
        id: string;
        labels: { nodes: { name: string }[] };
        projectItems: {
          nodes: { project: { title: string }; status: { name: string } | null }[];
        };
        timelineItems: {
          nodes: { label?: { name: string }; actor?: { databaseId?: number } | null }[];
        };
      }[];
    };
  };
}

/** The repo's open issues as cards. */
export async function snapshot(repo: string): Promise<Card[]> {
  const [owner, name] = repo.split('/');
  // shortcut: the first 100 open issues only; page them when a repo holds more.
  const { repository } = await graphql<Snapshot>(
    `
      query ($owner: String!, $name: String!, $field: String!) {
        repository(owner: $owner, name: $name) {
          issues(states: OPEN, first: 100) {
            nodes {
              number
              id
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
              timelineItems(itemTypes: [LABELED_EVENT], last: 100) {
                nodes {
                  ... on LabeledEvent {
                    label {
                      name
                    }
                    actor {
                      ... on User {
                        databaseId
                      }
                      ... on Bot {
                        databaseId
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { owner, name, field: STATUS_FIELD },
  );
  return repository.issues.nodes.map((issue) => ({
    number: issue.number,
    nodeId: issue.id,
    status: (issue.projectItems.nodes.find((i) => i.project.title === BOARD_TITLE)?.status?.name ??
      null) as Status | null,
    labels: issue.labels.nodes.map((l) => l.name),
    readyBy:
      issue.timelineItems.nodes.findLast((e) => e.label?.name === READY_LABEL)?.actor?.databaseId ??
      null,
  }));
}

export async function apply(repo: string, cards: Card[], action: Action): Promise<void> {
  if (action.kind === 'plan') {
    await rest('POST', `/repos/${repo}/issues/${action.issue}/labels`, {
      labels: [STAGE_LABELS.plan],
    });
    return;
  }
  const card = cards.find((c) => c.number === action.issue);
  if (!card) throw new Error(`#${action.issue} is not an open issue in ${repo}.`);
  await upsertStageComment(repo, action.issue, action.role, mention(stopped(action.role, action)));
  // Its trigger label would otherwise read as a plan in flight on every later tick.
  await removeLabel(repo, action.issue, STAGE_LABELS[action.role]);
  await setStatus(repo, card.nodeId, 'Needs you');
}

function describe(action: Action): string {
  return action.kind === 'plan'
    ? `#${action.issue}: add \`${STAGE_LABELS.plan}\`.`
    : `#${action.issue}: ${action.role} stopped at \`${action.stage}\`; move to Needs you.`;
}

/** One tick on `repo`. Each decision goes to stdout and the job summary, applied unless `dryRun`. */
export async function loop(repo: string, ran: Ran | undefined, dryRun: boolean): Promise<void> {
  const cards = await snapshot(repo);
  const { actions, skipped } = decide(cards, ran);
  const lines = [
    `### Board loop on ${repo}${dryRun ? ' (dry run)' : ''}`,
    ...(actions.length ? actions.map((a) => `- ${describe(a)}`) : ['- Nothing to do.']),
    ...skipped.map((s) => `- Skipped: ${s}`),
  ];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  if (dryRun) return;
  for (const action of actions) await apply(repo, cards, action);
}
