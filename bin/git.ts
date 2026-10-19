// git, run without a shell: arguments go straight to the binary, so nothing in
// them is ever interpreted.

import { execFileSync } from 'node:child_process';

export interface Identity {
  name: string;
  email: string;
}

/** Runs git in `cwd` and returns its trimmed output. `as` authors and commits any commit it makes. */
export function git(cwd: string, args: string[], as?: Identity): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: identityEnv(as) }).trim();
}

/**
 * Runs git without GH_TOKEN, so on the WSL desk `gh`'s credential helper uses
 * the operator's own login.
 */
export function gitAsOperator(cwd: string, args: string[]): string {
  const { GH_TOKEN: _, ...env } = process.env;
  return execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
}

/** Runs git in `cwd` and returns its raw output, for binary patches. */
export function gitBytes(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd });
}

function identityEnv(as: Identity | undefined): NodeJS.ProcessEnv {
  if (!as) return process.env;
  return {
    ...process.env,
    GIT_AUTHOR_NAME: as.name,
    GIT_AUTHOR_EMAIL: as.email,
    GIT_COMMITTER_NAME: as.name,
    GIT_COMMITTER_EMAIL: as.email,
  };
}
