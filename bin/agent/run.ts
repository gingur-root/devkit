import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDERS, type RunOutput } from './providers/index.ts';
import { SUMMARY_WORDS, type Result, RESULT_JSON_SCHEMA } from './result.ts';
import type { Executor } from './constants.ts';
import { JOB_FILE, Job, RESULT_FILE, TRANSCRIPT_FILE } from './job.ts';
import { ROLES, type Role, type RoleName } from './roles.ts';

export interface RunOptions {
  role: RoleName;
  executor?: Executor;
  /** Default: the role's objective. */
  prompt?: string;
  cwd?: string;
  in?: string;
  out?: string;
}

const DEVKIT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The role, with its executor swapped when asked. A model belongs to one vendor, so a swap drops it. */
function resolveRole({ role: name, executor }: RunOptions): Role {
  const role: Role = ROLES[name];
  if (!executor || executor === role.executor) return role;
  return { ...role, executor, model: undefined };
}

/** The role's instruction files, each replaced by the repo's `.devkit/<path>` when it has one, then its skills. */
export function instructions(name: RoleName, role: Role, cwd: string): string {
  return [
    ...role.instructions.map((path) => {
      const override = join(cwd, '.devkit', path);
      return readFileSync(existsSync(override) ? override : join(DEVKIT_ROOT, path), 'utf8');
    }),
    ...skills(name, cwd),
  ]
    .map((text) => text.trim())
    .join('\n\n');
}

/** The names on a skill's `roles: plan, build` frontmatter line. */
export function skillRoles(text: string): string[] {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  return (/^roles:(.*)$/m.exec(front)?.[1] ?? '')
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
}

/**
 * Every `skills/<name>/SKILL.md` whose `roles` names the role. The repo's
 * `.devkit/skills/<name>/` replaces devkit's skill of that name or adds one.
 */
function skills(name: RoleName, cwd: string): string[] {
  const files = new Map<string, string>();
  for (const root of [join(DEVKIT_ROOT, 'skills'), join(cwd, '.devkit', 'skills')]) {
    if (!existsSync(root)) continue;
    for (const skill of readdirSync(root).sort()) {
      const file = join(root, skill, 'SKILL.md');
      if (existsSync(file)) files.set(skill, file);
    }
  }
  return [...files.values()]
    .map((file) => readFileSync(file, 'utf8'))
    .filter((text) => skillRoles(text).includes(name));
}

function stagePrompt(prompt: string, dirs: { in?: string; out?: string }): string {
  if (!dirs.in || !dirs.out) return prompt;
  return `${prompt}\n\nJob directory ($AGENT_IN): ${dirs.in}\nOutput directory ($AGENT_OUT): ${dirs.out}`;
}

/** The envelope for a run that returned none: `failed`, with the CLI's reason. */
export function failedResult(job: Job, output: RunOutput): Result {
  const failure = output.failure ?? { class: 'unknown', resetsAt: null };
  const words = `The agent stopped with no result: ${output.error ?? failure.class}`.split(/\s+/);
  return {
    job: job.job,
    role: job.role,
    inputs: {
      issue: job.issue.revision,
      plan: job.plan?.revision ?? null,
      base: job.base,
      candidate: job.candidate,
      artifacts: [],
    },
    outputs: { plan: null, candidate: null, artifacts: [] },
    status: 'failed',
    outcome: null,
    summary: words.slice(0, SUMMARY_WORDS).join(' '),
    evidence: [],
    changes: null,
    hypotheses: null,
    axes: null,
    criteria: null,
    probe: null,
    critique: null,
    docs: null,
    assumptions: [],
    questions: [],
    next: 'Fix the cause, then run the stage again.',
    findings: null,
    subtasks: null,
    followups: null,
    priority: null,
    triage: null,
    failure,
  };
}

export async function run(options: RunOptions): Promise<void> {
  const role = resolveRole(options);
  const cwd = resolve(options.cwd ?? '.');
  const dirs = {
    in: options.in && resolve(options.in),
    out: options.out && resolve(options.out),
  };
  // Also kept in the output directory, for a retro to read (devkit#39).
  const emit = (event: Record<string, unknown>) => {
    const line = `${JSON.stringify({ role: options.role, executor: role.executor, ...event })}\n`;
    process.stdout.write(line);
    if (dirs.out) appendFileSync(join(dirs.out, TRANSCRIPT_FILE), line);
  };
  let output: RunOutput;
  try {
    output = await PROVIDERS[role.executor]({
      role,
      instructions: instructions(options.role, role, cwd),
      prompt: stagePrompt(options.prompt ?? role.objective, dirs),
      cwd,
      ...dirs,
      schema: role.result ? RESULT_JSON_SCHEMA : undefined,
      emit,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', message });
    output = { ok: false, error: message };
  }
  // Written even when the run failed: publish validates it and names the stage.
  let result = output.result;
  if (result === undefined && !output.ok && role.result && dirs.in && dirs.out)
    result = failedResult(
      Job.parse(JSON.parse(readFileSync(join(dirs.in, JOB_FILE), 'utf8'))),
      output,
    );
  if (dirs.out && result !== undefined)
    writeFileSync(join(dirs.out, RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`);
  if (!output.ok) process.exitCode = 1;
}
