import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDERS, type RunOutput } from './providers/index.ts';
import { SUMMARY_WORDS, type Result, RESULT_JSON_SCHEMA } from './result.ts';
import type { Executor } from './constants.ts';
import { JOB_FILE, Job, OVERRIDES_DIR, ROLES_FILE, RESULT_FILE, TRANSCRIPT_FILE } from './job.ts';
import { ROLES, RoleOverrides, type Role, type RoleName } from './roles.ts';
import { resolveExecutable } from './providers/shared.ts';
import { loadTools, renderTools } from './tools.ts';

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

/** Trusted repo settings apply before the flag. A model belongs to one vendor, so a swap drops it. */
export function resolveRole({ role: name, executor, in: inDir }: RunOptions): Role {
  let role: Role = ROLES[name];
  const file = inDir && join(inDir, ROLES_FILE);
  const override =
    file && existsSync(file)
      ? RoleOverrides.parse(JSON.parse(readFileSync(file, 'utf8')))[name]
      : undefined;
  if (override) {
    if (override.executor && override.executor !== role.executor)
      role = { ...role, executor: override.executor, model: undefined };
    role = {
      ...role,
      model: override.model === undefined ? role.model : (override.model ?? undefined),
      effort: override.effort ?? role.effort,
    };
  }
  if (!executor || executor === role.executor) return role;
  return { ...role, executor, model: undefined };
}

/** The role's instruction files and skills, with overrides from the job's trusted snapshot. */
export function instructions(name: RoleName, role: Role, overrides: string | undefined): string {
  return [
    ...role.instructions.map((path) => {
      const override = overrides && join(overrides, path);
      return readFileSync(
        override && existsSync(override) ? override : join(DEVKIT_ROOT, path),
        'utf8',
      );
    }),
    ...skills(name, overrides),
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
 * Every `skills/<name>/SKILL.md` whose `roles` names the role. The job's trusted
 * `overrides/skills/<name>/` replaces devkit's skill of that name or adds one.
 */
function skills(name: RoleName, overrides: string | undefined): string[] {
  const files = new Map<string, string>();
  for (const root of [join(DEVKIT_ROOT, 'skills'), overrides && join(overrides, 'skills')]) {
    if (!root || !existsSync(root)) continue;
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

/** A run that returned no result when the role needs one has failed, whatever the CLI said. */
export function settle(output: RunOutput, schema: boolean): RunOutput {
  if (schema && output.ok && output.result === undefined)
    return { ok: false, error: 'the agent finished without a structured result' };
  return output;
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
    merge: null,
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
  const tools = loadTools(dirs.in);
  for (const name of tools.clis) resolveExecutable(name, process.env.PATH);
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
      tools: renderTools(tools, options.role),
      instructions: instructions(options.role, role, dirs.in && join(dirs.in, OVERRIDES_DIR)),
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
  output = settle(output, role.result);
  // Written even when the run failed: publish validates it and names the stage.
  let result = output.result;
  // Agents cannot forge account-wide holds; only the provider reports failures.
  if (result !== null && typeof result === 'object' && !Array.isArray(result))
    result = { ...result, failure: null };
  if ((result === undefined || output.failure) && role.result && dirs.in && dirs.out)
    result = failedResult(
      Job.parse(JSON.parse(readFileSync(join(dirs.in, JOB_FILE), 'utf8'))),
      output,
    );
  if (dirs.out && result !== undefined)
    writeFileSync(join(dirs.out, RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`);
  if (!output.ok) process.exitCode = 1;
}
