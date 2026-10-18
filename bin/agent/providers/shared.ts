// What every provider shares: the input it runs, its environment, and its
// executable. Each provider's own checks fail loudly: a run that quietly picked
// up an account connector or an API key looks exactly like one that didn't.

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

import { BASE_ENV, EXECUTOR_ENV, type Executor } from '../constants.ts';
import type { Failure } from '../result.ts';
import type { Role } from '../roles.ts';
import type { RoleTools } from '../tools.ts';

export type Env = Readonly<Record<string, string | undefined>>;

export interface RunInput {
  role: Role;
  tools: RoleTools;
  /** The role's instructions, with the repo's overrides applied. */
  instructions: string;
  prompt: string;
  cwd: string;
  /** The job directory ($AGENT_IN) and the output directory ($AGENT_OUT), for a pipeline stage. */
  in?: string;
  out?: string;
  /** The result envelope's JSON Schema, when the role returns one. */
  schema?: Record<string, unknown>;
  emit(event: Record<string, unknown>): void;
}

export interface RunOutput {
  ok: boolean;
  /** The structured result, when a schema was given and the run returned one. */
  result?: unknown;
  /** Why a run that did not succeed stopped, as far as the CLI said. */
  failure?: Failure;
  /** The CLI's own error text, for the comment when the class is `unknown`. */
  error?: string;
}

/** Runs one role. */
export type Provider = (input: RunInput) => Promise<RunOutput>;

/** The directories outside the checkout the agent may read and write. */
export function stageDirs(input: RunInput): string[] {
  return [input.in, input.out].filter((dir): dir is string => dir !== undefined);
}

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
export function resolveExecutable(name: string, path: string | undefined): string {
  for (const dir of (path ?? '').split(delimiter)) {
    // An empty entry means the current directory, which is the checked-out repo.
    if (!dir) continue;
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

/** An API error's class from its HTTP status. */
export function statusFailure(status: number): Failure['class'] {
  if (status === 429) return 'rate_limit';
  if (status === 529) return 'overloaded';
  return status >= 500 ? 'server_error' : 'unknown';
}
