// The controller's write side for one stage: check the result against the live
// contract, upsert the stage's marker comment, remove the trigger label and
// move the card on. A build also pushes its candidate and opens a draft PR; a
// review posts on that PR and merges it when both gates pass, or hands its
// findings to a repair, which pushes a fix to the same PR. Denied PRs need the
// operator. A retro files its findings as one
// `retro` issue for the planner, and that plan's approval files the issues it
// kept instead of building. A ready
// plan with subtasks files them as sub-issues, which makes the card a story,
// and every other stage files its follow-ups as new issues (devkit#12). Only
// this writes GitHub, and only with the App.

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { git, gitAsOperator, gitBytes } from '../git.ts';
import { check as checkMemory, frontmatter } from '../memory/check.ts';
import { githubReader } from '../memory/reader.ts';
import { armedContinue, criticismPasses, readSteps } from './approval.ts';
import { proposePriority, setStatus } from './board.ts';
import {
  FILED_LABEL,
  filedByPipeline,
  FOLLOWUP_CAP,
  type Handoff,
  OPERATOR_COAUTHOR,
  OPERATOR_ID,
  OPERATOR_LOGIN,
  PIPELINE_BOT,
  REPAIR_ROUNDS,
  RETRO_LABEL,
  STAGE_LABELS,
  type Status,
} from './constants.ts';
import {
  merge,
  disableAutoMerge,
  graphql,
  removeLabel,
  rest,
  restAll,
  stageComment,
  upsertStageComment,
} from './github.ts';
import {
  type Criticism,
  CANDIDATE_FILE,
  CHECKS_FILE,
  THREADS_FILE,
  CONTRACT_PREFIX,
  followupMarker,
  ISSUES_FILE,
  JOB_FILE,
  Job,
  marker,
  PLAN_END,
  PLAN_FILE,
  PLAN_START,
  type PlanContract,
  planRevision,
  RESULT_FILE,
  RESEARCH_FILE,
  REVIEW_FILE,
  revision,
  STEPS_FILE,
  subtaskMarker,
  TRANSCRIPT_FILE,
  TRIAGE_FILE,
  usage,
} from './job.ts';
import {
  branchOf,
  findingMarker,
  openPull,
  readThreads,
  replyThread,
  type Pull,
  type Thread,
} from './threads.ts';
import { approvedPlan } from './render.ts';
import { denyRules } from './merge.ts';
import { receiptFor, settle } from './reactions.ts';
import { type Failure, type Followup, Result, type Subtask, Triage } from './result.ts';

export interface PublishOptions {
  in: string;
  out: string;
  critique?: string;
  appId?: number;
  /** A build's target repo, checked out at the job's source with push access. */
  checkout?: string;
  /** A review's repair round: 0 reviews the build, n the nth repair. */
  round?: number;
  /** The repair-round cap; defaults to REPAIR_ROUNDS. */
  rounds?: number;
  /** A review's round: the commit toolchain.verify passed on, or empty when it did not pass. */
  verified?: string;
  verifierIn?: string;
  verifierOut?: string;
  /** A memory run's failed jobs, encoded as the caller's toJSON(needs). */
  failed?: string;
  repo?: string;
  issue?: number;
}

interface Issue {
  id: number;
  number: number;
  html_url: string;
  node_id: string;
  title: string;
  body: string | null;
  labels: { name: string }[];
  created_at: string;
  user: { id: number } | null;
}

/** What a stage publishes: the issue comment, the card's Status, and whether it stopped. */
interface Outcome {
  body: string;
  status: Status;
  stopped: boolean;
}

/** A result that may be published, or the stage it stopped at and why. */
export type Verdict = { result: Result } | { stage: string; reason: string; step?: string };

export type Step = 'ready' | 'repair' | 'rerun' | 'spec' | 'stop';
export interface Gate {
  candidate: string;
  head: string;
  review: Verdict;
  verified: string;
  checks: Record<string, string>;
  check: Verdict | null;
  round: number;
  rounds: number;
}

/** The only decision point for a review round, bound to its exact candidate. */
export function nextStep(gate: Gate): Step {
  if (gate.head !== gate.candidate || ('stage' in gate.review && gate.review.stage === 'stale'))
    return gate.round < gate.rounds ? 'rerun' : 'stop';
  if ('stage' in gate.review) return 'stop';
  const check = criterionVerdict(gate);
  if (check.kind === 'stop') return 'stop';
  const result = gated(
    gate.review.result,
    gate.candidate || null,
    gate.verified,
    check.kind === 'findings' ? check.findings : [],
  );
  if (passes(result)) return 'ready';
  return repairable(result) && gate.round < gate.rounds ? 'repair' : 'stop';
}

/** Evidence comes from the verifier, while the IDs come from the approved plan. */
export function criterionVerdict(
  gate: Pick<Gate, 'checks' | 'check' | 'candidate'>,
):
  | { kind: 'verified' }
  | { kind: 'findings'; findings: Finding[] }
  | { kind: 'stop'; stage: string; reason: string } {
  const ids = Object.keys(gate.checks).filter((id) => gate.checks[id] === 'agent');
  if (!ids.length) return { kind: 'verified' };
  const stop = (stage: string, reason: string) => ({
    kind: 'stop' as const,
    stage,
    reason: `the verifier could not check ${ids.join(', ')}: ${reason}`,
  });
  if (gate.check === null) return stop('verify', 'the verifier did not run');
  if ('stage' in gate.check)
    return stop(gate.check.stage === 'stale' ? 'verify' : gate.check.stage, gate.check.reason);
  const result = gate.check.result;
  if (result.inputs.candidate !== gate.candidate)
    return stop('verify', 'the verifier checked a different candidate');
  const findings: Finding[] = ids.flatMap((id) => {
    const entry = result.evidence.find((e) => e.criterion === id && e.result === 'fail');
    return entry
      ? [
          {
            id: `V-${id}`,
            axis: 'spec',
            blocking: true,
            criterion: id,
            path: null,
            line: null,
            evidence: entry.location,
            scenario: entry.check,
            impact: `Criterion ${id} fails on ${gate.candidate}.`,
            fix: `Make ${id} pass: ${entry.expected}.`,
          },
        ]
      : [];
  });
  if (findings.length) return { kind: 'findings', findings };
  const missing = ids.filter((id) => {
    const entries = result.evidence.filter((e) => e.criterion === id);
    return !entries.length || entries.some((e) => e.result !== 'pass');
  });
  if (!missing.length && result.status === 'complete' && result.outcome === 'verified')
    return { kind: 'verified' };
  return {
    kind: 'stop',
    stage: 'verify',
    reason: `the verifier could not check ${(missing.length ? missing : ids).join(', ')}: ${result.summary}`,
  };
}

export function changedCriteria(
  approved: Record<string, string>,
  criteria: Result['criteria'],
): string[] {
  if (criteria === null) return [];
  const next = Object.fromEntries(criteria.map((c) => [c.id, c.check]));
  return [...new Set([...Object.keys(approved), ...Object.keys(next)])]
    .filter((id) => approved[id] !== next[id])
    .sort();
}

export function specChanged(
  approved: { revision: string; checks: Record<string, string> },
  result: Result,
  plan: string | null,
): boolean {
  return (
    (plan !== null && planRevision(plan) !== approved.revision) ||
    changedCriteria(approved.checks, result.criteria).length > 0
  );
}

export function replanStep(v: Verdict, changed: boolean): 'repair' | 'spec' | 'stop' {
  if ('stage' in v) return 'stop';
  if (changed) return 'spec';
  return v.result.status !== 'complete' ||
    v.result.outcome !== 'ready' ||
    v.result.questions.length > 0
    ? 'stop'
    : 'repair';
}

export function replanMap(threads: Thread[], result: Result): string | null {
  const missing = threads
    .filter(
      (t) =>
        !t.resolved && !(result.changes ?? []).some((c) => c.ref === t.id && c.response?.trim()),
    )
    .map((t) => t.id);
  return missing.length ? `planner map is missing replies: ${missing.join(', ')}` : null;
}

export function verdict(job: Job, liveRevision: string, out: string): Verdict {
  const file = join(out, RESULT_FILE);
  if (!existsSync(file)) {
    const stepsFile = join(out, STEPS_FILE);
    if (existsSync(stepsFile)) {
      const steps = JSON.parse(readFileSync(stepsFile, 'utf8')) as Record<string, string>;
      const failed = Object.entries(steps).find(
        ([step, outcome]) => step !== 'run' && outcome === 'failure',
      );
      if (failed)
        return {
          stage: job.role,
          reason: `the ${job.role} job failed at ${failed[0]} before the agent started; see the job log`,
          step: failed[0],
        };
    }
    return { stage: job.role, reason: 'the agent ended without a result' };
  }
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
  if (job.candidate !== null && result.inputs.candidate !== job.candidate) {
    return {
      stage: 'stale',
      reason: `the result is for commit ${result.inputs.candidate}, not the current candidate ${job.candidate}`,
    };
  }
  if (result.status === 'complete' && job.role === 'plan' && !existsSync(join(out, PLAN_FILE))) {
    return { stage: 'validate', reason: `the agent wrote no ${PLAN_FILE}` };
  }
  if (result.status === 'complete' && job.role === 'research') {
    if (result.outcome !== 'answered' && result.outcome !== 'inconclusive')
      return { stage: 'validate', reason: 'complete research must be answered or inconclusive' };
    if (!existsSync(join(out, RESEARCH_FILE)))
      return { stage: 'validate', reason: `the agent wrote no ${RESEARCH_FILE}` };
    if (
      result.outcome === 'answered' &&
      !result.evidence.some((e) => URL.parse(e.location)?.protocol === 'https:')
    )
      return { stage: 'validate', reason: 'answered research has no HTTPS evidence location' };
  }
  // Only a retro issue's plan triages, and its build files that triage instead of building.
  const retroPlan = job.role === 'plan' && job.artifacts.includes(ISSUES_FILE);
  if (result.triage !== null && !retroPlan)
    return {
      stage: 'validate',
      reason: `a ${job.role} set \`triage\`, which only a retro issue's plan may`,
    };
  if (retroPlan && readyToBuild(result) && result.triage === null)
    return { stage: 'validate', reason: "the retro issue's plan is ready but has no `triage`" };
  // Every plan proposes a priority so nothing reaches the board untriaged (devkit#115, H).
  if (job.role === 'plan' && !retroPlan && result.status === 'complete' && result.priority === null)
    return { stage: 'validate', reason: 'the plan set no `priority`' };
  if (result.status !== 'complete' && result.outcome !== null) {
    return {
      stage: 'validate',
      reason: `a ${result.status} run set outcome \`${result.outcome}\``,
    };
  }
  // `stale`, not `contract`: a review round reruns on it instead of stopping (nextStep).
  if (result.status === 'stale')
    return {
      stage: 'stale',
      reason: `the ${job.role} found its input superseded: ${result.summary.replace(/\.$/, '')}`,
    };
  // Repair and replan results still pass through their map check and the loop log.
  if (
    (result.status === 'blocked' || result.status === 'failed') &&
    job.role !== 'repair' &&
    job.role !== 'replan'
  )
    return {
      stage: job.role,
      reason: `\`${result.status}\`: ${result.summary.replace(/\.$/, '')}`,
    };
  const candidate = join(out, CANDIDATE_FILE);
  if (
    result.outcome === 'implemented' &&
    job.role !== 'memory' &&
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
  if (role === 'plan' || role === 'research') return `add \`${STAGE_LABELS[role]}\``;
  return 'reply `/approve`';
}

export function stopped(role: string, v: { stage: string; reason: string; step?: string }): string {
  return [
    marker(role),
    `**${role[0]?.toUpperCase()}${role.slice(1)} stopped at \`${v.stage}\`:** ${v.reason}.`,
    v.step
      ? `Likely the environment (runner, Bitwarden), not the code: read step \`${v.step}\` in job \`${role}\` before you ${retry(role)} again.`
      : `Fix the cause, then ${retry(role)} again.`,
  ].join('\n\n');
}

/** A comment that leaves the card waiting on the operator mentions him, so he hears of it then. */
export function mention(body: string): string {
  return `${body}\n\n@${OPERATOR_LOGIN}`;
}

function numbered(questions: string[]): string {
  return questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
}

const CRITIQUE_OUTCOMES = ['pass', 'changes-requested', 'inconclusive'] as const;

interface Assessment {
  criticism: Criticism;
  text: string;
  valid: boolean;
}

function readCriticism(job: Job, out: string): Assessment {
  const v = verdict(job, job.issue.revision, out);
  const valid =
    'result' in v &&
    v.result.status === 'complete' &&
    CRITIQUE_OUTCOMES.some((outcome) => outcome === v.result.outcome) &&
    v.result.inputs.base === job.source &&
    !(v.result.outcome === 'pass' && v.result.findings?.some((finding) => finding.blocking));
  const criticism: Criticism = {
    outcome: valid && 'result' in v ? v.result.outcome! : 'failed',
    planRevision: job.plan!.revision,
    issueRevision: job.issue.revision,
    source: job.source,
  };
  const text =
    'result' in v
      ? [
          v.result.summary,
          ...(v.result.findings ?? [])
            .filter((finding) => finding.blocking)
            .map(
              (finding) => `- ${finding.id}: ${finding.scenario} ${finding.impact} ${finding.fix}`,
            ),
        ].join('\n\n')
      : v.reason;
  return { criticism, text, valid };
}

function planCriticism(job: Job, out: string, dir: string): Assessment {
  const expected: Job = {
    ...job,
    role: 'critique',
    plan: {
      revision: planRevision(readFileSync(join(out, PLAN_FILE), 'utf8')),
      criteria: [],
      checks: {},
    },
  };
  try {
    const critic = Job.parse(JSON.parse(readFileSync(join(dir, 'in', JOB_FILE), 'utf8')));
    if (
      critic.job !== job.job ||
      critic.role !== expected.role ||
      critic.repo !== job.repo ||
      critic.issue.revision !== job.issue.revision ||
      critic.source !== job.source ||
      critic.plan?.revision !== expected.plan!.revision
    )
      throw new Error('The criticism job is for different inputs.');
    return readCriticism(critic, join(dir, 'out'));
  } catch (error) {
    return {
      criticism: {
        outcome: 'failed',
        planRevision: expected.plan!.revision,
        issueRevision: job.issue.revision,
        source: job.source,
      },
      text: error instanceof Error ? error.message : String(error),
      valid: false,
    };
  }
}

async function publishCriticism(job: Job, issue: Issue, options: PublishOptions): Promise<void> {
  let assessment = readCriticism(job, options.out);
  try {
    if (options.appId === undefined) throw new Error('Criticism publish needs --app-id.');
    const comment = await stageComment(job.repo, job.issue.number, 'plan');
    if (!comment) throw new Error('The plan comment is missing.');
    const approved = approvedPlan(
      [comment],
      options.appId,
      revision(issue.title, issue.body ?? ''),
      issue.user?.id === OPERATOR_ID || filedByPipeline(issue),
    );
    if (
      approved.contract.planRevision !== job.plan?.revision ||
      revision(issue.title, issue.body ?? '') !== job.issue.revision
    )
      throw new Error('The plan or issue changed while criticism ran.');
    const contract = { ...approved.contract, criticism: assessment.criticism };
    const start = comment.body!.lastIndexOf(CONTRACT_PREFIX);
    const body =
      comment.body!.slice(0, start) +
      comment
        .body!.slice(start)
        .replace(
          /^<!-- devkit:contract [^\r\n]* -->/,
          () => `${CONTRACT_PREFIX}${JSON.stringify(contract)} -->`,
        );
    await rest('PATCH', `/repos/${job.repo}/issues/comments/${comment.id}`, { body });
  } catch (error) {
    assessment = {
      ...assessment,
      valid: false,
      criticism: { ...assessment.criticism, outcome: 'failed' },
    };
    console.error(error);
  }
  const pass = assessment.valid && assessment.criticism.outcome === 'pass';
  if (!pass) {
    const body = `Build blocked: criticism ${assessment.criticism.outcome} on plan ${job.plan!.revision.slice(0, 7)} at ${job.source.slice(0, 7)}`;
    await upsertStageComment(
      job.repo,
      job.issue.number,
      'build',
      mention(`${marker('build')}\n\n${body}`),
    );
    await removeLabel(job.repo, job.issue.number, STAGE_LABELS.build);
    await setStatus(job.repo, issue.node_id, 'Needs you');
    await settle(job.repo, job.issue.number, assessment.valid ? 'question' : 'failed');
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pass=${pass}\n`);
  if (!assessment.valid) process.exitCode = 1;
}

export function planComment(
  job: Job,
  result: Result,
  out: string,
  handoff: Handoff | null,
  story: Filed[],
  criticismPassed: boolean,
  checks?: Record<string, string>,
  assessment?: Assessment,
): string {
  const planFile = join(out, PLAN_FILE);
  const plan = existsSync(planFile) ? readFileSync(planFile, 'utf8').trim() : '';
  const bodyNote = job.issue.bodySeen
    ? ''
    : ' (written without the issue body, which someone else wrote)';
  const head =
    result.outcome === 'ready' && !story.length && result.triage === null && !criticismPassed
      ? `**Plan: ready, but criticism did not pass${bodyNote}. Run /revise, then /approve.**`
      : story.length
        ? `**Plan: ready. This card is a story: approve and build each subtask, not this card${bodyNote}**`
        : handoff
          ? `**Plan: ready. Your Continue approved it, so \`${STAGE_LABELS[handoff]}\` starts now${bodyNote}**`
          : `**Plan: ${result.outcome !== 'ready' ? 'needs your input' : result.triage ? 'ready: reply `/approve` to file what it keeps' : 'ready: reply `/approve` to build it'}${bodyNote}**`;
  const contract: PlanContract = {
    planRevision: planRevision(plan),
    criticism: assessment?.criticism ?? null,
    outcome: result.outcome,
    source: job.source,
    issueRevision: job.issue.revision,
    bodySeen: job.issue.bodySeen,
    checks:
      result.criteria === null && checks
        ? checks
        : Object.fromEntries((result.criteria ?? []).map((c) => [c.id, c.check])),
    critique: result.critique,
    triage: result.triage,
    blockedBy: story.some((s) => s.blockedBy.length)
      ? Object.fromEntries(
          story.filter((s) => s.blockedBy.length).map((s) => [s.number, s.blockedBy]),
        )
      : null,
  };
  return [
    marker(job.role),
    head,
    result.summary,
    result.priority && `**Priority:** ${result.priority}, unless the card already has one.`,
    story.length && `## Subtasks\n\n${story.map((s) => `- #${s.number} ${s.title}`).join('\n')}`,
    numbered(result.questions),
    assessment && `## Criticism\n\n**${assessment.criticism.outcome}**\n\n${assessment.text}`,
    `${PLAN_START}\n${plan}\n${PLAN_END}`,
    `${CONTRACT_PREFIX}${JSON.stringify(contract)} -->`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildComment(job: Job, result: Result, pull: Pull | null): string {
  const stage = job.role === 'repair' ? 'Repair' : 'Build';
  const link = pull && `[#${pull.number}](${pull.html_url})`;
  const head = !link
    ? result.status !== 'complete'
      ? `**${stage} ${result.status}**`
      : `**${stage}: ${result.outcome === 'needs-input' ? 'needs your input' : result.outcome}**`
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
  const commit = git(
    checkout,
    ['commit-tree', tree, '-p', parent, '-m', commitMessage(job)],
    PIPELINE_BOT,
  );
  // A checkout with saved credentials pushes as the App; the desk's has none.
  gitAsOperator(checkout, ['push', 'origin', `${commit}:refs/heads/${branch}`]);
  return { branch, commit };
}

/** The candidate's commit message: every pushed commit goes through here. */
export function commitMessage(job: Pick<Job, 'role' | 'issue'>): string {
  const subject =
    job.role === 'repair'
      ? `Fix review findings for #${job.issue.number}`
      : `${job.issue.title}\n\nCloses #${job.issue.number}`;
  return `${subject}\n\n${OPERATOR_COAUTHOR}`;
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

type Finding = NonNullable<Result['findings']>[number];

/** Git quotes control characters and encodes non-ASCII bytes as octal escapes. */
function patchPath(name: string): string {
  if (!name.startsWith('"')) return name;
  const escapes: Record<string, string> = {
    a: '\x07',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
  };
  return Buffer.concat(
    [...name.slice(1, -1).matchAll(/\\([0-7]{3}|.)|([^\\]+)/g)].map(([, escaped, plain]) => {
      if (plain !== undefined) return Buffer.from(plain);
      return /^[0-7]{3}$/.test(escaped!)
        ? Buffer.from([Number.parseInt(escaped!, 8)])
        : Buffer.from(escapes[escaped!] ?? escaped!);
    }),
  ).toString('utf8');
}

/** Only added and context lines on the new side can receive GitHub comments. */
export function reviewComments(
  patch: string,
  findings: Finding[],
): {
  inline: { path: string; line: number; side: 'RIGHT'; body: string }[];
  file: { path: string; body: string }[];
  body: Finding[];
} {
  const paths = new Set<string>();
  const lines = new Set<string>();
  let path = '';
  let right = 0;
  let remaining = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const header = /^diff --git (?:"(?:\\.|[^"])*"|.*?) ("(?:\\.|[^"])*"|b\/.*)$/.exec(line);
      path = header ? patchPath(header[1]!).replace(/^b\//, '') : '';
      if (path) paths.add(path);
      remaining = 0;
    } else if (remaining > 0) {
      if (line.startsWith('+') || line.startsWith(' ')) {
        lines.add(`${path}:${right++}`);
        remaining--;
      }
    } else if (line.startsWith('+++ ')) {
      const name = line.slice(4).split('\t')[0]!;
      if (name !== '/dev/null') {
        path = patchPath(name).replace(/^b\//, '');
        paths.add(path);
      }
    } else {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        right = Number(hunk[1]);
        remaining = Number(hunk[2] ?? 1);
      }
    }
  }
  const inline: ReturnType<typeof reviewComments>['inline'] = [];
  const file: ReturnType<typeof reviewComments>['file'] = [];
  const body: Finding[] = [];
  for (const f of findings) {
    if (f.path && f.line !== null && lines.has(`${f.path}:${f.line}`))
      inline.push({
        path: f.path,
        line: f.line,
        side: 'RIGHT',
        body: findingText(f),
      });
    else {
      const anchor = f.path && paths.has(f.path) ? f.path : paths.values().next().value;
      if (anchor)
        file.push({ path: anchor, body: findingText(f, anchor !== f.path || f.line !== null) });
      else body.push(f);
    }
  }
  return { inline, file, body };
}

function findingText(f: Finding, location = false): string {
  const where = location
    ? `${f.path ? `\`${f.path}${f.line !== null ? `:${f.line}` : ''}\`` : 'no location'}\n\n`
    : '';
  return `${findingMarker(f.id)}\n\n${where}**${f.id}** ${f.blocking ? 'blocking' : 'advisory'} · ${f.axis}\n\n${f.scenario} ${f.impact}\n\nEvidence: ${f.evidence}\n\nFix: ${f.fix}`;
}

export function threadActions(
  open: Thread[],
  findings: Finding[],
): {
  resolve: Thread[];
  reply: { thread: Thread; finding: Finding }[];
  create: Finding[];
} {
  const threads = open.filter((thread) => !thread.resolved);
  return {
    resolve: threads.filter((thread) => !findings.some((f) => f.id === thread.id && f.blocking)),
    reply: threads.flatMap((thread) => {
      const finding = findings.find((f) => f.id === thread.id);
      return finding ? [{ thread, finding }] : [];
    }),
    create: findings.filter((f) => !threads.some((thread) => thread.id === f.id)),
  };
}

export async function replyChanges(
  repo: string,
  pull: number,
  changes: NonNullable<Result['changes']>,
  commit: string,
  heading: 'Repair' | 'Planner' = 'Repair',
): Promise<void> {
  const threads = await readThreads(repo, pull);
  for (const change of changes) {
    const thread = threads.find((thread) => !thread.resolved && thread.id === change.ref);
    if (thread)
      await replyThread(
        thread.node,
        [
          `${heading} \`${commit.slice(0, 7)}\``,
          heading === 'Planner' ? change.response : (change.change ?? change.response),
          change.evidence,
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
  }
}

export function repairMap(review: Result, repair: Result): string | null {
  const refs = new Set((repair.changes ?? []).map((change) => change.ref));
  const missing = (review.findings ?? []).filter((f) => !refs.has(f.id)).map((f) => f.id);
  const unsupported = (repair.changes ?? [])
    .filter((c) => c.response !== null && !c.evidence?.trim())
    .map((c) => c.ref);
  const errors = [
    missing.length && `repair map is missing refs: ${missing.join(', ')}`,
    unsupported.length && `disputed refs ${unsupported.join(', ')} need non-empty evidence`,
  ].filter(Boolean);
  return errors.length ? errors.join('; ') : null;
}

export interface LoopEntry {
  round: number;
  candidate: string;
  ci: 'green' | 'red' | null;
  review: string | null;
  verify: string | null;
  replan: string | null;
  open: string[];
  hypotheses: string[];
  step: Step | null;
}
export interface LoopState {
  rounds: number;
  failures: number;
  entries: LoopEntry[];
  approved?: string;
  base?: string;
}

export function loopComment(state: LoopState): string {
  const round = state.entries.at(-1)?.round ?? 0;
  return [
    marker('loop'),
    `**Round ${round} of ${state.rounds} · ${state.failures} failures**`,
    ...state.entries.map(
      (e) =>
        `- Round ${e.round}: \`${e.candidate.slice(0, 7)}\`; CI ${e.ci ?? 'pending'}; review ${e.review ?? 'pending'}; verify: ${e.verify ?? 'pending'}; open blocking IDs: ${e.open.join(', ') || 'none'}; ${e.step ?? 'pending'}${e.replan ? `; planner: ${e.replan}` : ''}${e.hypotheses.length ? `; hypotheses: ${e.hypotheses.join('; ')}` : ''}`,
    ),
    `<!-- devkit:loop-state ${JSON.stringify(state).replace(/-->/g, '--\\u003e')} -->`,
  ].join('\n\n');
}

export function readLoopState(body: string | null): LoopState {
  const json = [...(body ?? '').matchAll(/^<!-- devkit:loop-state (.*) -->$/gm)].at(-1)?.[1];
  return json
    ? (JSON.parse(json) as LoopState)
    : { rounds: REPAIR_ROUNDS, failures: 0, entries: [] };
}

async function updateLoop(
  job: Job,
  pull: Pull,
  options: PublishOptions,
  entry: Partial<LoopEntry>,
) {
  const round = options.round ?? 0;
  const existing = await stageComment(job.repo, pull.number, 'loop');
  // Round zero starts a new build on a PR that may already have a log.
  const state = readLoopState(round === 0 ? null : (existing?.body ?? null));
  state.approved ??= job.plan?.revision;
  state.base ??= job.base ?? job.source;
  state.rounds = options.rounds ?? REPAIR_ROUNDS;
  const previous = state.entries.find((e) => e.round === round);
  const current: LoopEntry = {
    round,
    candidate: job.candidate ?? '',
    ci: null,
    review: null,
    verify: null,
    replan: null,
    open: state.entries.at(-1)?.open ?? [],
    hypotheses: [],
    step: null,
    ...previous,
    ...entry,
  };
  state.entries = [...state.entries.filter((e) => e.round !== round), current].sort(
    (a, b) => a.round - b.round,
  );
  state.failures = state.entries.filter((e) => e.step !== 'ready').length;
  return upsertStageComment(job.repo, pull.number, 'loop', loopComment(state));
}

export function needsYouText(round: number, threads: Thread[], logUrl: string): string {
  const links = threads
    .filter((thread) => !thread.resolved)
    .map((thread) => `[${thread.id}](${thread.url})`);
  return `Stopped in round ${round}. Open threads: ${links.join(', ') || 'none'}.\n\n[Loop log](${logUrl})`;
}

export function replanStopText(
  step: 'spec' | 'stop',
  round: number,
  changed: string[],
  reason: string,
  threads: Thread[],
  logUrl: string,
): string {
  return [
    step === 'spec'
      ? `Spec changed in round ${round}. Changed criteria: ${changed.join(', ') || 'plan text only'}. Approve with \`/approve\` to resume.`
      : `The planner stopped round ${round}: ${reason}.`,
    step === 'spec' && reason,
    needsYouText(round, threads, logUrl),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function capText(round: number, state: LoopState): string {
  const suggestion = [...state.entries].reverse().find((e) => e.replan)?.replan;
  return `The review loop hasn't converged after ${round} rounds.\n\nAgents' suggestion: ${suggestion ?? 'No planner summary was recorded.'}`;
}

async function publishReplan(job: Job, v: Verdict, options: PublishOptions): Promise<Outcome> {
  const round = options.round ?? 0;
  const pull = await openPull(job, branchOf(job));
  if (!pull)
    return {
      body: `${stopped(job.role, { stage: 'publish', reason: 'the build has no open PR' })}\n\nStopped in round ${round}. No open PR or review threads.`,
      status: 'Needs you',
      stopped: true,
    };
  const snapshot: Thread[] = JSON.parse(readFileSync(join(options.in, THREADS_FILE), 'utf8'));
  if ('result' in v) {
    const reason = replanMap(snapshot, v.result);
    if (reason) v = { stage: 'validate', reason };
  }
  if (pull.head.sha !== job.source)
    v = { stage: 'stale', reason: 'the PR has a newer commit than the planner saw' };
  const checks: Record<string, string> = JSON.parse(
    readFileSync(join(options.in, CHECKS_FILE), 'utf8'),
  );
  const planFile = join(options.out, PLAN_FILE);
  const plan = existsSync(planFile) ? readFileSync(planFile, 'utf8') : null;
  const changed =
    'result' in v && specChanged({ revision: job.plan!.revision, checks }, v.result, plan);
  const step =
    pull.head.sha !== job.source && round < (options.rounds ?? REPAIR_ROUNDS)
      ? 'rerun'
      : replanStep(v, changed);
  if ('result' in v)
    await replyChanges(job.repo, pull.number, v.result.changes ?? [], job.source, 'Planner');
  // Record approval before rewriting the plan comment, so the render guard holds even after a partial publish.
  const log = await updateLoop(job, pull, options, {
    candidate: job.source,
    replan: 'result' in v ? v.result.summary : v.reason,
    ...(step !== 'repair' && { step }),
  });
  if (step === 'spec' && 'result' in v) {
    const body = planComment(
      { ...job, role: 'plan' },
      { ...v.result, outcome: 'ready' },
      plan === null ? options.in : options.out,
      null,
      [],
      false,
      checks,
    );
    await upsertStageComment(
      job.repo,
      job.issue.number,
      'plan',
      body.replace(
        /\*\*Plan:.*?\*\*/,
        `**Plan: changed in review round ${round}: reply \`/approve\` to resume #${pull.number}**\n\nChanged criteria: ${changedCriteria(checks, v.result.criteria).join(', ') || 'plan text only'}.`,
      ),
    );
  }
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `next=${step}\n${step === 'repair' ? 'repair=true\n' : ''}${step === 'rerun' ? `head=${pull.head.sha}\n` : ''}`,
    );
  if (step === 'rerun')
    return {
      body: `${marker('replan')}\n\nRe-reviewing \`${pull.head.sha.slice(0, 7)}\`: the PR has a newer commit than the planner saw. Round ${round + 1} of ${options.rounds ?? REPAIR_ROUNDS}.`,
      status: 'Building',
      stopped: false,
    };
  const reason =
    'stage' in v
      ? `stopped at \`${v.stage}\`: ${v.reason}`
      : v.result.questions.length
        ? numbered(v.result.questions)
        : v.result.summary;
  return {
    body:
      step === 'repair'
        ? `${marker('replan')}\n\n${reason}`
        : `${marker('replan')}\n\n${replanStopText(step, round, 'result' in v ? changedCriteria(checks, v.result.criteria) : [], reason, await readThreads(job.repo, pull.number), log.html_url)}`,
    status: step === 'repair' ? 'Building' : 'Needs you',
    stopped: 'stage' in v || ('result' in v && v.result.status !== 'complete'),
  };
}

function readVerifier(job: Job, liveRevision: string, options: PublishOptions): Verdict | null {
  if (
    !Object.values(job.plan?.checks ?? {}).includes('agent') ||
    !options.verifierIn ||
    !options.verifierOut
  )
    return null;
  const file = join(options.verifierIn, JOB_FILE);
  if (!existsSync(file)) return { stage: 'verify', reason: 'the verifier job file is missing' };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { stage: 'contract', reason: `the verifier ${JOB_FILE} is not JSON` };
  }
  const parsed = Job.safeParse(json);
  if (!parsed.success) {
    console.error(parsed.error.message);
    return { stage: 'contract', reason: `the verifier ${JOB_FILE} does not match the job schema` };
  }
  const verifier = parsed.data;
  if (
    verifier.role !== 'verify' ||
    verifier.repo !== job.repo ||
    verifier.issue.number !== job.issue.number ||
    verifier.issue.revision !== job.issue.revision ||
    verifier.plan?.revision !== job.plan?.revision
  )
    return {
      stage: 'contract',
      reason: 'the verifier job is for a different role, repo, issue revision or plan',
    };
  if (verifier.candidate !== job.candidate)
    return { stage: 'stale', reason: 'the verifier job is for a different candidate' };
  return verdict(verifier, liveRevision, options.verifierOut);
}

async function publishReview(
  job: Job,
  v: Verdict,
  options: PublishOptions,
  check: Verdict | null,
): Promise<Outcome> {
  const pull = await openPull(job, branchOf(job));
  if (!pull) v = { stage: 'publish', reason: 'the build has no open PR' };
  else if (pull.head.sha !== job.candidate)
    v = { stage: 'stale', reason: 'the PR has a newer commit than the one reviewed' };
  const criteria = criterionVerdict({
    checks: job.plan?.checks ?? {},
    check,
    candidate: job.candidate ?? '',
  });
  const step = nextStep({
    checks: job.plan?.checks ?? {},
    check,
    candidate: job.candidate ?? '',
    head: pull?.head.sha ?? job.candidate ?? '',
    review: v,
    verified: options.verified ?? '',
    round: options.round ?? 0,
    rounds: options.rounds ?? REPAIR_ROUNDS,
  });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `next=${step}\n`);
    if (step === 'repair') appendFileSync(process.env.GITHUB_OUTPUT, 'repair=true\n');
  }
  const threads: Thread[] =
    'result' in v ? JSON.parse(readFileSync(join(options.in, THREADS_FILE), 'utf8')) : [];
  const result =
    'result' in v
      ? gated(
          v.result,
          job.candidate,
          options.verified ?? '',
          criteria.kind === 'findings' ? criteria.findings : [],
          threads.map((t) => t.id),
        )
      : null;
  if ('result' in v && criteria.kind === 'stop')
    v = { stage: criteria.stage, reason: criteria.reason };
  const log =
    pull &&
    (await updateLoop(job, pull, options, {
      ci: options.verified === job.candidate ? 'green' : 'red',
      review: result?.outcome ?? ('stage' in v ? v.stage : null),
      verify: !Object.values(job.plan?.checks ?? {}).includes('agent')
        ? 'skipped'
        : check && 'result' in check
          ? check.result.outcome
          : check && 'stage' in check
            ? check.stage
            : 'missing',
      ...('result' in v &&
        result && { open: (result.findings ?? []).filter((f) => f.blocking).map((f) => f.id) }),
      step,
    }));
  if (step === 'rerun' && pull && 'stage' in v) {
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `head=${pull.head.sha}\n`);
    return {
      body: `Re-reviewing \`${pull.head.sha.slice(0, 7)}\`: ${v.reason}. Round ${(options.round ?? 0) + 1} of ${options.rounds ?? REPAIR_ROUNDS}.`,
      status: 'Building',
      stopped: false,
    };
  }
  // A verifier stop must not hide review findings or clear earlier threads.
  if ('stage' in v && v.stage !== 'stale' && result && pull && log)
    await postReview(
      job,
      result,
      pull,
      options,
      step,
      log.html_url,
      readLoopState(log.body),
      false,
    );
  if ('stage' in v)
    return {
      body: [
        stopped(job.role, v),
        log
          ? needsYouText(
              options.round ?? 0,
              await readThreads(job.repo, pull!.number),
              log.html_url,
            )
          : `Stopped in round ${options.round ?? 0}. No open PR or review threads.`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      status: 'Needs you',
      stopped: true,
    };
  // The repair answers the gated review; result.json stays the reviewer's own.
  writeFileSync(join(options.out, REVIEW_FILE), JSON.stringify(result, null, 2));
  return postReview(
    job,
    result!,
    pull!,
    options,
    step,
    log!.html_url,
    readLoopState(log!.body),
    true,
  );
}

/** The finding a review gets when CI did not pass on the commit it reviewed. */
export const CI_FINDING = 'CI';

/**
 * The review as the gate sees it: CI must have passed on the reviewed commit
 * itself (devkit#9). Otherwise it carries a blocking CI finding for the repair,
 * so a pass from an earlier or failed verify never reaches Ready.
 */
export function gated(
  result: Result,
  candidate: string | null,
  verified: string,
  extra: Finding[] = [],
  threadIds: string[] = [],
): Result {
  const green = candidate !== null && verified === candidate;
  const finding = {
    id: CI_FINDING,
    axis: 'correctness',
    blocking: true,
    criterion: null,
    path: null,
    line: null,
    evidence: runUrl(),
    scenario: `toolchain.verify did not pass on ${candidate}.`,
    impact: 'CI is red on this commit, so it is not safe to merge.',
    fix: 'Run the failing check from the run log locally and make it pass.',
  } as const;
  const findings: Finding[] = [
    ...(result.findings ?? []).filter((f) => !extra.some((check) => check.id === f.id)),
    ...extra,
    ...(!green ? [finding] : []),
  ];
  if (!findings.some((f) => f.blocking) || result.questions.length === 0)
    return green && !extra.length
      ? result
      : {
          ...result,
          outcome: result.outcome === 'pass' ? 'changes-requested' : result.outcome,
          findings,
        };
  let question = [...threadIds, ...findings.map((f) => f.id)].reduce(
    (max, id) => Math.max(max, Number(/^Q(\d+)$/.exec(id)?.[1] ?? 0)),
    0,
  );
  for (const text of result.questions) {
    findings.push({
      id: `Q${++question}`,
      axis: 'spec',
      blocking: false,
      criterion: null,
      path: null,
      line: null,
      evidence: text,
      scenario: text,
      impact: 'The planner must answer before repair.',
      fix: 'The planner answers on this thread.',
    });
  }
  return {
    ...result,
    outcome: result.outcome === 'pass' ? 'changes-requested' : result.outcome,
    findings,
    questions: [],
  };
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
 * Posts the review on the PR. A pass merges only when both gates allow it;
 * a repairable review with rounds left sets the `repair` output for the next round.
 */
async function postReview(
  job: Job,
  result: Result,
  pull: Pull,
  options: PublishOptions,
  step: Step,
  logUrl: string,
  state: LoopState,
  resolve: boolean,
): Promise<Outcome> {
  const round = options.round ?? 0;
  const rounds = options.rounds ?? REPAIR_ROUNDS;
  const actions = threadActions(await readThreads(job.repo, pull.number), result.findings ?? []);
  const comments = reviewComments(
    readFileSync(join(options.in, CANDIDATE_FILE), 'utf8'),
    actions.create,
  );
  await rest('POST', `/repos/${job.repo}/pulls/${pull.number}/reviews`, {
    commit_id: pull.head.sha,
    body: reviewText({ ...result, findings: comments.body }),
    event: 'COMMENT',
    comments: comments.inline,
  });
  for (const comment of comments.file)
    await rest('POST', `/repos/${job.repo}/pulls/${pull.number}/comments`, {
      commit_id: pull.head.sha,
      subject_type: 'file',
      ...comment,
    });
  for (const { thread, finding } of actions.reply)
    await replyThread(thread.node, findingText(finding));
  if (resolve && (result.outcome === 'pass' || result.outcome === 'changes-requested'))
    for (const thread of actions.resolve)
      await graphql('mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}', {
        id: thread.node,
      });
  const ok = step === 'ready';
  const repair = step === 'repair';
  const rules: string[] = [];
  if (ok) {
    const files = await restAll<{ filename: string; previous_filename?: string }>(
      `/repos/${job.repo}/pulls/${pull.number}/files`,
    );
    const packageAt = async (sha: string): Promise<string | null> => {
      const file = await rest<{ content: string }>(
        'GET',
        `/repos/${job.repo}/contents/package.json?ref=${encodeURIComponent(sha)}`,
      ).catch((error: Error) => {
        if (!error.message.includes(' 404 ')) throw error;
        return null;
      });
      return file === null ? null : Buffer.from(file.content, 'base64').toString('utf8');
    };
    const [pkgBase, pkgHead] = await Promise.all([
      packageAt(pull.base.sha),
      packageAt(pull.head.sha),
    ]);
    rules.push(
      ...denyRules(
        job.repo,
        files.flatMap((file) =>
          file.previous_filename ? [file.previous_filename, file.filename] : [file.filename],
        ),
        pkgBase,
        pkgHead,
      ),
    );
    if (result.merge?.verdict !== 'auto') {
      const rule = result.merge?.rule || 'review';
      if (!rules.includes(rule)) rules.push(rule);
    }
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
  }
  const link = `[#${pull.number}](${pull.html_url})`;
  let merged = false;
  let mergeError: string | null = null;
  if (ok && !rules.length) {
    try {
      await merge(job.repo, pull, pull.head.sha, 'now');
      merged = true;
    } catch (error) {
      mergeError = error instanceof Error ? error.message : String(error);
    }
  }
  const head = ok
    ? merged
      ? `**Review: passed. ${link} merged automatically**`
      : mergeError !== null
        ? `**Review: passed. Merging ${link} failed; needs you**\n\n${mergeError}`
        : `**Review: passed. ${link} is ready to merge; needs you: ${rules.map((rule) => `\`${rule}\``).join(', ')}**`
    : repair
      ? `**Review: ${link} needs changes. Codex is fixing them (round ${round + 1} of ${rounds})**`
      : `**Review: ${link} needs your call${round > 0 ? ` after ${round} repair round${round > 1 ? 's' : ''}` : ''}**`;
  return {
    body: [
      marker('review'),
      head,
      result.summary,
      numbered(result.questions),
      step === 'stop' &&
        round === rounds &&
        (result.findings ?? []).some((f) => f.blocking) &&
        capText(round, state),
      step === 'stop' && needsYouText(round, await readThreads(job.repo, pull.number), logUrl),
    ]
      .filter(Boolean)
      .join('\n\n'),
    status: merged ? 'Done' : repair ? 'Building' : 'Needs you',
    stopped: false,
  };
}

/** A plan that may build with nothing left to ask. */
export function readyToBuild(result: Result): boolean {
  return (
    result.status === 'complete' && result.outcome === 'ready' && result.questions.length === 0
  );
}

async function researchPull(job: Job, result: Result, text: string): Promise<Pull> {
  const branch = `agent/research-${job.issue.number}`;
  const repo = `/repos/${job.repo}`;
  try {
    await rest('GET', `${repo}/git/ref/heads/${branch}`);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(' 404 ')) throw error;
    await rest('POST', `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: job.source });
  }
  const path = `${repo}/contents/docs/research/${job.issue.number}.md`;
  let sha: string | undefined;
  try {
    sha = (await rest<{ sha: string }>('GET', `${path}?ref=${encodeURIComponent(branch)}`)).sha;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(' 404 ')) throw error;
  }
  await rest('PUT', path, {
    message: `docs(research): ${job.issue.title}\n\n${OPERATOR_COAUTHOR}`,
    content: Buffer.from(text).toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
  });
  return upsertPull(job, branch, result);
}

async function publishResearch(job: Job, v: Verdict, out: string): Promise<Outcome> {
  if ('stage' in v) return { body: stopped(job.role, v), status: 'Needs you', stopped: true };
  const result = v.result;
  const text = readFileSync(join(out, RESEARCH_FILE), 'utf8');
  let pull: Pull | null = null;
  if (result.outcome === 'answered' && result.docs) {
    try {
      pull = await researchPull(job, result, text);
    } catch (error) {
      return {
        body: stopped(job.role, {
          stage: 'publish',
          reason: error instanceof Error ? error.message : String(error),
        }),
        status: 'Needs you',
        stopped: true,
      };
    }
  }
  const body = [
    marker(job.role),
    `**Research: ${result.outcome}**`,
    result.summary,
    pull && `Draft PR: ${pull.html_url}`,
    numbered(result.questions),
    result.next,
    text,
  ]
    .filter(Boolean)
    .join('\n\n');
  // Leave room for the mention and follow-up notice added by publish.
  const limit = 60000;
  return {
    body:
      body.length > limit
        ? `${body.slice(0, limit)}\n\nReport truncated; the full research.md is in the run artifact.`
        : body,
    status: pull ? 'Ready' : 'Needs you',
    stopped: false,
  };
}

async function publishBuildOrPlan(
  job: Job,
  issue: Issue,
  v: Verdict,
  out: string,
  checkout: string | undefined,
  handoff: Handoff | null,
  subtasks: Subtask[],
  options: PublishOptions,
  criticismPassed: boolean,
  assessment: Assessment | undefined,
): Promise<Outcome> {
  let pull: Pull | null = null;
  let candidate = '';
  let story: Filed[] = [];
  if ('result' in v && subtasks.length) {
    try {
      story = await fileSubtasks(job, issue, subtasks);
    } catch (error) {
      console.error(error);
      v = { stage: 'publish', reason: 'filing the subtasks failed; see the run log' };
    }
  }
  if ('result' in v && v.result.outcome === 'implemented') {
    try {
      if (!checkout) throw new Error('publish needs --checkout for a build.');
      const { branch, commit } = pushCandidate(job, checkout, join(out, CANDIDATE_FILE));
      candidate = commit;
      // A repair keeps the build's PR text; its summary goes on the issue comment.
      pull =
        job.role === 'repair'
          ? ((await openPull(job, branch)) ?? null)
          : await upsertPull(job, branch, v.result);
      // The review job's input.
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, `candidate=${commit}\n`);
      if (job.role === 'repair' && pull) {
        try {
          await replyChanges(job.repo, pull.number, v.result.changes ?? [], commit);
        } catch (error) {
          console.error('Posting repair thread replies failed; continuing to review.', error);
        }
      }
    } catch (error) {
      console.error(error);
      v = {
        stage: 'publish',
        reason: 'publishing the change or PR failed; see the run log',
      };
    }
  }
  if (job.role === 'repair') {
    const logPull = pull ?? (await openPull(job, branchOf(job)));
    if (logPull)
      await updateLoop(job, logPull, options, {
        candidate: candidate || job.source,
        ...('result' in v
          ? { hypotheses: v.result.hypotheses ?? [] }
          : { step: 'stop' as const, review: v.stage }),
      });
  }
  // A repair's card stays in Building until its review lands, as does a plan handing off.
  const status =
    'stage' in v
      ? 'Needs you'
      : handoff || (pull && job.role === 'repair' && candidate)
        ? 'Building'
        : pull && job.role !== 'repair'
          ? 'Ready'
          : 'Needs you';
  if ('stage' in v) return { body: stopped(job.role, v), status, stopped: true };
  const body =
    job.role === 'plan'
      ? planComment(job, v.result, out, handoff, story, criticismPassed, undefined, assessment)
      : buildComment(job, v.result, pull);
  return { body, status, stopped: false };
}

/** A retro's findings, each with the fix it suggests: the retro issue's body, or a comment when it files none. */
export function retroText(result: Result, runUrl: string, source: number): string {
  const findings = (result.followups ?? [])
    .map((f, i) => `${i + 1}. **${f.title}:** ${f.body}`)
    .join('\n');
  return [
    `**Retro on [this run](${runUrl})** of #${source}.`,
    result.summary,
    findings && `## Findings\n\n${findings}`,
    result.questions.length > 0 && `## Questions\n\n${numbered(result.questions)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Files the retro's findings as one `retro` issue and starts its plan, which
 * triages them (devkit#115). A retro with no findings, or one on a retro issue,
 * only comments, so retros can't loop. A failed retro posts nothing.
 */
export async function publishRetro(job: Job, issue: Issue, result: Result): Promise<void> {
  const text = retroText(result, runUrl(), issue.number);
  const comments = `/repos/${job.repo}/issues/${issue.number}/comments`;
  if (!result.followups?.length || issue.labels.some((l) => l.name === RETRO_LABEL)) {
    await rest('POST', comments, { body: `${marker('retro')}\n\n${text}` });
    return;
  }
  const filed = await rest<Issue>('POST', `/repos/${job.repo}/issues`, {
    title: `Retro: ${issue.title}`,
    body: text,
    labels: [RETRO_LABEL, FILED_LABEL],
  });
  // Its own call, so the plan starts from a `labeled` event the App sent.
  await rest('POST', `/repos/${job.repo}/issues/${filed.number}/labels`, {
    labels: [STAGE_LABELS.plan],
  });
  await rest('POST', comments, {
    body: `${marker('retro')}\n\n**Retro on [this run](${runUrl()})** found ${result.followups.length} problem${result.followups.length > 1 ? 's' : ''}. They are in #${filed.number}, which is planning now.`,
  });
}

/**
 * Files what a retro issue's approved plan kept: a new `retro` issue per
 * finding, or a comment on the existing issue it links to. Then closes the
 * retro issue. It builds nothing.
 * shortcut: a retry after a partial failure files the earlier issues again;
 * make it idempotent if that happens.
 */
async function fileTriage(job: Job, triage: Triage): Promise<string> {
  const lines: string[] = [];
  for (const item of triage) {
    const from = `From the retro in #${job.issue.number}.`;
    if (item.link !== null) {
      await rest('POST', `/repos/${job.repo}/issues/${item.link}/comments`, {
        body: `**${item.title}**\n\n${item.body}\n\n${from}`,
      });
      lines.push(`- Added to #${item.link}: ${item.title}`);
      continue;
    }
    const filed = await rest<Issue>('POST', `/repos/${job.repo}/issues`, {
      title: item.title,
      body: `${item.body}\n\n${from}`,
      // Not `retro`: that label makes a plan triage the issue again instead of building it.
      labels: [FILED_LABEL],
    });
    await proposePriority(job.repo, filed.node_id, item.priority);
    if (item.start === 'plan')
      await rest('POST', `/repos/${job.repo}/issues/${filed.number}/labels`, {
        labels: [STAGE_LABELS.plan],
      });
    lines.push(
      `- Filed #${filed.number} (${item.priority}), ${item.start === 'plan' ? 'planning now' : 'in the backlog'}`,
    );
  }
  await rest('PATCH', `/repos/${job.repo}/issues/${job.issue.number}`, {
    state: 'closed',
    state_reason: 'completed',
  });
  return [
    marker(job.role),
    `**Retro triage filed${triage.length ? '' : ': nothing to file'}**`,
    lines.join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** This pipeline run's page. */
function runUrl(): string {
  return `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
}

/** An issue a stage filed or found for the card. */
export interface Filed {
  number: number;
  title: string;
  blockedBy: number[];
}

/**
 * The issues an earlier try filed for the card, found by the marker that ends
 * their body. Each was filed after the card, so it was updated since then too.
 * Only operator issues or labelled pipeline issues count: anyone may copy a marker.
 */
async function filedBefore(job: Job, card: Issue, mark: string): Promise<Issue[]> {
  const since = encodeURIComponent(card.created_at);
  return (await restAll<Issue>(`/repos/${job.repo}/issues?state=all&since=${since}`)).filter(
    (i) => (i.user?.id === OPERATOR_ID || filedByPipeline(i)) && i.body?.includes(mark),
  );
}

/**
 * Files or finds each subtask, links it as a native sub-issue of the card, and
 * puts a new one in Ask. A retry only files and links what is missing, so it
 * never moves a subtask that has started back to Ask.
 */
export async function fileSubtasks(job: Job, card: Issue, subtasks: Subtask[]): Promise<Filed[]> {
  for (const [index, subtask] of subtasks.entries()) {
    if (subtask.blockedBy?.some((blocker) => blocker < 0 || blocker >= index))
      throw new Error(`Subtask ${index}'s blockedBy must name an earlier subtask.`);
    // Retries find filed subtasks by title, so a repeat would map two subtasks to one issue.
    if (subtasks.findIndex((other) => other.title === subtask.title) !== index)
      throw new Error(`Subtask ${index} repeats the title "${subtask.title}".`);
  }
  const mark = subtaskMarker(card.number);
  const earlier = await filedBefore(job, card, mark);
  const path = `/repos/${job.repo}/issues/${card.number}/sub_issues`;
  const linked = new Set((await restAll<{ id: number }>(path)).map((i) => i.id));
  const filed: Issue[] = [];
  for (const subtask of subtasks) {
    const issue =
      earlier.find((i) => i.title === subtask.title) ??
      (await rest<Issue>('POST', `/repos/${job.repo}/issues`, {
        title: subtask.title,
        body: [subtask.body, `Part of #${card.number}.`, mark].join('\n\n'),
        labels: [FILED_LABEL],
      }));
    if (!linked.has(issue.id)) {
      // The numeric id, not the number.
      await rest('POST', path, { sub_issue_id: issue.id });
      await setStatus(job.repo, issue.node_id, 'Ask');
    }
    filed.push(issue);
  }
  for (const [index, subtask] of subtasks.entries()) {
    if (!subtask.blockedBy?.length) continue;
    const path = `/repos/${job.repo}/issues/${filed[index]!.number}/dependencies/blocked_by`;
    const existing = new Set((await restAll<{ id: number }>(path)).map((issue) => issue.id));
    for (const blocker of subtask.blockedBy) {
      const id = filed[blocker]!.id;
      if (existing.has(id)) continue;
      await rest('POST', path, { issue_id: id });
      existing.add(id);
    }
  }
  return filed.map((issue, index) => ({
    number: issue.number,
    title: issue.title,
    blockedBy: (subtasks[index]!.blockedBy ?? []).map((blocker) => filed[blocker]!.number),
  }));
}

/** What the stage comment says about its follow-ups, drops included, or '' when there are none. */
export function followupLine(count: number): string {
  if (count === 0) return '';
  const filed = Math.min(count, FOLLOWUP_CAP);
  const dropped = count - filed;
  return [
    `Filed ${filed} follow-up${filed > 1 ? 's' : ''}, listed below.`,
    dropped > 0 &&
      `${dropped} more ${dropped > 1 ? 'were' : 'was'} dropped: the cap is ${FOLLOWUP_CAP} per stage.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Files or finds the stage's first FOLLOWUP_CAP follow-ups, puts a new one in
 * Ask, and lists every follow-up the stage has filed in the card's
 * `followups:<stage>` comment. A follow-up carries only `agent:filed`, which
 * starts nothing. Returns the stage comment's line.
 */
export async function fileFollowups(
  job: Job,
  card: Issue,
  stage: string,
  followups: Followup[],
): Promise<string> {
  if (!followups.length) return '';
  const mark = followupMarker(card.number, stage);
  const earlier = await filedBefore(job, card, mark);
  const from = `From #${card.number}'s \`${stage}\` stage ([run](${runUrl()})).`;
  const filed = new Map(earlier.map((issue) => [issue.number, issue]));
  for (const followup of followups.slice(0, FOLLOWUP_CAP)) {
    let issue = earlier.find((i) => i.title === followup.title);
    if (!issue) {
      issue = await rest<Issue>('POST', `/repos/${job.repo}/issues`, {
        title: followup.title,
        body: [followup.body, from, mark].join('\n\n'),
        labels: [FILED_LABEL],
      });
      await setStatus(job.repo, issue.node_id, 'Ask');
    }
    filed.set(issue.number, issue);
  }
  const lines = [...filed.values()]
    .sort((a, b) => a.number - b.number)
    .map((issue) => `- #${issue.number} ${issue.title}`);
  const role = `followups:${stage}`;
  await upsertStageComment(
    job.repo,
    card.number,
    role,
    [marker(role), `**Follow-ups from the \`${stage}\` stage**`, lines.join('\n')].join('\n\n'),
  );
  return followupLine(followups.length);
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

export interface MemoryChange {
  path: string;
  text: string | null;
  evidence: string[];
}

/** Validate the whole proposal before any file in the store is touched. */
export function memoryChanges(out: string, repo: string): MemoryChange[] {
  const root = join(out, 'memory');
  const changes: MemoryChange[] = [];
  const invalid = (file: string, why: string): never => {
    throw new Error(`memory/${file}: ${why}`);
  };
  const inspect = (file: string) => {
    const stat = lstatSync(join(root, file));
    if (stat.isSymbolicLink()) invalid(file, 'symlink refused');
    return stat;
  };
  // existsSync follows symlinks, including broken ones. Inspect the directory entry itself.
  if (!readdirSync(out).includes('memory')) return [];
  if (!inspect('').isDirectory()) invalid('', 'expected directory');
  for (const folder of readdirSync(root)) {
    if (!['_org', repo.split('/')[1]].includes(folder)) invalid(folder, 'outside the memory slice');
    if (!inspect(folder).isDirectory()) invalid(folder, 'expected directory');
    for (const name of readdirSync(join(root, folder))) {
      const file = `${folder}/${name}`;
      if (!inspect(file).isFile() || !/^[a-z0-9][a-z0-9._-]*\.md(\.delete)?$/.test(name))
        invalid(file, 'invalid memory path');
      const text = readFileSync(join(root, file), 'utf8');
      const removed = name.endsWith('.delete');
      let evidence: string[] = [];
      if (removed && text.length) invalid(file, 'delete marker must be empty');
      if (!removed) {
        const entry = frontmatter(text);
        if (typeof entry === 'string') invalid(file, entry);
        else if (!entry.evidence.length) invalid(file, 'at least one evidence item is required');
        else evidence = entry.evidence.map(({ at }) => at);
      }
      const path = removed ? file.slice(0, -7) : file;
      if (changes.some((change) => change.path === path))
        invalid(file, 'conflicting writes and deletes');
      changes.push({ path, text: removed ? null : text, evidence });
    }
  }
  return changes;
}

export function memoryComment(jobs: Record<string, { result?: string }>, url: string): string {
  const failed = Object.entries(jobs)
    .filter(([, job]) => ['failure', 'cancelled'].includes(job.result ?? ''))
    .map(([id]) => id);
  return `${marker('memory')}\n\n**Memory stopped:** ${failed.join(', ') || 'unknown'}. See [run](${url}).\n\n@${OPERATOR_LOGIN}`;
}

export async function publishMemory(
  job: Job,
  result: Result,
  out: string,
  checkout: string,
  changed?: string[],
): Promise<void> {
  if (result.status !== 'complete' || !['implemented', 'answered'].includes(result.outcome ?? ''))
    throw new Error(`Memory did not complete: ${result.summary}`);
  const changes = memoryChanges(out, job.repo);
  if (!changes.length) return;
  if (result.outcome !== 'implemented')
    throw new Error('Memory wrote files without reporting implemented.');
  if (!job.memory || git(checkout, ['rev-parse', 'HEAD']) !== job.memory)
    throw new Error('Memory checkout must be at job.memory.');
  const dir = join(checkout, 'memory');
  // The base is trusted, but following a stored symlink could still escape the slice.
  for (const path of new Set([
    'memory',
    ...changes.flatMap((change) => [
      `memory/${change.path.split('/')[0]}`,
      `memory/${change.path}`,
    ]),
  ])) {
    try {
      if (lstatSync(join(checkout, path)).isSymbolicLink())
        throw new Error(`${path}: symlink refused`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const actions: string[] = [];
  for (const change of changes) {
    const file = join(dir, change.path);
    if (change.text === null) {
      if (existsSync(file)) {
        rmSync(file);
        actions.push(`remove memory/${change.path}`);
      }
    } else {
      const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
      if (before === change.text) continue;
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, change.text);
      actions.push(`${before === null ? 'add' : 'change'} memory/${change.path}`);
    }
  }
  git(checkout, ['add', '--', 'memory']);
  // Keep path bytes intact and list both sides of a rename before checking the slice.
  const staged = gitBytes(checkout, [
    'diff',
    '--cached',
    '--name-only',
    '--no-renames',
    '-z',
  ]).toString('utf8');
  if (!staged) return;
  const stagedPaths = staged.split('\0').filter(Boolean);
  for (const path of stagedPaths) {
    if (!path.startsWith('memory/')) throw new Error(`${path}: staged path outside memory/.`);
  }
  const failures = await checkMemory(dir, {
    // Written entries must be verified even when their evidence was not changed by the PR.
    changed:
      changed === undefined
        ? undefined
        : [...new Set([...changed, ...changes.flatMap((change) => change.evidence)])],
    read: (at) => githubReader(at, process.env.CHECK_TOKEN),
  });
  const rules = denyRules('gingur-root/pipeline', stagedPaths, null, null);
  const output = failures.length
    ? failures.map((f) => `${f.file}: ${f.reason}`).join('\n')
    : 'Memory check passed.';
  const repo = job.repo.split('/')[1]!;
  const branch = `memory/${repo}-${job.issue.number}`;
  const title = `memory: ${repo}#${job.issue.number}`;
  git(checkout, ['commit', '-m', title], PIPELINE_BOT);
  git(checkout, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  const head = git(checkout, ['rev-parse', 'HEAD']);
  const body = [
    `From [${job.repo}#${job.issue.number}](https://github.com/${job.repo}/pull/${job.issue.number}).`,
    actions.map((action) => `- ${action}`).join('\n'),
    failures.length ? '**Memory check failed**' : '**Memory check passed**',
    rules.length &&
      `**Auto-merge denied; needs you: ${rules.map((rule) => `\`${rule}\``).join(', ')}**`,
    `\`\`\`text\n${output}\n\`\`\``,
  ]
    .filter(Boolean)
    .join('\n\n');
  const pipeline = 'gingur-root/pipeline';
  const path = `/repos/${pipeline}/pulls`;
  const [open] = await rest<
    {
      number: number;
      node_id: string;
      draft: boolean;
      auto_merge: object | null;
    }[]
  >('GET', `${path}?state=open&head=${encodeURIComponent(`gingur-root:${branch}`)}`);
  if (open) {
    await rest('PATCH', `${path}/${open.number}`, { title, body });
    if ((failures.length || rules.length) && open.auto_merge)
      await disableAutoMerge(pipeline, open);
    if (open.draft !== Boolean(failures.length))
      await graphql(
        failures.length
          ? 'mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{id}}}'
          : 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}',
        { id: open.node_id },
      );
    if (!failures.length && !rules.length) {
      if (open.auto_merge) await disableAutoMerge(pipeline, open);
      await merge(pipeline, open, head, 'auto');
    }
  } else {
    const created = await rest<{ node_id: string; number: number }>('POST', path, {
      title,
      body,
      head: branch,
      base: 'main',
      draft: Boolean(failures.length),
    });
    if (!failures.length && !rules.length) await merge(pipeline, created, head, 'auto');
  }
}

export async function publish(options: PublishOptions): Promise<void> {
  if (options.failed !== undefined) {
    const url = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
    await upsertStageComment(
      options.repo!,
      options.issue!,
      'memory',
      memoryComment(JSON.parse(options.failed), url),
    );
    return;
  }
  const job = Job.parse(JSON.parse(readFileSync(join(options.in, JOB_FILE), 'utf8')));
  const stage = stageName(job.role, options.round);
  summarizeUsage(stage, options.out);
  if (job.role === 'memory') {
    // This stage proposes from the recorded merged-PR snapshot. The publish
    // token writes pipeline only; the evidence token reads repository contents.
    const v = verdict(job, job.issue.revision, options.out);
    if ('stage' in v) throw new Error(`Memory stopped at ${v.stage}: ${v.reason}.`);
    const changed = readFileSync(join(options.in, 'changed.txt'), 'utf8')
      .split('\n')
      .filter(Boolean);
    await publishMemory(job, v.result, options.out, options.checkout!, changed);
    return;
  }
  const path = `/repos/${job.repo}/issues/${job.issue.number}`;
  const issue = await rest<Issue>('GET', path);
  // An approved retro triage has no build to check: render wrote it from the plan the gate approved.
  const triageFile = join(options.in, TRIAGE_FILE);
  if (job.role === 'build' && existsSync(triageFile)) {
    const body = await fileTriage(job, Triage.parse(JSON.parse(readFileSync(triageFile, 'utf8'))));
    await upsertStageComment(job.repo, job.issue.number, job.role, body);
    await removeLabel(job.repo, job.issue.number, STAGE_LABELS.build);
    await setStatus(job.repo, issue.node_id, 'Done');
    await settle(job.repo, job.issue.number, 'done');
    return;
  }
  if (job.role === 'critique') {
    await publishCriticism(job, issue, options);
    return;
  }
  let v = verdict(job, revision(issue.title, issue.body ?? ''), options.out);
  const reviewFile = join(options.in, REVIEW_FILE);
  if (job.role === 'repair' && 'result' in v && existsSync(reviewFile)) {
    const reason = repairMap(Result.parse(JSON.parse(readFileSync(reviewFile, 'utf8'))), v.result);
    if (reason)
      v = { stage: 'validate', reason: `${reason}\n\n${v.result.summary.replace(/\.$/, '')}` };
  }
  if (job.role === 'retro') {
    if ('stage' in v) throw new Error(`Retro stopped at ${v.stage}: ${v.reason}.`);
    await publishRetro(job, issue, v.result);
    return;
  }
  const ready = job.role === 'plan' && 'result' in v && readyToBuild(v.result);
  // A ready plan's subtasks make the card a story; a retro issue's plan triages instead.
  const subtasks =
    ready && 'result' in v && !job.artifacts.includes(ISSUES_FILE) ? (v.result.subtasks ?? []) : [];
  // A ready plan a dashboard Continue started goes straight to its build (devkit#99), unless it is a story.
  const assessment =
    ready && options.critique ? planCriticism(job, options.out, options.critique) : undefined;
  const criticismPassed =
    job.role === 'plan' &&
    'result' in v &&
    v.result.status === 'complete' &&
    criticismPasses(
      { critique: v.result.critique, criticism: assessment?.criticism ?? null },
      planRevision(readFileSync(join(options.out, PLAN_FILE), 'utf8')),
      job.issue.revision,
      job.source,
    );
  const handoff =
    ready && criticismPassed && !subtasks.length
      ? armedContinue(await readSteps(job.repo, job.issue.number))
      : null;
  const check =
    job.role === 'review'
      ? readVerifier(job, revision(issue.title, issue.body ?? ''), options)
      : null;
  const outcome =
    job.role === 'review'
      ? await publishReview(job, v, options, check)
      : job.role === 'research'
        ? await publishResearch(job, v, options.out)
        : job.role === 'replan'
          ? await publishReplan(job, v, options)
          : await publishBuildOrPlan(
              job,
              issue,
              v,
              options.out,
              options.checkout,
              handoff,
              subtasks,
              options,
              criticismPassed,
              assessment,
            );
  const { status, stopped } = outcome;
  const followups = 'result' in v ? (v.result.followups ?? []) : [];
  const body = [outcome.body, followupLine(followups.length)].filter(Boolean).join('\n\n');

  // A build's Ready is brief: its own review follows in the same run and has the last word.
  const waiting = status === 'Needs you' || (status === 'Ready' && job.role !== 'build');
  await upsertStageComment(job.repo, job.issue.number, job.role, waiting ? mention(body) : body);
  // A review after the build has no label left to remove.
  await removeLabel(
    job.repo,
    job.issue.number,
    STAGE_LABELS[job.role as keyof typeof STAGE_LABELS],
  );
  // As the App: the build's render accepts it only after the Continue (approval.ts).
  // Before the Status, so a failed add leaves the card in Planning for the loop, not stuck in Building.
  if (handoff) await rest('POST', `${path}/labels`, { labels: [STAGE_LABELS[handoff]] });
  await setStatus(job.repo, issue.node_id, status);
  if ('result' in v && v.result.priority)
    await proposePriority(job.repo, issue.node_id, v.result.priority);
  const receipt = receiptFor(job.role, status, stopped, 'result' in v && readyToBuild(v.result));
  if (receipt) await settle(job.repo, job.issue.number, receipt);
  // Last and best effort: a failed filing must not skip the review or the retro; a retry files only what is missing.
  try {
    await fileFollowups(job, issue, stage, followups);
  } catch (error) {
    console.log(
      `::warning::filing follow-ups failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // The run ended waiting on the operator; the workflow runs a retro (devkit#39).
  // A plan that asks questions is the normal flow, not trouble.
  if (
    status === 'Needs you' &&
    job.role !== 'plan' &&
    job.role !== 'replan' &&
    process.env.GITHUB_OUTPUT
  )
    appendFileSync(process.env.GITHUB_OUTPUT, 'retro=true\n');
  if (stopped || (job.role === 'plan' && assessment && !assessment.valid)) process.exitCode = 1;
}
