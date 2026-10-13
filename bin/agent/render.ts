// Renders the job file and issue snapshot for one stage. The snapshot holds only
// text by the operator or the pipeline App, so nobody else can steer an agent.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { OPERATOR_ID } from './constants.ts';
import { rest, restAll } from './github.ts';
import {
  CONTRACT_PREFIX,
  ISSUE_FILE,
  JOB_FILE,
  type Job,
  marker,
  PLAN_END,
  PLAN_FILE,
  PLAN_START,
  PlanContract,
  revision,
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

interface Issue extends Authored {
  number: number;
  title: string;
}

export interface RenderOptions {
  repo: string;
  issue: number;
  role: RoleName;
  source: string;
  appId: number;
  out: string;
}

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

/** Text between two markers in a comment, or null. */
function between(body: string, start: string, end: string): string | null {
  const from = body.indexOf(start);
  const to = body.indexOf(end, from + start.length);
  return from < 0 || to < 0 ? null : body.slice(from + start.length, to);
}

/**
 * The App's plan comment, if it is ready, unedited, and for the issue as it is now.
 * shortcut: a missing or stale plan fails the Start job with no issue comment;
 * comment instead once someone other than the operator adds `agent:build`.
 */
export function approvedPlan(
  comments: Authored[],
  appId: number,
  issueRevision: string,
): { plan: string; contract: PlanContract } {
  const comment = comments.find(
    (c): c is Comment =>
      c.performed_via_github_app?.id === appId && !!c.body?.startsWith(marker('plan')),
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

export async function render(options: RenderOptions): Promise<Job> {
  const path = `/repos/${options.repo}/issues/${options.issue}`;
  const [issue, comments] = await Promise.all([
    rest<Issue>('GET', path),
    restAll<Authored>(`${path}/comments`),
  ]);
  const issueRevision = revision(issue.title, issue.body ?? '');
  const approved =
    options.role === 'build' ? approvedPlan(comments, options.appId, issueRevision) : null;
  const source = approved?.contract.source ?? options.source;
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
    // A build works from the commit the plan was made on.
    source,
    base: approved && source,
    candidate: null,
    artifacts: [],
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
  return job;
}
