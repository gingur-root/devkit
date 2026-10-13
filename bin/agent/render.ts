// Renders the job file and issue snapshot for one stage. The snapshot holds only
// text by the operator or the pipeline App, so nobody else can steer an agent.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { OPERATOR_ID } from './constants.ts';
import { rest, restAll } from './github.ts';
import { ISSUE_FILE, JOB_FILE, type Job, revision } from './job.ts';
import { ROLES, type RoleName } from './roles.ts';

interface Authored {
  body: string | null;
  user: { id: number } | null;
  performed_via_github_app?: { id: number } | null;
  created_at: string;
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

export async function render(options: RenderOptions): Promise<Job> {
  const path = `/repos/${options.repo}/issues/${options.issue}`;
  const [issue, comments] = await Promise.all([
    rest<Issue>('GET', path),
    restAll<Authored>(`${path}/comments`),
  ]);
  const job: Job = {
    job: `${options.role}-${process.env.GITHUB_RUN_ID ?? 'local'}`,
    role: options.role,
    objective: ROLES[options.role].objective,
    repo: options.repo,
    issue: {
      number: issue.number,
      title: issue.title,
      revision: revision(issue.title, issue.body ?? ''),
    },
    plan: null,
    source: options.source,
    base: null,
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
  return job;
}
