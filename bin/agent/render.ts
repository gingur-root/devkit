// Renders the job file and issue snapshot for one stage. The snapshot holds only
// trusted issue text and comments, so nobody else can steer an agent.
// A subtask's snapshot starts with its parent story, and a story never builds:
// each of its subtasks does (devkit#12).

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { render as memoryIndex } from '../memory/render.ts';
import { readSteps, refuseStart } from './approval.ts';
import {
  filedByPipeline,
  OPERATOR_ID,
  PIPELINE_BOT,
  RETRO_LABEL,
  STAGE_LABELS,
} from './constants.ts';
import { setStatus } from './board.ts';
import { removeLabel, rest, restAll, upsertStageComment } from './github.ts';
import {
  CHANGED_FILE,
  DIFF_FILE,
  PR_FILE,
  CONTRACT_PREFIX,
  ISSUE_FILE,
  ISSUES_FILE,
  JOB_FILE,
  MEMORY_DIR,
  TIMELINE_FILE,
  TOOLS_FILE,
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
import { MANIFEST_PATH } from './tools.ts';

const MEMORY_REPO = 'gingur-root/pipeline';
const CLOSED_ISSUE_STATE = 'closed';

/** Fetch the slice from one main commit, using the separate read-only token. */
async function memorySlice(options: RenderOptions): Promise<string | null> {
  const path = `/repos/${MEMORY_REPO}`;
  const token = process.env.MEMORY_TOKEN;
  // A missing repo or wrong-scoped token must fail, not look like an absent store.
  const { sha } = await rest<{ sha: string }>('GET', `${path}/commits/main`, undefined, token);
  const dir = join(options.out, MEMORY_DIR);
  rmSync(dir, { recursive: true, force: true });
  const contents = `${path}/contents/${MEMORY_DIR}`;
  const ref = `?ref=${encodeURIComponent(sha)}`;
  const store = await rest('GET', `${contents}${ref}`, undefined, token).catch((error: Error) => {
    if (!error.message.includes(' 404 ')) throw error;
    return null;
  });
  if (store === null) return null;
  mkdirSync(dir, { recursive: true });
  for (const folder of new Set(['_org', options.repo.split('/')[1]!])) {
    const folderPath = `${contents}/${encodeURIComponent(folder)}`;
    const files = await rest<{ name: string; type: string }[]>(
      'GET',
      `${folderPath}${ref}`,
      undefined,
      token,
    ).catch((error: Error) => {
      if (!error.message.includes(' 404 ')) throw error;
      return null;
    });
    if (files === null) continue;
    mkdirSync(join(dir, folder), { recursive: true });
    for (const file of files.filter((file) => file.type === 'file' && file.name.endsWith('.md'))) {
      const { content } = await rest<{ content: string }>(
        'GET',
        `${folderPath}/${encodeURIComponent(file.name)}${ref}`,
        undefined,
        token,
      );
      writeFileSync(join(dir, folder, file.name), Buffer.from(content, 'base64'));
    }
  }
  writeFileSync(join(dir, 'INDEX.md'), memoryIndex(dir));
  return sha;
}

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
  node_id?: string;
  title: string;
  labels: { name: string }[];
  pull_request?: unknown;
  sub_issues_summary?: { total: number };
  issue_dependencies_summary?: { total_blocked_by: number };
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
  /** Who requested the stage; may come from a dispatch input. Verified against issue history. */
  actor?: number;
  /** Who GitHub says triggered the workflow (`github.actor_id`). */
  dispatcher?: number;
  out: string;
}

function trustedComment(item: Authored, appId: number): boolean {
  // Agents can't post comments, so comment authorship still proves origin.
  return (
    item.user?.id === OPERATOR_ID ||
    item.user?.id === PIPELINE_BOT.id ||
    item.performed_via_github_app?.id === appId
  );
}

function trustedIssue(issue: Issue): boolean {
  return issue.user?.id === OPERATOR_ID || filedByPipeline(issue);
}

export function issueSnapshot(
  issue: Issue,
  comments: Authored[],
  appId: number,
  parent: Issue | null = null,
): string {
  const head = trustedIssue(issue)
    ? `# ${issue.title}\n\n${issue.body ?? ''}`
    : `# Issue #${issue.number}\n\n(Written by someone else, so left out.)`;
  const thread = comments
    .filter((comment) => trustedComment(comment, appId))
    .map((comment) => `## Comment, ${comment.created_at}\n\n${comment.body ?? ''}`);
  const snapshot = [head, ...thread].join('\n\n');
  if (!parent) return snapshot;
  // Only the story's title and body, so a subtask is planned within it.
  const story = trustedIssue(parent)
    ? `# Parent story #${parent.number}: ${parent.title}\n\n${parent.body ?? ''}`
    : `# Parent story #${parent.number}\n\n(Written by someone else, so left out.)`;
  return `${story}\n\n---\n\n${snapshot}`;
}

/** The issue's parent story, or null when it has none. */
async function parentOf(path: string): Promise<Issue | null> {
  return rest<Issue>('GET', `${path}/parent`).catch((error: Error) => {
    if (!error.message.includes(' 404 ')) throw error;
    return null;
  });
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

/** The repo's open issues a retro may link to: operator issues or labelled pipeline issues, as the snapshot. */
export function openIssues(issues: Issue[]): string {
  return issues
    .filter((i) => !i.pull_request && trustedIssue(i))
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
  bodySeen: boolean,
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
  if (contract.bodySeen === false && bodySeen)
    throw new Error('The plan was written without the issue body. Run `agent:plan` again.');
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

async function checkBlockers(options: RenderOptions, parent: Issue | null): Promise<void> {
  const blockers = await restAll<{
    id: number;
    number: number;
    state: string;
    html_url: string;
  }>(`/repos/${options.repo}/issues/${options.issue}/dependencies/blocked_by`);
  let siblings = new Set<number>();
  let contract: PlanContract | null = null;
  if (parent) {
    const path = `/repos/${options.repo}/issues/${parent.number}`;
    const [comments, subtasks] = await Promise.all([
      restAll<Authored>(`${path}/comments`),
      restAll<{ id: number }>(`${path}/sub_issues`),
    ]);
    siblings = new Set(subtasks.map((subtask) => subtask.id));
    try {
      contract = approvedPlan(
        comments,
        options.appId,
        revision(parent.title, parent.body ?? ''),
        trustedIssue(parent),
      ).contract;
    } catch {
      // An invalid or stale story plan cannot keep a sibling edge live.
      contract = null;
    }
  }
  const live: string[] = [];
  const ignored: string[] = [];
  for (const blocker of blockers) {
    const link = `[#${blocker.number}](${blocker.html_url})`;
    if (blocker.state === CLOSED_ISSUE_STATE) ignored.push(`${link} (closed)`);
    else if (
      parent &&
      siblings.has(blocker.id) &&
      !contract?.blockedBy?.[options.issue]?.includes(blocker.number)
    )
      ignored.push(`${link} (#${parent.number}'s plan no longer names it)`);
    else live.push(link);
  }
  const note = ignored.length ? `Ignored blockers: ${ignored.join(', ')}.` : '';
  if (live.length) throw new Error(`Blocked by ${live.join(', ')}.${note ? `\n\n${note}` : ''}`);
  if (note)
    await upsertStageComment(
      options.repo,
      options.issue,
      'blockers',
      `${marker('blockers')}\n\n${note}`,
    );
}

export interface ChangedFile {
  filename: string;
  previous_filename?: string;
  status: string;
  patch?: string;
}

export function changedFiles(repo: string, files: ChangedFile[]): string[] {
  return [
    ...new Set(
      files
        .flatMap((file) => [
          file.filename,
          ...(file.previous_filename ? [file.previous_filename] : []),
        ])
        .map((path) => `${repo}:${path}`),
    ),
  ];
}

interface MergedPull {
  number: number;
  title: string;
  body: string | null;
  user: { id: number } | null;
  merged: boolean;
  merge_commit_sha: string;
}

function trustedPull(pull: MergedPull): boolean {
  return pull.user?.id === OPERATOR_ID || pull.user?.id === PIPELINE_BOT.id;
}

async function renderMemory(options: RenderOptions): Promise<Job> {
  const path = `/repos/${options.repo}/pulls/${options.issue}`;
  const pull = await rest<MergedPull>('GET', path);
  if (!pull.merged || !pull.merge_commit_sha) throw new Error('Memory needs a merged PR.');
  const files = await restAll<ChangedFile>(`${path}/files`);
  const bodySeen = trustedPull(pull);
  const linked: string[] = [];
  if (bodySeen) {
    const numbers = new Set(
      [...(pull.body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map(
        (match) => Number(match[1]),
      ),
    );
    for (const number of numbers) {
      const issuePath = `/repos/${options.repo}/issues/${number}`;
      const issue = await rest<Issue>('GET', issuePath);
      const comments = await restAll<Authored>(`${issuePath}/comments`);
      linked.push(issueSnapshot(issue, comments, options.appId));
    }
  }
  mkdirSync(options.out, { recursive: true });
  const job: Job = {
    job: `memory-${process.env.GITHUB_RUN_ID ?? 'local'}`,
    role: 'memory',
    objective: ROLES.memory.objective,
    repo: options.repo,
    issue: {
      number: pull.number,
      title: pull.title,
      revision: revision(pull.title, pull.body ?? '', pull.merge_commit_sha),
      bodySeen,
    },
    source: pull.merge_commit_sha,
    base: null,
    candidate: null,
    plan: null,
    memory: await memorySlice(options),
    artifacts: [PR_FILE, DIFF_FILE, CHANGED_FILE, 'check.txt'],
    operations: [],
    attemptLimit: null,
  };
  const text = [
    `# PR #${pull.number}${bodySeen ? `: ${pull.title}` : ''}`,
    `Merge commit: ${pull.merge_commit_sha}`,
    bodySeen ? (pull.body ?? '') : '(Written by someone else, so left out.)',
    '## Changed files',
    ...files.map(
      (file) =>
        `- ${file.status}: ${file.filename}${file.previous_filename ? ` (was ${file.previous_filename})` : ''}`,
    ),
    ...linked,
  ].join('\n\n');
  writeFileSync(join(options.out, PR_FILE), `${text}\n`);
  writeFileSync(join(options.out, ISSUE_FILE), `${text}\n`);
  const diff = Buffer.from(
    files
      .map(
        (file) =>
          `diff --git a/${file.previous_filename ?? file.filename} b/${file.filename}\n${file.patch ?? '(patch unavailable)'}\n`,
      )
      .join('\n'),
  );
  const limit = 200 * 1024;
  // Drop a partial UTF-8 character at the boundary before appending the note.
  let capped = diff.subarray(0, limit).toString('utf8');
  if (diff.length > limit) capped = capped.replace(/\uFFFD$/, '') + '\n(diff cut at 200 KB)\n';
  writeFileSync(join(options.out, DIFF_FILE), capped);
  writeFileSync(
    join(options.out, CHANGED_FILE),
    `${changedFiles(options.repo, files).join('\n')}\n`,
  );
  writeFileSync(join(options.out, JOB_FILE), `${JSON.stringify(job, null, 2)}\n`);
  // Memory needs no repository tool manifest or plan from an earlier stage.
  for (const file of [TOOLS_FILE, PLAN_FILE, TRIAGE_FILE])
    rmSync(join(options.out, file), { force: true });
  return job;
}

export async function render(options: RenderOptions): Promise<Job> {
  if (options.role === 'memory') return renderMemory(options);
  const source =
    options.source ||
    (await rest<{ sha: string }>('GET', `/repos/${options.repo}/commits/HEAD`)).sha;
  const path = `/repos/${options.repo}/issues/${options.issue}`;
  const [issue, comments, parent] = await Promise.all([
    rest<Issue>('GET', path),
    restAll<Authored>(`${path}/comments`),
    parentOf(path),
  ]);
  const issueRevision = revision(issue.title, issue.body ?? '');
  const bodySeen = trustedIssue(issue);
  const retroPlan =
    options.role === 'plan' && issue.labels.some((label) => label.name === RETRO_LABEL);
  // One run never carries out a whole story: each subtask builds on its own.
  const subtasks = issue.sub_issues_summary?.total ?? 0;
  const story = options.role === 'build' && subtasks > 0;
  // A retro reads whatever the run left, ready plan or not.
  let approved: ReturnType<typeof approvedPlan> | null = null;
  if (options.role !== 'plan' && options.role !== 'retro') {
    try {
      if (options.role === 'build' && options.dispatcher !== OPERATOR_ID) {
        // No actor fails closed: it is neither the operator nor the App.
        const why = refuseStart(
          options.actor ?? Number.NaN,
          await readSteps(options.repo, options.issue),
          'build',
        );
        if (why) throw new Error(`Not approved: ${why}.`);
      }
      approved = approvedPlan(comments, options.appId, issueRevision, bodySeen);
      if (story)
        throw new Error(
          `This card is a story with ${subtasks} subtasks. Build each subtask instead.`,
        );
      if (options.role === 'build' && (issue.issue_dependencies_summary?.total_blocked_by ?? 0) > 0)
        await checkBlockers(options, parent);
    } catch (error) {
      // The refusal itself still fails the job, even if saying so on the issue fails.
      await refuse(options, (error as Error).message).catch(console.error);
      // Approved, so the story itself is why: it waits on the operator.
      if (story && approved) await setStatus(options.repo, issue.node_id!, 'Needs you');
      throw error;
    }
  }
  const base = approved && (options.base ?? source);
  const ref = base ?? source;
  const manifest = await rest<{ content: string }>(
    'GET',
    `/repos/${options.repo}/contents/${MANIFEST_PATH}?ref=${encodeURIComponent(ref)}`,
  ).catch((error: Error) => {
    if (!error.message.includes(' 404 ')) throw error;
    return null;
  });
  const job: Job = {
    job: `${options.role}-${process.env.GITHUB_RUN_ID ?? 'local'}`,
    role: options.role,
    objective: ROLES[options.role].objective,
    repo: options.repo,
    issue: {
      number: issue.number,
      title: issue.title,
      revision: issueRevision,
      bodySeen,
    },
    plan: approved && {
      revision: approved.contract.planRevision,
      criteria: Object.keys(approved.contract.checks),
    },
    // A build works from the default branch as it is now, not the plan's older source.
    source,
    base,
    // A review checks out the candidate itself.
    candidate: options.role === 'review' ? source : null,
    memory: await memorySlice(options),
    // Publish reads this to hold a retro issue's plan to its triage.
    artifacts: retroPlan ? [ISSUES_FILE] : [],
    operations: [],
    attemptLimit: null,
  };
  mkdirSync(options.out, { recursive: true });
  if (manifest)
    writeFileSync(join(options.out, TOOLS_FILE), Buffer.from(manifest.content, 'base64'));
  else rmSync(join(options.out, TOOLS_FILE), { force: true });
  writeFileSync(join(options.out, JOB_FILE), `${JSON.stringify(job, null, 2)}\n`);
  writeFileSync(
    join(options.out, ISSUE_FILE),
    `${issueSnapshot(issue, comments, options.appId, parent)}\n`,
  );
  if (approved) writeFileSync(join(options.out, PLAN_FILE), `${approved.plan}\n`);
  if (approved?.contract.triage)
    writeFileSync(join(options.out, TRIAGE_FILE), `${JSON.stringify(approved.contract.triage)}\n`);
  if (retroPlan)
    writeFileSync(
      join(options.out, ISSUES_FILE),
      `${openIssues(await restAll<Issue>(`/repos/${options.repo}/issues?state=open`))}\n`,
    );
  if (options.role === 'retro')
    writeFileSync(
      join(options.out, TIMELINE_FILE),
      `${timeline(await restAll<Event>(`${path}/timeline`))}\n`,
    );
  return job;
}
