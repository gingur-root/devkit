import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BACKENDS } from './backends.ts';
import { EXECUTORS, type Executor } from './constants.ts';
import { assertSubscriptionBilling } from './isolation.ts';
import { isRoleName, ROLES, type Role } from './roles.ts';

export interface RunOptions {
  role: string;
  executor?: string;
  prompt?: string;
  promptFile?: string;
  cwd?: string;
}

function isExecutor(name: string): name is Executor {
  return (EXECUTORS as readonly string[]).includes(name);
}

/** The role, with its executor swapped when asked. A model belongs to one vendor, so a swap drops it. */
function resolveRole(options: RunOptions): Role {
  if (!isRoleName(options.role))
    throw new Error(`Unknown role "${options.role}". Roles: ${Object.keys(ROLES).join(', ')}`);
  const role: Role = ROLES[options.role];
  if (!options.executor || options.executor === role.executor) return role;
  if (!isExecutor(options.executor))
    throw new Error(`Unknown executor "${options.executor}". Executors: ${EXECUTORS.join(', ')}`);
  return { ...role, executor: options.executor, model: undefined };
}

export async function run(options: RunOptions): Promise<void> {
  assertSubscriptionBilling(process.env);
  const role = resolveRole(options);
  if (Boolean(options.prompt) === Boolean(options.promptFile))
    throw new Error('Pass exactly one of --prompt or --prompt-file.');
  const prompt = options.prompt ?? readFileSync(options.promptFile as string, 'utf8');
  const emit = (event: Record<string, unknown>) =>
    process.stdout.write(
      `${JSON.stringify({ role: options.role, executor: role.executor, ...event })}\n`,
    );
  const ok = await BACKENDS[role.executor]({
    role,
    prompt,
    cwd: resolve(options.cwd ?? '.'),
    emit,
  });
  if (!ok) process.exitCode = 1;
}
