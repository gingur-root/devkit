// The controller's write side for one stage: check the result against the live
// contract, upsert the stage's marker comment, remove the trigger label and
// move the card on. A build also pushes its candidate and opens a draft PR.
// Only this writes GitHub, and only with the App.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { setStatus } from './board.ts';
import { PIPELINE_BOT, STAGE_LABELS } from './constants.ts';
import { rest, restAll } from './github.ts';
import {
  CANDIDATE_FILE,
  CONTRACT_PREFIX,
  JOB_FILE,
  Job,
  marker,
  PLAN_END,
  PLAN_FILE,
  PLAN_START,
  type PlanContract,
  RESULT_FILE,
  revision,
} from './job.ts';
import { Result } from './result.ts';

export interface PublishOptions {
  in: string;
  out: string;
  /** A build's target repo, checked out at the job's source with push access. */
  checkout?: string;
}

interface Issue {
  node_id: string;
  title: string;
  body: string | null;
}

interface Comment {
  id: number;
  body: string | null;
  user: { type: string } | null;
}

interface Pull {
  number: number;
  html_url: string;
}

/** A result that may be published, or the stage it stopped at and why. */
type Verdict = { result: Result } | { stage: string; reason: string };

function verdict(job: Job, liveRevision: string, out: string): Verdict {
  const file = join(out, RESULT_FILE);
  if (!existsSync(file)) return { stage: job.role, reason: 'the agent ended without a result' };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { stage: 'validate', reason: `${RESULT_FILE} is not JSON` };
  }
  const parsed = Result.safeParse(json);
  if (!parsed.success) {
    console.error(parsed.error.message);
    return {
      stage: 'validate',
      // The first few, so the comment stays short; the job log has them all.
      reason: `${parsed.error.issues.length} schema errors, starting with ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `\`${i.path.join('.')}\` ${i.message}`)
        .join('; ')}`,
    };
  }
  const result = parsed.data;
  if (
    result.job !== job.job ||
    result.role !== job.role ||
    result.inputs.issue !== job.issue.revision ||
    (job.plan !== null && result.inputs.plan !== job.plan.revision)
  ) {
    return {
      stage: 'contract',
      reason: 'the result is for a different job, issue revision or plan',
    };
  }
  if (liveRevision !== job.issue.revision) {
    return {
      stage: 'contract',
      reason: `the issue changed while the ${job.role} ran, so the result is stale`,
    };
  }
  if (result.status === 'complete' && job.role === 'plan' && !existsSync(join(out, PLAN_FILE))) {
    return { stage: 'validate', reason: `the agent wrote no ${PLAN_FILE}` };
  }
  if (result.status !== 'complete' && result.outcome !== null) {
    return {
      stage: 'validate',
      reason: `a ${result.status} run set outcome \`${result.outcome}\``,
    };
  }
  const candidate = join(out, CANDIDATE_FILE);
  if (
    result.outcome === 'implemented' &&
    !(existsSync(candidate) && statSync(candidate).size > 0)
  ) {
    return { stage: 'validate', reason: 'the build reported `implemented` but changed nothing' };
  }
  return { result };
}

function stopped(job: Job, v: { stage: string; reason: string }): string {
  return [
    marker(job.role),
    `**${job.role === 'plan' ? 'Plan' : 'Build'} stopped at \`${v.stage}\`:** ${v.reason}.`,
    `Fix the cause, then add \`${STAGE_LABELS[job.role as keyof typeof STAGE_LABELS]}\` again.`,
  ].join('\n\n');
}

function numbered(questions: string[]): string {
  return questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
}

function planComment(job: Job, result: Result, out: string): string {
  const planFile = join(out, PLAN_FILE);
  const plan = existsSync(planFile) ? readFileSync(planFile, 'utf8').trim() : '';
  const head =
    result.status === 'complete'
      ? `**Plan: ${result.outcome === 'ready' ? 'ready: reply `/approve` to build it' : 'needs your input'}**`
      : `**Plan ${result.status}**`;
  const contract: PlanContract = {
    planRevision: revision(plan),
    outcome: result.outcome,
    source: job.source,
    issueRevision: job.issue.revision,
    checks: Object.fromEntries((result.criteria ?? []).map((c) => [c.id, c.check])),
    critique: result.critique,
  };
  return [
    marker(job.role),
    head,
    result.summary,
    numbered(result.questions),
    `${PLAN_START}\n${plan}\n${PLAN_END}`,
    `${CONTRACT_PREFIX}${JSON.stringify(contract)} -->`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildComment(result: Result, pull: Pull | null): string {
  const head = pull
    ? `**Build: [#${pull.number}](${pull.html_url}) is ready for review**`
    : `**Build ${result.status}**`;
  return [marker('build'), head, result.summary, numbered(result.questions)]
    .filter(Boolean)
    .join('\n\n');
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: PIPELINE_BOT.name,
      GIT_AUTHOR_EMAIL: PIPELINE_BOT.email,
      GIT_COMMITTER_NAME: PIPELINE_BOT.name,
      GIT_COMMITTER_EMAIL: PIPELINE_BOT.email,
    },
  }).trim();
}

/**
 * Commits the candidate on top of the issue's branch, or on the source when the
 * branch is new, so a retry is a plain fast-forward push.
 * shortcut: a retry after the default branch changed a workflow file is
 * rejected (the App has no `workflows` permission); close the PR and delete the
 * branch first. Rebuild the branch instead if that happens often.
 */
function pushCandidate(job: Job, checkout: string, patch: string): string {
  const branch = `agent/issue-${job.issue.number}`;
  git(checkout, ['apply', '--index', patch]);
  const tree = git(checkout, ['write-tree']);
  let parent = job.source;
  if (git(checkout, ['ls-remote', '--heads', 'origin', branch])) {
    git(checkout, ['fetch', '--depth=1', 'origin', branch]);
    parent = git(checkout, ['rev-parse', 'FETCH_HEAD']);
  }
  const message = `${job.issue.title}\n\nCloses #${job.issue.number}`;
  const commit = git(checkout, ['commit-tree', tree, '-p', parent, '-m', message]);
  git(checkout, ['push', 'origin', `${commit}:refs/heads/${branch}`]);
  return branch;
}

/** The branch's open PR with this body, opened as a draft when there is none. */
async function upsertPull(job: Job, branch: string, result: Result): Promise<Pull> {
  const body = [
    `Closes #${job.issue.number}.`,
    result.summary,
    result.evidence
      .map((e) => `- ${e.criterion ?? 'Check'} ${e.result}: \`${e.check}\``)
      .join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
  const owner = job.repo.slice(0, job.repo.indexOf('/'));
  const [open] = await rest<Pull[]>(
    'GET',
    `/repos/${job.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
  );
  if (open) return rest<Pull>('PATCH', `/repos/${job.repo}/pulls/${open.number}`, { body });
  const { default_branch } = await rest<{ default_branch: string }>('GET', `/repos/${job.repo}`);
  return rest<Pull>('POST', `/repos/${job.repo}/pulls`, {
    title: job.issue.title,
    head: branch,
    base: default_branch,
    body,
    draft: true,
  });
}

export async function publish(options: PublishOptions): Promise<void> {
  const job = Job.parse(JSON.parse(readFileSync(join(options.in, JOB_FILE), 'utf8')));
  const path = `/repos/${job.repo}/issues/${job.issue.number}`;
  const issue = await rest<Issue>('GET', path);
  let v = verdict(job, revision(issue.title, issue.body ?? ''), options.out);

  let pull: Pull | null = null;
  if ('result' in v && v.result.outcome === 'implemented') {
    try {
      if (!options.checkout) throw new Error('publish needs --checkout for a build.');
      const branch = pushCandidate(job, options.checkout, join(options.out, CANDIDATE_FILE));
      pull = await upsertPull(job, branch, v.result);
    } catch (error) {
      console.error(error);
      v = {
        stage: 'publish',
        reason: 'pushing the change or opening its PR failed; see the run log',
      };
    }
  }

  let body: string;
  if ('stage' in v) body = stopped(job, v);
  else if (job.role === 'plan') body = planComment(job, v.result, options.out);
  else body = buildComment(v.result, pull);

  // One comment per stage, found by its marker and written by a bot (the App).
  const comments = await restAll<Comment>(`${path}/comments`);
  const existing = comments.find(
    (c) => c.user?.type === 'Bot' && c.body?.startsWith(marker(job.role)),
  );
  if (existing) await rest('PATCH', `/repos/${job.repo}/issues/comments/${existing.id}`, { body });
  else await rest('POST', `${path}/comments`, { body });

  const label = STAGE_LABELS[job.role as keyof typeof STAGE_LABELS];
  await rest('DELETE', `${path}/labels/${encodeURIComponent(label)}`).catch((error: Error) => {
    // A `/plan` comment run has no label to remove.
    if (!error.message.includes(' 404 ')) throw error;
  });
  await setStatus(job.repo, issue.node_id, pull ? 'Ready' : 'Needs you');

  if ('stage' in v) process.exitCode = 1;
}
