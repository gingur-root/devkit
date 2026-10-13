// The controller's write side for one stage: check the result against the live
// contract, upsert the stage's marker comment, remove the trigger label and
// move the card to Needs you. Only this writes GitHub, and only with the App.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { setStatus } from './board.ts';
import { STAGE_LABELS } from './constants.ts';
import { rest, restAll } from './github.ts';
import { JOB_FILE, Job, PLAN_FILE, RESULT_FILE, revision } from './job.ts';
import { Result } from './result.ts';

export interface PublishOptions {
  in: string;
  out: string;
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

const PLAN_START = '<!-- devkit:plan:start -->';
const PLAN_END = '<!-- devkit:plan:end -->';

function marker(role: string): string {
  return `<!-- devkit:${role} -->`;
}

/** A result that may be published, or the stage it stopped at and why. */
type Verdict = { result: Result; plan: string } | { stage: string; reason: string };

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
    result.inputs.issue !== job.issue.revision
  ) {
    return { stage: 'contract', reason: 'the result is for a different job or issue revision' };
  }
  if (liveRevision !== job.issue.revision) {
    return {
      stage: 'contract',
      reason: 'the issue changed while the plan ran, so the plan is stale',
    };
  }
  const planFile = join(out, PLAN_FILE);
  if (result.status === 'complete' && !existsSync(planFile)) {
    return { stage: 'validate', reason: `the agent wrote no ${PLAN_FILE}` };
  }
  return { result, plan: existsSync(planFile) ? readFileSync(planFile, 'utf8').trim() : '' };
}

function planComment(job: Job, v: Verdict): string {
  if ('stage' in v) {
    return [
      marker(job.role),
      `**Plan stopped at \`${v.stage}\`:** ${v.reason}.`,
      'Fix the cause, then add `agent:plan` again.',
    ].join('\n\n');
  }
  const { result, plan } = v;
  const head =
    result.status === 'complete'
      ? `**Plan: ${result.outcome === 'ready' ? 'ready for `agent:build`' : 'needs your input'}**`
      : `**Plan ${result.status}**`;
  const questions = result.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const section = `${PLAN_START}\n${plan}\n${PLAN_END}`;
  const contract = {
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
    questions,
    section,
    `<!-- devkit:contract ${JSON.stringify(contract)} -->`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function publish(options: PublishOptions): Promise<void> {
  const job = Job.parse(JSON.parse(readFileSync(join(options.in, JOB_FILE), 'utf8')));
  const path = `/repos/${job.repo}/issues/${job.issue.number}`;
  const issue = await rest<Issue>('GET', path);
  const v = verdict(job, revision(issue.title, issue.body ?? ''), options.out);
  const body = planComment(job, v);

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
  await setStatus(job.repo, issue.node_id, 'Needs you');

  if ('stage' in v) process.exitCode = 1;
}
