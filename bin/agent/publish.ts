// The controller's write side for one stage: check the result against the live
// contract, upsert the stage's marker comment, remove the trigger label and
// move the card on. A build also pushes its candidate and opens a draft PR; a
// review posts on that PR and marks it ready when it passes, or hands its
// findings to a repair, which pushes a fix to the same PR. The pipeline never
// merges. A retro only adds its one comment. Only this writes GitHub, and only
// with the App.

import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { git } from '../git.ts';
import { setStatus } from './board.ts';
import {
  OPERATOR_LOGIN,
  PIPELINE_BOT,
  REPAIR_ROUNDS,
  STAGE_LABELS,
  type Status,
} from './constants.ts';
import { graphql, removeLabel, rest, upsertStageComment } from './github.ts';
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
  TRANSCRIPT_FILE,
  usage,
} from './job.ts';
import { uploadRecords } from './records.ts';
import { type Failure, Result } from './result.ts';

export interface PublishOptions {
  in: string;
  out: string;
  /** A build's target repo, checked out at the job's source with push access. */
  checkout?: string;
  /** A review's repair round: 0 reviews the build, n the nth repair. */
  round?: number;
}

interface Issue {
  node_id: string;
  title: string;
  body: string | null;
}

interface Pull {
  number: number;
  html_url: string;
  node_id: string;
  head: { sha: string };
}

/** What a stage publishes: the issue comment, the card's Status, and whether it stopped. */
interface Outcome {
  body: string;
  status: Status;
  stopped: boolean;
}

/** A result that may be published, or the stage it stopped at and why. */
type Verdict = { result: Result } | { stage: string; reason: string };

export function verdict(job: Job, liveRevision: string, out: string): Verdict {
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
  // The CLI's own failure says more than any later check could (devkit#14).
  if (result.failure)
    return { stage: job.role, reason: failureReason(result.failure, result.summary) };
  if (
    result.job !== job.job ||
    result.role !== job.role ||
    result.inputs.issue !== job.issue.revision ||
    (job.plan !== null && result.inputs.plan !== job.plan.revision) ||
    (job.candidate !== null && result.inputs.candidate !== job.candidate)
  ) {
    return {
      stage: 'contract',
      reason: 'the result is for a different job, issue revision, plan or candidate',
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
    return {
      stage: 'validate',
      reason: `the ${job.role} reported \`implemented\` but changed nothing`,
    };
  }
  return { result };
}

/** The failure class, a rate limit's reset time, and the summary's account of it. */
export function failureReason(failure: Failure, summary: string): string {
  const resets = failure.resetsAt
    ? `, resets ${failure.resetsAt.slice(0, 16).replace('T', ' ')} UTC`
    : failure.class === 'rate_limit'
      ? ', reset time unknown'
      : '';
  return `\`${failure.class}\`${resets}: ${summary.replace(/\.$/, '')}`;
}

function retry(role: string): string {
  if (role === 'plan' || role === 'elevated') return `add \`${STAGE_LABELS[role]}\``;
  return 'reply `/approve`';
}

export function stopped(role: string, v: { stage: string; reason: string }): string {
  return [
    marker(role),
    `**${role[0]?.toUpperCase()}${role.slice(1)} stopped at \`${v.stage}\`:** ${v.reason}.`,
    `Fix the cause, then ${retry(role)} again.`,
  ].join('\n\n');
}

/** A comment that leaves the card waiting on the operator mentions him, so he hears of it then. */
export function mention(body: string): string {
  return `${body}\n\n@${OPERATOR_LOGIN}`;
}

function numbered(questions: string[]): string {
  return questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
}

function planComment(job: Job, result: Result, out: string): string {
  const planFile = join(out, PLAN_FILE);
  const plan = existsSync(planFile) ? readFileSync(planFile, 'utf8').trim() : '';
  const head =
    result.status === 'complete'
      ? `**Plan: ${result.outcome === 'ready' ? 'ready: reply `/approve` to build it, or add `agent:elevated` to run it on the WSL desk' : 'needs your input'}**`
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

function buildComment(job: Job, result: Result, pull: Pull | null): string {
  const stage =
    job.role === 'elevated' ? 'Elevated run' : job.role === 'repair' ? 'Repair' : 'Build';
  const link = pull && `[#${pull.number}](${pull.html_url})`;
  const head = !link
    ? `**${stage} ${result.status}**`
    : job.role === 'repair'
      ? `**Repair: pushed a fix to ${link}; reviewing it again**`
      : `**${stage}: ${link} is ready for review**`;
  return [marker(job.role), head, result.summary, numbered(result.questions)]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Commits the candidate on top of the issue's branch, or on the source when the
 * branch is new, so a retry is a plain fast-forward push. A repair commits on
 * the commit it fixed, so a branch that moved since rejects the push.
 * shortcut: a retry after the default branch changed a workflow file is
 * rejected (the App has no `workflows` permission); close the PR and delete the
 * branch first. Rebuild the branch instead if that happens often.
 */
function pushCandidate(
  job: Job,
  checkout: string,
  patch: string,
): { branch: string; commit: string } {
  const branch = branchOf(job);
  git(checkout, ['apply', '--index', patch]);
  const tree = git(checkout, ['write-tree']);
  let parent = job.source;
  if (job.role !== 'repair' && git(checkout, ['ls-remote', '--heads', 'origin', branch])) {
    git(checkout, ['fetch', '--depth=1', 'origin', branch]);
    parent = git(checkout, ['rev-parse', 'FETCH_HEAD']);
  }
  const message =
    job.role === 'repair'
      ? `Fix review findings for #${job.issue.number}`
      : `${job.issue.title}\n\nCloses #${job.issue.number}`;
  const commit = git(checkout, ['commit-tree', tree, '-p', parent, '-m', message], PIPELINE_BOT);
  git(checkout, ['push', 'origin', `${commit}:refs/heads/${branch}`]);
  return { branch, commit };
}

function branchOf(job: Job): string {
  return `agent/issue-${job.issue.number}`;
}

async function openPull(job: Job, branch: string): Promise<Pull | undefined> {
  const owner = job.repo.slice(0, job.repo.indexOf('/'));
  const [open] = await rest<Pull[]>(
    'GET',
    `/repos/${job.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
  );
  return open;
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
  const open = await openPull(job, branch);
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

/** A review that hands the PR to the operator: pass on every axis, nothing blocking, nothing to ask. */
export function passes(result: Result): boolean {
  return (
    result.outcome === 'pass' &&
    result.axes !== null &&
    Object.values(result.axes).every((axis) => axis === 'pass') &&
    !(result.findings ?? []).some((finding) => finding.blocking) &&
    result.questions.length === 0
  );
}

function reviewText(result: Result): string {
  const axes = result.axes
    ? ` (${Object.entries(result.axes)
        .map(([axis, outcome]) => `${axis} ${outcome}`)
        .join(', ')})`
    : '';
  const findings = (result.findings ?? [])
    .map((f) => {
      const where = f.path ? `, \`${f.path}${f.line ? `:${f.line}` : ''}\`` : '';
      return `- **${f.id}** ${f.blocking ? 'blocking' : 'advisory'}, ${f.axis}${where}: ${f.scenario} ${f.impact} Fix: ${f.fix}`;
    })
    .join('\n');
  return [
    `**Review: ${result.outcome}**${axes}`,
    result.summary,
    findings,
    numbered(result.questions),
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function publishReview(job: Job, v: Verdict, round: number): Promise<Outcome> {
  if ('result' in v) {
    const pull = await openPull(job, branchOf(job));
    if (!pull) v = { stage: 'publish', reason: 'the build has no open PR' };
    else if (pull.head.sha !== job.candidate)
      v = { stage: 'contract', reason: 'the PR has a newer commit than the one reviewed' };
    else return postReview(job, v.result, pull, round);
  }
  return { body: stopped(job.role, v), status: 'Needs you', stopped: true };
}

/** A review Codex may answer: changes requested, findings to fix, nothing for the operator to decide. */
export function repairable(result: Result): boolean {
  return (
    result.outcome === 'changes-requested' &&
    (result.findings ?? []).length > 0 &&
    result.questions.length === 0
  );
}

/**
 * Posts the review on the PR. A pass marks it ready for the operator to merge;
 * a repairable review with rounds left sets the `repair` output for the next round.
 */
async function postReview(job: Job, result: Result, pull: Pull, round: number): Promise<Outcome> {
  await rest('POST', `/repos/${job.repo}/pulls/${pull.number}/reviews`, {
    commit_id: pull.head.sha,
    body: reviewText(result),
    event: 'COMMENT',
  });
  const ok = passes(result);
  const repair = !ok && round < REPAIR_ROUNDS && repairable(result);
  if (repair && process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, 'repair=true\n');
  if (ok)
    await graphql(
      `
        mutation ($id: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $id }) {
            clientMutationId
          }
        }
      `,
      { id: pull.node_id },
    );
  const link = `[#${pull.number}](${pull.html_url})`;
  const head = ok
    ? `**Review: passed. ${link} is ready to merge**`
    : repair
      ? `**Review: ${link} needs changes. Codex is fixing them (round ${round + 1} of ${REPAIR_ROUNDS})**`
      : `**Review: ${link} needs your call${round > 0 ? ` after ${round} repair round${round > 1 ? 's' : ''}` : ''}**`;
  return {
    body: [marker('review'), head, result.summary, numbered(result.questions)]
      .filter(Boolean)
      .join('\n\n'),
    status: ok ? 'Ready' : repair ? 'Building' : 'Needs you',
    stopped: false,
  };
}

async function publishBuildOrPlan(
  job: Job,
  v: Verdict,
  out: string,
  checkout: string | undefined,
): Promise<Outcome> {
  let pull: Pull | null = null;
  if ('result' in v && v.result.outcome === 'implemented') {
    try {
      if (!checkout) throw new Error('publish needs --checkout for a build.');
      const { branch, commit } = pushCandidate(job, checkout, join(out, CANDIDATE_FILE));
      // A repair keeps the build's PR text; its summary goes on the issue comment.
      pull =
        job.role === 'repair'
          ? ((await openPull(job, branch)) ?? null)
          : await upsertPull(job, branch, v.result);
      // The review job's input.
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, `candidate=${commit}\n`);
    } catch (error) {
      console.error(error);
      v = {
        stage: 'publish',
        reason: 'pushing the change or opening its PR failed; see the run log',
      };
    }
  }
  // A repair's card stays in Building until its review lands.
  const status = !pull ? 'Needs you' : job.role === 'repair' ? 'Building' : 'Ready';
  if ('stage' in v) return { body: stopped(job.role, v), status, stopped: true };
  const body =
    job.role === 'plan' ? planComment(job, v.result, out) : buildComment(job, v.result, pull);
  return { body, status, stopped: false };
}

/**
 * A retro's findings, each with the fix it suggests, as a new comment: one per
 * run. It never touches labels or the card, and a failed retro posts nothing,
 * so it can't loop.
 */
export function retroComment(result: Result, runUrl: string): string {
  const findings = (result.followups ?? []).map((f) => `- **${f.title}:** ${f.body}`).join('\n');
  return [
    marker('retro'),
    `**Retro on [this run](${runUrl})**. These are suggestions only: plan any you want with a new issue.`,
    result.summary,
    findings,
    numbered(result.questions),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The stage's name in the run summary: its role, and its round when it repeats. */
export function stageName(role: string, round = 0): string {
  return round > 0 ? `${role}.r${round}` : role;
}

/** Adds the stage's token use to the run summary (devkit#10). */
function summarizeUsage(stage: string, out: string): void {
  const transcript = join(out, TRANSCRIPT_FILE);
  if (!process.env.GITHUB_STEP_SUMMARY || !existsSync(transcript)) return;
  const { input, output } = usage(readFileSync(transcript, 'utf8'));
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `**\`${stage}\` tokens:** ${input.toLocaleString('en-US')} input, ${output.toLocaleString('en-US')} output.\n`,
  );
}

/** Saves the stage's job and output to R2 and names the key prefix in the run summary. */
async function saveRecords(job: Job, stage: string, options: PublishOptions): Promise<void> {
  const prefix = `${job.repo}/${job.issue.number}/${process.env.GITHUB_RUN_ID ?? 'local'}/${stage}`;
  let line: string;
  try {
    const url = await uploadRecords(process.env.R2_RUNS, prefix, {
      in: options.in,
      out: options.out,
    });
    if (!url) return;
    line = `**Run records:** \`${url}\``;
  } catch (error) {
    // A lost record must not fail the stage it records.
    console.error(error);
    line = '**Run records:** the upload failed; see the publish log.';
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

export async function publish(options: PublishOptions): Promise<void> {
  const job = Job.parse(JSON.parse(readFileSync(join(options.in, JOB_FILE), 'utf8')));
  const stage = stageName(job.role, options.round);
  summarizeUsage(stage, options.out);
  try {
    await publishStage(job, options);
  } finally {
    await saveRecords(job, stage, options);
  }
}

async function publishStage(job: Job, options: PublishOptions): Promise<void> {
  const path = `/repos/${job.repo}/issues/${job.issue.number}`;
  const issue = await rest<Issue>('GET', path);
  const v = verdict(job, revision(issue.title, issue.body ?? ''), options.out);
  if (job.role === 'retro') {
    if ('stage' in v) throw new Error(`Retro stopped at ${v.stage}: ${v.reason}.`);
    const runUrl = `${process.env.GITHUB_SERVER_URL}/${job.repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
    await rest('POST', `${path}/comments`, { body: retroComment(v.result, runUrl) });
    return;
  }
  const { body, status, stopped } =
    job.role === 'review'
      ? await publishReview(job, v, options.round ?? 0)
      : await publishBuildOrPlan(job, v, options.out, options.checkout);

  // A build's Ready is brief: its own review follows in the same run and has the last word.
  const waiting = status === 'Needs you' || (status === 'Ready' && job.role !== 'build');
  await upsertStageComment(job.repo, job.issue.number, job.role, waiting ? mention(body) : body);
  // A review after the build has no label left to remove.
  await removeLabel(
    job.repo,
    job.issue.number,
    STAGE_LABELS[job.role as keyof typeof STAGE_LABELS],
  );
  await setStatus(job.repo, issue.node_id, status);

  // The run ended waiting on the operator; the workflow runs a retro (devkit#39).
  // A plan that asks questions is the normal flow, not trouble.
  if (status === 'Needs you' && job.role !== 'plan' && process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, 'retro=true\n');
  if (stopped) process.exitCode = 1;
}
