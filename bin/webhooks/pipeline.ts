// Starts pipeline stages for any gingur-root repo (devkit#118), so a repo needs
// no `agents.yml`. The receiver applies the admission rule
// (.github/admission.txt) to the event's sender, then dispatches the one
// central caller in gingur-root/pipeline. Admission in devkit's reusable
// workflows admits the App's dispatch and Troy's own dispatch. This file is
// the gate for every webhook-started run.
import {
  OPERATOR_ID,
  PIPELINE_BOT,
  READY_LABEL,
  STAGE_COMMANDS,
  STAGE_LABELS,
} from '../agent/constants.ts';
import { rest } from '../agent/github.ts';
import { refreshGhToken } from '../dashboard/app-token.ts';
import { ORG } from '../dashboard/constants.ts';
import { GITHUB_EVENT } from './constants.ts';
import type { Delivery, WebhookHandler } from './receiver.ts';

export const PIPELINE_REPO = 'pipeline';
export const PIPELINE_WORKFLOW = 'agents.yml';
// infra keeps its own caller on the WSL desk: the App must never reach it (infra#47).
const SKIPPED_REPOS: readonly string[] = ['infra', PIPELINE_REPO];

export const DISPATCH_STAGES = ['plan', 'build', 'elevated', 'loop'] as const;
export type DispatchStage = (typeof DISPATCH_STAGES)[number];

// Troy's labels. agent:research is admitted too, but no stage handles it yet.
const OPERATOR_LABELS: Record<string, DispatchStage> = {
  [STAGE_LABELS.plan]: 'plan',
  [STAGE_LABELS.build]: 'build',
  [STAGE_LABELS.elevated]: 'elevated',
  [READY_LABEL]: 'loop',
};
// The App's hand-offs: the board loop's plan, and a plan's build or elevated after a Continue, which render checks.
const APP_LABELS: Record<string, DispatchStage> = {
  [STAGE_LABELS.plan]: 'plan',
  [STAGE_LABELS.build]: 'build',
  [STAGE_LABELS.elevated]: 'elevated',
};
// /revise is admitted too, but no stage handles it yet.
const COMMANDS = Object.fromEntries(
  Object.entries(STAGE_COMMANDS).map(([command, label]) => [command, OPERATOR_LABELS[label]]),
);

export interface Dispatch {
  stage: DispatchStage;
  repo: string;
  issue: number;
  /** The event's sender, which render's Continue check reads as the run's actor. */
  actor: number;
}

interface Payload {
  action?: string;
  sender?: { id?: number };
  repository?: { name?: string; owner?: { login?: string } };
  issue?: { number?: number; pull_request?: unknown };
  label?: { name?: string };
  comment?: { body?: string };
}

/** The stage a delivery starts, or null. The same rule as the Actions admission gate. */
export function dispatchFor({ event, payload }: Delivery): Dispatch | null {
  const { action, sender, repository, issue, label, comment } = payload as Payload;
  const repo = repository?.name;
  if (repository?.owner?.login !== ORG || !repo || SKIPPED_REPOS.includes(repo)) return null;
  if (!issue?.number || !sender?.id) return null;
  let stage: DispatchStage | undefined;
  if (event === GITHUB_EVENT.issues && action === 'labeled' && label?.name) {
    if (sender.id === OPERATOR_ID) stage = OPERATOR_LABELS[label.name];
    else if (sender.id === PIPELINE_BOT.id) stage = APP_LABELS[label.name];
  } else if (
    event === GITHUB_EVENT.issueComment &&
    action === 'created' &&
    sender.id === OPERATOR_ID &&
    !issue.pull_request
  ) {
    const command = Object.keys(COMMANDS).find((c) => comment?.body?.startsWith(c));
    stage = command ? COMMANDS[command] : undefined;
  }
  return stage ? { stage, repo, issue: issue.number, actor: sender.id } : null;
}

/** Dispatches the central caller for one stage. */
export async function dispatch({ stage, repo, issue, actor }: Dispatch): Promise<void> {
  await refreshGhToken();
  await rest(
    'POST',
    `/repos/${ORG}/${PIPELINE_REPO}/actions/workflows/${PIPELINE_WORKFLOW}/dispatches`,
    { ref: 'main', inputs: { stage, repo, issue: String(issue), actor: String(actor) } },
  );
  console.log(`Dispatched ${stage} for ${repo}#${issue} (actor ${actor}).`);
}

/** The receiver's handler: dispatch whatever stage a delivery starts. */
export function pipelineHandler(): WebhookHandler {
  return async (delivery) => {
    const next = dispatchFor(delivery);
    if (next) await dispatch(next);
  };
}
