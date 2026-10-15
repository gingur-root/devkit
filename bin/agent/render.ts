// Renders the job file and issue snapshot for one stage. The snapshot holds only
// text by the operator or the pipeline App, so nobody else can steer an agent.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readSteps, refuseStart } from './approval.ts';
import { type Handoff, OPERATOR_ID, RETRO_LABEL, STAGE_LABELS } from './constants.ts';
import { removeLabel, rest, restAll, upsertStageComment } from './github.ts';
import {
  CONTRACT_PREFIX,
  ISSUE_FILE,
  ISSUES_FILE,
  JOB_FILE,
  TIMELINE_FILE,
  type Job,
  marker,
  PLAN_END,
  PLAN_FILE,
  PLAN_START,
  PlanContract,
  revision,
  TRIAGE_FILE,
} from './job.ts';
import { ROLES, type RoleName } from './roles.ts';

interface Authored {
  body: string | null;
  user: { id: number } | null;
  performed_via_github_app?: { id: number } | null;
  created_at: string;
}

interface Comment extends Authored {
  body: string;
}

interface Event {
  event: string;
  created_at?: string;
  actor?: { login: string } | null;
  label?: { name: string };
}

export interface Issue extends Authored {
  number: number;
  title: string;
  labels: { name: string }[];
  pull_request?: unknown;
}

export interface RenderOptions {
  repo: string;
  issue: number;
  role: RoleName;
  /** Unset: the head of the repo's default branch, as a dispatched run reads it. */
  source?: string;
  /** A review's base: the commit the candidate was built from. */
  base?: string;
  appId: number;
  /** Who started the run (`github.actor_id`). A build or elevated run the App started needs a Continue (devkit#99). */
  actor?: number;
  out: string;
}

const HANDOFF_ROLES: readonly string[] = ['build', 'elevated'] satisfies Handoff[];

function trusted(item: Authored, appId: number): boolean {
  return item.user?.id === OPERATOR_ID || item.performed_via_github_app?.id === appId;
}

export function issueSnapshot(issue: Issue, comments: Authored[], appId: number): string {
  const head = trusted(issue, appId)
    ? `# ${issue.title}\n\n${issue.body ?? ''}`
    : `# Issue #${issue.number}\n\n(Written by someone else, so left out.)`;
  const thread = comments
    .filter((comment) => trusted(comment, appId))
    .map((comment) => `## Comment, ${comment.created_at}\n\n${comment.body ?? ''}`);
  return [head, ...thread].join('\n\n');
}

/** The card's history for a retro: one line per timeline event. Comments are in the snapshot. */
function timeline(events: Event[]): string {
  return events
    .filter((e) => e.event !== 'commented')
    .map(
      (e) =>
        `- ${e.created_at ?? ''} ${e.event}${e.label ? ` \`${e.label.name}\`` : ''}${e.actor ? ` by ${e.actor.login}` : ''}`,
    )
    .join('\n');
}

/** The repo's open issues a retro plan may link a finding to: only the operator's or the App's, as the snapshot. */
export function openIssues(issues: Issue[], appId: number): string {
  return issues
    .filter((i) => !i.pull_request && trusted(i, appId))
    .map((i) => `- #${i.number} ${i.title}${i.labels.map((l) => ` \`${l.name}\``).join('')}`)
    .join('\n');
}

/** Text between two markers in a comment, or null. */
function between(body: string, start: string, end: string): string | null {
  const from = body.indexOf(start);
  const to = body.indexOf(end, from + start.length);
  return from < 0 || to < 0 ? null : body.slice(from + start.length, to);
}

/**
 * The pipeline's plan comment, if it is ready, unedited, and for the issue as it is now.
 */
export function approvedPlan(
  comments: Authored[],
  appId: number,
  issueRevision: string,
): { plan: string; contract: PlanContract } {
  // The operator's own comment is the plan where his `gh` publishes (infra#47).
  const comment = comments.find(
    (c): c is Comment =>
      (c.performed_via_github_app?.id === appId || c.user?.id === OPERATOR_ID) &&
      !!c.body?.startsWith(marker('plan')),
  );
  if (!comment) throw new Error('No plan comment from the pipeline. Add `agent:plan` first.');
  const body = comment.body.replace(/\r\n/g, '\n');
  const plan = between(body, `${PLAN_START}\n`, `\n${PLAN_END}`);
  const json = between(body, CONTRACT_PREFIX, ' -->');
  if (plan === null || json === null) throw new Error('The plan comment has no plan or contract.');
  const contract = PlanContract.parse(JSON.parse(json));
  if (contract.outcome !== 'ready') throw new Error('The plan is not ready. Answer it first.');
  if (revision(plan) !== contract.planRevision)
    throw new Error('The plan text was edited after it was published. Run `agent:plan` again.');
  if (contract.issueRevision !== issueRevision)
    throw new Error('The issue changed after the plan. Run `agent:plan` again.');
  return { plan, contract };
}

/** Says on the issue why the stage won't start and drops its label, so a retry is just re-adding it. */
async function refuse(options: RenderOptions, reason: string): Promise<void> {
  const stage = `${options.role[0]?.toUpperCase()}${options.role.slice(1)}`;
  await upsertStageComment(
    options.repo,
    options.issue,
    options.role,
    `${marker(options.role)}\n\n**${stage} refused:** ${reason}`,
  );
  const label = STAGE_LABELS[options.role as keyof typeof STAGE_LABELS];
  if (label) await removeLabel(options.repo, options.issue, label);
}

export async function render(options: RenderOptions): Promise<Job> {
  const source =
    options.source ||
    (await rest<{ sha: string }>('GET', `/repos/${options.repo}/commits/HEAD`)).sha;
  const path = `/repos/${options.repo}/issues/${options.issue}`;
  const [issue, comments] = await Promise.all([
    rest<Issue>('GET', path),
    restAll<Authored>(`${path}/comments`),
  ]);
  const issueRevision = revision(issue.title, issue.body ?? '');
  const retroPlan =
    options.role === 'plan' && issue.labels.some((label) => label.name === RETRO_LABEL);
  // A retro reads whatever the run left, ready plan or not.
  let approved: ReturnType<typeof approvedPlan> | null = null;
  if (options.role !== 'plan' && options.role !== 'retro') {
    try {
      if (HANDOFF_ROLES.includes(options.role)) {
        // No actor fails closed: it is neither the operator nor the App.
        const why = refuseStart(
          options.actor ?? Number.NaN,
          await readSteps(options.repo, options.issue),
          options.role as Handoff,
        );
        if (why) throw new Error(`Not approved: ${why}.`);
      }
      approved = approvedPlan(comments, options.appId, issueRevision);
    } catch (error) {
      // The refusal itself still fails the job, even if saying so on the issue fails.
      await refuse(options, (error as Error).message).catch(console.error);
      throw error;
    }
  }
  const job: Job = {
    job: `${options.role}-${process.env.GITHUB_RUN_ID ?? 'local'}`,
    role: options.role,
    objective: ROLES[options.role].objective,
    repo: options.repo,
    issue: {
      number: issue.number,
      title: issue.title,
      revision: issueRevision,
    },
    plan: approved && {
      revision: approved.contract.planRevision,
      criteria: Object.keys(approved.contract.checks),
    },
    // A build works from the default branch as it is now, not the plan's older
    // source: the App can't push a branch whose workflow files differ from it.
    source,
    base: approved && (options.base ?? source),
    // A review checks out the candidate itself.
    candidate: options.role === 'review' ? source : null,
    // Publish reads this to hold a retro issue's plan to its triage.
    artifacts: retroPlan ? [ISSUES_FILE] : [],
    operations: [],
    attemptLimit: null,
  };
  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, JOB_FILE), `${JSON.stringify(job, null, 2)}\n`);
  writeFileSync(
    join(options.out, ISSUE_FILE),
    `${issueSnapshot(issue, comments, options.appId)}\n`,
  );
  if (approved) writeFileSync(join(options.out, PLAN_FILE), `${approved.plan}\n`);
  if (approved?.contract.triage)
    writeFileSync(join(options.out, TRIAGE_FILE), `${JSON.stringify(approved.contract.triage)}\n`);
  if (retroPlan)
    writeFileSync(
      join(options.out, ISSUES_FILE),
      `${openIssues(await restAll<Issue>(`/repos/${options.repo}/issues?state=open`), options.appId)}\n`,
    );
  if (options.role === 'retro')
    writeFileSync(
      join(options.out, TIMELINE_FILE),
      `${timeline(await restAll<Event>(`${path}/timeline`))}\n`,
    );
  return job;
}
