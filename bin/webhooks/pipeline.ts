// Starts pipeline stages for any gingur-root repo (devkit#118), so a repo needs
// no `agents.yml`. The receiver applies the admission rule
// (.github/admission.txt) to the event's sender, then dispatches the one
// central caller in gingur-root/pipeline. Admission in devkit's reusable
// workflows admits the App's dispatch and Troy's own dispatch. This file is
// the gate for every webhook-started run.
import {
  OPERATOR_ID,
  HELD_LABEL,
  PIPELINE_BOT,
  READY_LABEL,
  STAGE_COMMANDS,
  STAGE_LABELS,
} from '../agent/constants.ts';
import { setStatus } from '../agent/board.ts';
import { rest, restAll, removeLabel, type Comment } from '../agent/github.ts';
import { markHeld, parseHeld, retry } from '../agent/hold.ts';
import { marker } from '../agent/job.ts';
import { react } from '../agent/reactions.ts';
import { refreshGhToken } from '../dashboard/app-token.ts';
import { ORG } from '../dashboard/constants.ts';
import { GITHUB_EVENT, type Dispatch, type DispatchStage } from './constants.ts';
export { DISPATCH_STAGES, type Dispatch, type DispatchStage } from './constants.ts';
import type { Delivery, WebhookHandler } from './receiver.ts';

export const PIPELINE_REPO = 'pipeline';
export const PIPELINE_WORKFLOW = 'agents.yml';
// Memory PRs in pipeline must not trigger another memory run.
const SKIPPED_REPOS: readonly string[] = [PIPELINE_REPO];

// Troy's labels.
const OPERATOR_LABELS: Record<string, DispatchStage> = {
  [STAGE_LABELS.research]: 'research',
  [STAGE_LABELS.plan]: 'plan',
  [STAGE_LABELS.build]: 'build',
  [READY_LABEL]: 'loop',
};
// The App's hand-offs: the board loop's plan, and a plan's build after a Continue, which render checks.
const APP_LABELS: Record<string, DispatchStage> = {
  [STAGE_LABELS.plan]: 'plan',
  [STAGE_LABELS.build]: 'build',
};
// /revise is admitted too, but no stage handles it yet.
const COMMANDS = Object.fromEntries(
  Object.entries(STAGE_COMMANDS).map(([command, label]) => [command, OPERATOR_LABELS[label]]),
);

interface Payload {
  action?: string;
  sender?: { id?: number };
  repository?: { name?: string; owner?: { login?: string }; default_branch?: string };
  issue?: { number?: number; pull_request?: unknown };
  pull_request?: { number?: number; merged?: boolean; base?: { ref?: string } };
  label?: { name?: string };
  comment?: { id?: number; body?: string };
}

/** The stage a delivery starts, or null. The same rule as the Actions admission gate. */
export function dispatchFor({ event, payload }: Delivery): Dispatch | null {
  const { action, sender, repository, issue, label, comment, pull_request } = payload as Payload;
  const repo = repository?.name;
  if (repository?.owner?.login !== ORG || !repo || SKIPPED_REPOS.includes(repo)) return null;
  if (event === GITHUB_EVENT.pullRequest) {
    if (
      action !== 'closed' ||
      pull_request?.merged !== true ||
      !pull_request.number ||
      // A stacked PR merged into its parent branch isn't on main yet; the parent's merge runs it.
      pull_request.base?.ref !== repository.default_branch ||
      (sender?.id !== OPERATOR_ID && sender?.id !== PIPELINE_BOT.id)
    )
      return null;
    return { stage: 'memory', repo, issue: pull_request.number, actor: sender.id };
  }
  if (!issue?.number || !sender?.id) return null;
  let stage: DispatchStage | undefined;
  let started: number | undefined;
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
    started = comment?.id;
  }
  if (!stage) return null;
  return {
    stage,
    repo,
    issue: issue.number,
    actor: sender.id,
    ...(started === undefined ? {} : { comment: started }),
  };
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

/**
 * The receiver's handler: dispatch whatever stage a delivery starts, then add
 * its 👀 here, since the dispatch can't carry the comment. A loop tick is not a
 * run with a receipt.
 */
export async function pipelineHandler(): Promise<WebhookHandler> {
  const cards = new Map<
    string,
    { repo: string; issue: number; held: NonNullable<ReturnType<typeof parseHeld>> }
  >();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();
  const activeHold = () =>
    Math.max(0, ...[...cards.values()].map(({ held }) => Date.parse(held.until)));

  function enqueue(task: () => Promise<void>): Promise<void> {
    const pending = queue.then(task);
    queue = pending.catch(() => {});
    return pending;
  }

  function arm(delay = activeHold() - Date.now()): void {
    clearTimeout(timer);
    if (!cards.size) return;
    timer = setTimeout(
      () => {
        void enqueue(resume).catch((error: unknown) => {
          console.error('Held work could not resume:', error);
          arm(60_000);
        });
      },
      Math.max(1, delay),
    );
    timer.unref();
  }

  async function readHeld(repo: string, issue: number): Promise<void> {
    const key = `${repo}#${issue}`;
    const held = parseHeld(
      await restAll<Comment>(`/repos/${ORG}/${repo}/issues/${issue}/comments`),
    );
    if (held) cards.set(key, { repo, issue, held });
    else cards.delete(key);
  }

  async function resume(): Promise<void> {
    await refreshGhToken();
    // Include closed PRs: held memory dispatches belong to merged PRs.
    const targets = new Map(
      [...cards].map(([key, card]) => [key, { repo: card.repo, issue: card.issue }]),
    );
    for (let page = 1; ; page++) {
      const { items } = await rest<{ items: { number: number; repository_url: string }[] }>(
        'GET',
        `/search/issues?q=${encodeURIComponent(`org:${ORG} label:${HELD_LABEL}`)}&per_page=100&page=${page}`,
      );
      for (const item of items) {
        const repo = item.repository_url.split('/').at(-1)!;
        targets.set(`${repo}#${item.number}`, { repo, issue: item.number });
      }
      if (items.length < 100) break;
    }
    for (const { repo, issue } of targets.values()) await readHeld(repo, issue);
    // A newer account-wide reset also holds cards whose original reset has passed.
    if (activeHold() > Date.now()) return arm();
    for (const [key, { repo, issue, held }] of cards) {
      const next = held.dispatch;
      let message = retry('build') + ' to run it.';
      let needsYou = false;
      if (held.state === 'replaying') {
        message = `the ${next?.stage ?? 'stage'} replay's outcome is unknown. Check the card's runs, then ${retry(next?.stage ?? 'build')} if none started.`;
        needsYou = true;
      } else if (next) {
        if (
          (next.actor !== OPERATOR_ID && next.actor !== PIPELINE_BOT.id) ||
          next.repo !== repo ||
          next.issue !== issue ||
          SKIPPED_REPOS.includes(repo) ||
          next.stage === 'loop'
        ) {
          message = 'replay refused: untrusted actor or dispatch target; retry the stage manually.';
        } else {
          const { comment, ...attempt } = held;
          await rest('PATCH', `/repos/${ORG}/${repo}/issues/comments/${comment}`, {
            body: `${marker('held')}\n\n<!-- devkit:held ${JSON.stringify({ ...attempt, state: 'replaying' })} -->`,
          });
          try {
            await dispatch(next);
            message = `started ${next.stage}.`;
          } catch (error) {
            message = `dispatch failed: ${error instanceof Error ? error.message : String(error)}; ${retry(next.stage)} to retry.`;
            needsYou = true;
          }
        }
      }
      if (needsYou) {
        const card = await rest<{ node_id: string }>(
          'GET',
          `/repos/${ORG}/${repo}/issues/${issue}`,
        );
        await setStatus(`${ORG}/${repo}`, card.node_id, 'Needs you');
      }
      await removeLabel(`${ORG}/${repo}`, issue, HELD_LABEL);
      await rest('PATCH', `/repos/${ORG}/${repo}/issues/comments/${held.comment}`, {
        body: `${marker('held')}\n\nHold ended ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC; ${message}`,
      });
      cards.delete(key);
    }
    arm();
  }

  await resume();
  return (delivery) =>
    enqueue(async () => {
      const { action, sender, repository, label, issue, pull_request } =
        delivery.payload as Payload;
      const number = issue?.number ?? pull_request?.number;
      if (
        (delivery.event === GITHUB_EVENT.issues || delivery.event === GITHUB_EVENT.pullRequest) &&
        action === 'labeled' &&
        label?.name === HELD_LABEL &&
        sender?.id === PIPELINE_BOT.id &&
        repository?.owner?.login === ORG &&
        repository.name &&
        number
      ) {
        await refreshGhToken();
        await readHeld(repository.name, number);
        arm();
      }
      const next = dispatchFor(delivery);
      if (!next) return;
      if (next.stage !== 'loop' && activeHold() > Date.now()) {
        await refreshGhToken();
        const until = new Date(activeHold()).toISOString();
        await markHeld(
          `${ORG}/${next.repo}`,
          next.issue,
          { until, dispatch: next, state: 'held' },
          next.stage,
        );
        await readHeld(next.repo, next.issue);
        arm();
      } else await dispatch(next);
      if (next.stage !== 'loop' && next.stage !== 'memory')
        await react(`${ORG}/${next.repo}`, next.issue, next.comment);
    });
}
