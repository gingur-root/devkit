import { resolve } from 'node:path';

import { PROVIDERS } from './providers/index.ts';
import type { Executor } from './constants.ts';
import { ROLES, type Role, type RoleName } from './roles.ts';

export interface RunOptions {
  role: RoleName;
  executor?: Executor;
  prompt: string;
  cwd?: string;
}

/** The role, with its executor swapped when asked. A model belongs to one vendor, so a swap drops it. */
function resolveRole({ role: name, executor }: RunOptions): Role {
  const role: Role = ROLES[name];
  if (!executor || executor === role.executor) return role;
  return { ...role, executor, model: undefined };
}

export async function run(options: RunOptions): Promise<void> {
  const role = resolveRole(options);
  const emit = (event: Record<string, unknown>) =>
    process.stdout.write(
      `${JSON.stringify({ role: options.role, executor: role.executor, ...event })}\n`,
    );
  let ok = false;
  try {
    ok = await PROVIDERS[role.executor]({
      role,
      prompt: options.prompt,
      cwd: resolve(options.cwd ?? '.'),
      emit,
    });
  } catch (error) {
    emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
  if (!ok) process.exitCode = 1;
}
