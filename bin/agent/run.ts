import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDERS } from './providers/index.ts';
import type { Executor } from './constants.ts';
import { RESULT_FILE } from './job.ts';
import { RESULT_JSON_SCHEMA } from './result.ts';
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

/** The role's instruction files, each replaced by the repo's `.devkit/<path>` when it has one. */
export function instructions(role: Role, cwd: string): string {
  return role.instructions
    .map((path) => {
      const override = join(cwd, '.devkit', path);
      return readFileSync(existsSync(override) ? override : join(DEVKIT_ROOT, path), 'utf8').trim();
    })
    .join('\n\n');
}

function stagePrompt(prompt: string, dirs: { in?: string; out?: string }): string {
  if (!dirs.in || !dirs.out) return prompt;
  return `${prompt}\n\nJob directory ($AGENT_IN): ${dirs.in}\nOutput directory ($AGENT_OUT): ${dirs.out}`;
}

export async function run(options: RunOptions): Promise<void> {
  const role = resolveRole(options);
  const cwd = resolve(options.cwd ?? '.');
  const dirs = {
    in: options.in && resolve(options.in),
    out: options.out && resolve(options.out),
  };
  const emit = (event: Record<string, unknown>) =>
    process.stdout.write(
      `${JSON.stringify({ role: options.role, executor: role.executor, ...event })}\n`,
    );
  let ok = false;
  try {
    const output = await PROVIDERS[role.executor]({
      role,
      instructions: instructions(role, cwd),
      prompt: stagePrompt(options.prompt ?? role.objective, dirs),
      cwd,
      ...dirs,
      schema: role.result ? RESULT_JSON_SCHEMA : undefined,
      emit,
    });
    ok = output.ok;
    // Written even when the run failed: publish validates it and names the stage.
    if (dirs.out && output.result !== undefined) {
      writeFileSync(join(dirs.out, RESULT_FILE), `${JSON.stringify(output.result, null, 2)}\n`);
    }
  } catch (error) {
    emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
  if (!ok) process.exitCode = 1;
}
