// What every provider shares: the input it runs, its environment, and its
// executable. Each provider's own checks fail loudly: a run that quietly picked
// up an account connector or an API key looks exactly like one that didn't.

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

import { BASE_ENV, EXECUTOR_ENV, type Executor } from '../constants.ts';
import type { Role } from '../roles.ts';

export type Env = Readonly<Record<string, string | undefined>>;

export interface RunInput {
  role: Role;
  prompt: string;
  cwd: string;
  emit(event: Record<string, unknown>): void;
}

/** Runs one role and returns whether it succeeded. */
export type Provider = (input: RunInput) => Promise<boolean>;

/**
 * The agent's whole environment: an allowlist, never the job's env. This is also
 * what keeps billing on the subscriptions: an API key in the job never reaches
 * the agent.
 */
export function agentEnv(executor: Executor, source: Env): Record<string, string> {
  const { pass, set } = EXECUTOR_ENV[executor];
  const env: Record<string, string> = {};
  for (const key of [...BASE_ENV, ...pass]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...set };
}

/** The runner's own install, so the SDKs never fetch or run a bundled binary. */
export function resolveExecutable(name: Executor, path: string | undefined): string {
  for (const dir of (path ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not in this directory
    }
  }
  throw new Error(`${name} is not on PATH.`);
}
