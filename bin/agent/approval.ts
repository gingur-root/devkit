// The dashboard's Continue as a build approval (devkit#99). Continue posts an
// App comment with a `continue` marker, then adds `agent:plan`. A plan that
// ends ready hands off by adding `agent:build` as the App. The
// admission expression lets the App add that label, so this file is
// the rest of the gate: the stage refuses an App label unless a Continue led
// straight to it, and each Continue starts one run only.

import {
  CONTINUE_ROLES,
  CONTINUE_WINDOW_MS,
  type Handoff,
  OPERATOR_ID,
  PIPELINE_BOT,
  STAGE_COMMANDS,
  STAGE_LABELS,
} from './constants.ts';
import { restAll } from './github.ts';
import { marker } from './job.ts';

/** A card's run history, oldest first: a dashboard Continue, or a stage started by a label or a command. */
export type Step =
  | { kind: 'continue'; at: string; to: Handoff }
  | { kind: 'start'; at: string; label: string; actor: number | null };

interface Comment {
  body: string | null;
  created_at: string;
  user: { id: number } | null;
}

interface Event {
  event: string;
  created_at: string;
  actor: { id: number } | null;
  label?: { name: string };
}

const STARTS = new Set<string>([STAGE_LABELS.plan, STAGE_LABELS.build]);
const HANDOFFS = Object.keys(CONTINUE_ROLES) as Handoff[];

/** The steps in a card's comments and issue events, oldest first. */
export function steps(comments: Comment[], events: Event[]): Step[] {
  const all: Step[] = [];
  for (const c of comments) {
    const body = c.body ?? '';
    // Only the App writes a Continue; anyone else's marker is text.
    const to =
      c.user?.id === PIPELINE_BOT.id &&
      HANDOFFS.find((h) => body.startsWith(marker(CONTINUE_ROLES[h])));
    if (to) all.push({ kind: 'continue', at: c.created_at, to });
    const command =
      c.user?.id === OPERATOR_ID &&
      (Object.keys(STAGE_COMMANDS) as (keyof typeof STAGE_COMMANDS)[]).find((k) =>
        body.startsWith(k),
      );
    if (command)
      all.push({
        kind: 'start',
        at: c.created_at,
        label: STAGE_COMMANDS[command],
        actor: OPERATOR_ID,
      });
  }
  for (const e of events) {
    if (e.event === 'labeled' && e.label && STARTS.has(e.label.name))
      all.push({
        kind: 'start',
        at: e.created_at,
        label: e.label.name,
        actor: e.actor?.id ?? null,
      });
  }
  // GitHub times are to the second, and Continue writes its comment before its
  // label, so on a tie the Continue comes first.
  return all.sort((a, b) => a.at.localeCompare(b.at) || (a.kind === 'continue' ? -1 : 1));
}

/** A Continue and the plan start it made: the start right after it, within the window. */
function continued(
  proof: Step | undefined,
  plan: Step | undefined,
): proof is Step & { kind: 'continue' } {
  return (
    proof?.kind === 'continue' &&
    plan?.kind === 'start' &&
    plan.label === STAGE_LABELS.plan &&
    Date.parse(plan.at) - Date.parse(proof.at) <= CONTINUE_WINDOW_MS
  );
}

/**
 * Where the plan now running may hand off: its start must be the latest step,
 * made by a Continue. Null means the plan stops in Needs you as before.
 */
export function armedContinue(history: Step[]): Handoff | null {
  const [proof, plan] = history.slice(-2);
  return continued(proof, plan) ? proof.to : null;
}

/**
 * Whether a build run may start: null if so, or why not. The
 * operator actor input needs his latest start to match this stage. The App
 * may only when its label is the latest step and follows a plan that a
 * matching Continue started, so a Continue is spent by
 * the first run after it.
 */
export function refuseStart(actor: number, history: Step[], handoff: Handoff): string | null {
  const label = STAGE_LABELS[handoff];
  if (actor === OPERATOR_ID) {
    const start = history.findLast((step) => step.kind === 'start');
    return start?.actor === OPERATOR_ID && start.label === label
      ? null
      : `the operator actor input needs his latest issue start to be \`${label}\``;
  }
  if (actor !== PIPELINE_BOT.id)
    return `only the operator or the pipeline App may add \`${label}\``;
  const [proof, plan, start] = history.slice(-3);
  const approved =
    start?.kind === 'start' &&
    start.label === label &&
    start.actor === PIPELINE_BOT.id &&
    continued(proof, plan) &&
    proof.to === handoff;
  return approved
    ? null
    : `the App added \`${label}\` without a dashboard Continue right before its plan. Each Continue starts one run; press Continue again`;
}

/** A card's history from GitHub. */
export async function readSteps(repo: string, issue: number): Promise<Step[]> {
  const path = `/repos/${repo}/issues/${issue}`;
  const [comments, events] = await Promise.all([
    restAll<Comment>(`${path}/comments`),
    restAll<Event>(`${path}/events`),
  ]);
  return steps(comments, events);
}
