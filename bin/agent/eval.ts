// The eval set (devkit#42): fixed issues under the target repo's `eval/`, each
// taken through plan, build, review and repair the way the pipeline runs them,
// but locally and with no GitHub writes. A change to a role's instructions or
// skills shows its effect as two scorecards, one from main and one from its
// branch.

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { git, gitBytes } from '../git.ts';
import { EXECUTOR_ENV, type Executor } from './constants.ts';
import {
  CANDIDATE_FILE,
  ISSUE_FILE,
  JOB_FILE,
  type Job,
  PLAN_FILE,
  RESULT_FILE,
  revision,
  usage,
} from './job.ts';
import { passes, repairable, verdict } from './publish.ts';
import type { Result } from './result.ts';
import { ROLES, type RoleName } from './roles.ts';

/** The cases' folder in the target repo. It is removed before any agent runs. */
export const EVAL_DIR = 'eval';

const EVAL_REPAIR_ROUNDS = 2;

/** `eval/<case>/case.json`: what the plan should do with the issue. */
const Case = z.object({ plan: z.enum(['ready', 'needs-input']) }).strict();

export interface EvalOptions {
  /** The target repo's checkout, holding `eval/<case>/`. */
  repo: string;
  out: string;
  /** Comma-separated case names. Default: every case. */
  only?: string;
  executor?: Executor;
}

export interface Score {
  case: string;
  expected: z.infer<typeof Case>['plan'];
  /** The plan's outcome, or null when it stopped. */
  plan: string | null;
  /** The hidden check on the last candidate; null when nothing was built. */
  check: boolean | null;
  /** The last review's outcome. */
  review: string | null;
  /** The last review passed but the hidden check failed. */
  missed: boolean;
  repairs: number;
  /** The stage that stopped the case, and why. */
  stopped: string | null;
  tokens: { input: number; output: number };
  minutes: number;
}

const EVAL_IDENTITY = { name: 'eval', email: 'eval@localhost' };

const DEVKIT_BIN = fileURLToPath(new URL('../devkit.mjs', import.meta.url));

/**
 * A fresh repo with one commit: the target repo with the case's `seed/` laid
 * over it and `eval/` gone. No history, so no agent can read a check from git.
 */
function base(repo: string, caseDir: string, cwd: string): string {
  cpSync(repo, cwd, {
    recursive: true,
    filter: (src) => ![join(repo, '.git'), join(repo, EVAL_DIR)].includes(src),
  });
  const seed = join(caseDir, 'seed');
  if (existsSync(seed)) cpSync(seed, cwd, { recursive: true });
  git(cwd, ['init', '--quiet'], EVAL_IDENTITY);
  git(cwd, ['add', '-A'], EVAL_IDENTITY);
  git(cwd, ['commit', '--quiet', '-m', 'eval base'], EVAL_IDENTITY);
  return git(cwd, ['rev-parse', 'HEAD'], EVAL_IDENTITY);
}

/** The issue file: a `# title` line, then the body. */
function readIssue(file: string): { title: string; body: string } {
  const [head = '', ...rest] = readFileSync(file, 'utf8').split('\n');
  if (!head.startsWith('# ')) throw new Error(`${file} must start with a "# title" line.`);
  return { title: head.slice(2).trim(), body: rest.join('\n').trim() };
}

/** What the action's `env -i` passes on: the one credential each executor may see. */
function childEnv(): Record<string, string> {
  const keys = ['PATH', 'HOME', 'LANG', ...Object.values(EXECUTOR_ENV).flatMap((e) => e.pass)];
  return Object.fromEntries(
    keys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  );
}

type Stage = { result: Result; out: string } | { stopped: string };

export function evaluate(options: EvalOptions): Score[] {
  const repo = resolve(options.repo);
  const out = resolve(options.out);
  const root = join(repo, EVAL_DIR);
  const names = options.only
    ? options.only.split(',').map((name) => name.trim())
    : readdirSync(root).filter((name) => existsSync(join(root, name, 'case.json')));
  const scores: Score[] = [];
  for (const name of names.sort()) {
    const expected = Case.parse(
      JSON.parse(readFileSync(join(root, name, 'case.json'), 'utf8')),
    ).plan;
    let score: Score;
    try {
      score = runCase(repo, name, expected, join(out, name), options.executor);
    } catch (error) {
      // One broken case must not cost the rest of a run that takes hours.
      score = {
        ...emptyScore(name, expected),
        stopped: `eval: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    console.log(JSON.stringify(score));
    scores.push(score);
  }
  writeFileSync(join(out, 'scorecard.json'), `${JSON.stringify(scores, null, 2)}\n`);
  writeFileSync(join(out, 'scorecard.md'), scorecard(scores));
  return scores;
}

function emptyScore(name: string, expected: Score['expected']): Score {
  return {
    case: name,
    expected,
    plan: null,
    check: null,
    review: null,
    missed: false,
    repairs: 0,
    stopped: null,
    tokens: { input: 0, output: 0 },
    minutes: 0,
  };
}

function runCase(
  repo: string,
  name: string,
  expected: Score['expected'],
  work: string,
  executor?: Executor,
): Score {
  const started = Date.now();
  const caseDir = join(repo, EVAL_DIR, name);
  const issue = readIssue(join(caseDir, ISSUE_FILE));
  const issueText = `# ${issue.title}\n\n${issue.body}\n`;
  const cwd = join(work, 'repo');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  const source = base(repo, caseDir, cwd);
  const score = emptyScore(name, expected);

  const stage = (
    role: RoleName,
    id: string,
    fields: Partial<Job>,
    files: Record<string, string | Buffer>,
  ): Stage => {
    const job: Job = {
      job: `${role}-eval-${id}`,
      role,
      objective: ROLES[role].objective,
      repo: `eval/${name}`,
      issue: {
        number: 1,
        title: issue.title,
        revision: revision(issue.title, issue.body),
        bodySeen: true,
      },
      plan: null,
      source,
      base: null,
      candidate: null,
      memory: null,
      artifacts: [],
      operations: [],
      attemptLimit: null,
      baseMoved: false,
      ...fields,
    };
    const dir = join(work, id);
    const [inDir, outDir] = [join(dir, 'in'), join(dir, 'out')];
    mkdirSync(inDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(inDir, JOB_FILE), `${JSON.stringify(job, null, 2)}\n`);
    for (const [file, text] of Object.entries(files)) writeFileSync(join(inDir, file), text);
    const run = spawnSync(
      process.execPath,
      [
        DEVKIT_BIN,
        'agent',
        'run',
        '--role',
        role,
        ...(executor ? ['--executor', executor] : []),
        '--cwd',
        cwd,
        '--in',
        inDir,
        '--out',
        outDir,
      ],
      { env: childEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    writeFileSync(join(dir, 'events.jsonl'), run.stdout ?? '');
    const used = usage(run.stdout ?? '');
    score.tokens.input += used.input;
    score.tokens.output += used.output;
    // As agent.run's Candidate step: the whole change against the job's source.
    if (role === 'build' || role === 'repair') {
      git(cwd, ['add', '-A'], EVAL_IDENTITY);
      const patch = gitBytes(cwd, ['diff', '--cached', '--binary', job.source]);
      if (patch.length) writeFileSync(join(outDir, CANDIDATE_FILE), patch);
    }
    const v = verdict(job, job.issue.revision, outDir);
    return 'result' in v
      ? { result: v.result, out: outDir }
      : { stopped: `${v.stage}: ${v.reason}` };
  };
  const finish = (stopped: string | null): Score => {
    score.stopped = stopped;
    score.minutes = Math.round((Date.now() - started) / 6000) / 10;
    return score;
  };

  const plan = stage('plan', 'plan', {}, { [ISSUE_FILE]: issueText });
  if ('stopped' in plan) return finish(plan.stopped);
  score.plan = plan.result.outcome;
  // A plan that should have stopped to ask is scored on that alone.
  if (score.plan !== 'ready' || expected !== 'ready') return finish(null);

  const planText = readFileSync(join(plan.out, PLAN_FILE), 'utf8').trim();
  const approved = {
    revision: revision(planText),
    criteria: (plan.result.criteria ?? []).map((c) => c.id),
    checks: Object.fromEntries((plan.result.criteria ?? []).map((c) => [c.id, c.check])),
  };
  const planFiles = { [ISSUE_FILE]: issueText, [PLAN_FILE]: `${planText}\n` };

  // Commits what the build or repair left, then runs the hidden check on it.
  const commit = (message: string): string => {
    git(cwd, ['commit', '--quiet', '--allow-empty', '-m', message], EVAL_IDENTITY);
    const check = spawnSync('sh', [join(caseDir, 'check.sh')], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', BASE: source },
      encoding: 'utf8',
      timeout: 60_000,
    });
    writeFileSync(join(work, 'check.log'), `${check.stdout ?? ''}${check.stderr ?? ''}`);
    score.check = check.status === 0;
    git(cwd, ['reset', '--quiet', '--hard'], EVAL_IDENTITY);
    git(cwd, ['clean', '-fdxq'], EVAL_IDENTITY);
    return git(cwd, ['rev-parse', 'HEAD'], EVAL_IDENTITY);
  };

  const build = stage('build', 'build', { plan: approved, base: source }, planFiles);
  if ('stopped' in build) return finish(build.stopped);
  if (build.result.outcome !== 'implemented') return finish(`build: ${build.result.outcome}`);
  let candidate = commit('build');

  for (let round = 0; ; round++) {
    const patch = gitBytes(cwd, ['diff', '--binary', source, candidate]);
    const review = stage(
      'review',
      `review-${round}`,
      { plan: approved, source: candidate, base: source, candidate },
      { ...planFiles, [CANDIDATE_FILE]: patch },
    );
    // The review has Bash: drop anything it left before the next stage.
    git(cwd, ['reset', '--quiet', '--hard'], EVAL_IDENTITY);
    git(cwd, ['clean', '-fdxq'], EVAL_IDENTITY);
    if ('stopped' in review) return finish(review.stopped);
    score.review = review.result.outcome;
    if (passes(review.result)) {
      score.missed = score.check === false;
      return finish(null);
    }
    if (round >= EVAL_REPAIR_ROUNDS || !repairable(review.result)) return finish(null);

    const repair = stage(
      'repair',
      `repair-${round + 1}`,
      { plan: approved, source: candidate, base: source },
      {
        ...planFiles,
        'review.json': readFileSync(join(review.out, RESULT_FILE), 'utf8'),
      },
    );
    score.repairs = round + 1;
    if ('stopped' in repair) return finish(repair.stopped);
    if (repair.result.outcome !== 'implemented') return finish(`repair: ${repair.result.outcome}`);
    candidate = commit(`repair ${round + 1}`);
  }
}

function mark(ok: boolean | null): string {
  return ok === null ? '–' : ok ? 'yes' : 'no';
}

export function scorecard(scores: Score[]): string {
  const rows = scores.map((s) =>
    [
      s.case,
      `${s.plan ?? 'stopped'}${s.plan === s.expected ? '' : ` (wanted ${s.expected})`}`,
      mark(s.check),
      s.review ?? '–',
      s.missed ? 'yes' : '',
      String(s.repairs),
      `${Math.round(s.tokens.input / 1000)}k / ${Math.round(s.tokens.output / 1000)}k`,
      String(s.minutes),
      s.stopped ?? '',
    ].join(' | '),
  );
  const right = scores.filter((s) => s.plan === s.expected).length;
  const checked = scores.filter((s) => s.check !== null);
  return [
    '| Case | Plan | Check passes | Review | Missed by review | Repairs | Tokens in / out | Minutes | Stopped |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row} |`),
    '',
    `Plans right: ${right}/${scores.length}. Checks passing: ${checked.filter((s) => s.check).length}/${checked.length}. Missed by review: ${scores.filter((s) => s.missed).length}.`,
    '',
  ].join('\n');
}
