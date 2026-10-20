import { copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Job, JOB_FILE, PLAN_FILE, planRevision, RESULT_FILE } from './job.ts';
import { Result } from './result.ts';
import { ROLES, type RoleName } from './roles.ts';

export interface ChainOptions {
  role: RoleName;
  fromIn: string;
  fromOut?: string;
  out: string;
}

export function chain(options: ChainOptions): void {
  const job = Job.parse(JSON.parse(readFileSync(join(options.fromIn, JOB_FILE), 'utf8')));
  const planDir = options.fromOut ?? options.fromIn;
  const plan = readFileSync(join(planDir, PLAN_FILE), 'utf8');
  const criteria = options.fromOut
    ? Result.parse(JSON.parse(readFileSync(join(options.fromOut, RESULT_FILE), 'utf8'))).criteria
    : null;
  cpSync(options.fromIn, options.out, { recursive: true });
  if (options.fromOut) {
    for (const file of [PLAN_FILE, 'research.md', 'probe.json']) {
      if (existsSync(join(options.fromOut, file)))
        copyFileSync(join(options.fromOut, file), join(options.out, file));
    }
  }
  const checks = options.fromOut
    ? Object.fromEntries((criteria ?? []).map((criterion) => [criterion.id, criterion.check]))
    : (job.plan?.checks ?? {});
  writeFileSync(
    join(options.out, JOB_FILE),
    JSON.stringify(
      {
        ...job,
        role: options.role,
        objective: ROLES[options.role].objective,
        plan: { revision: planRevision(plan), criteria: Object.keys(checks), checks },
      },
      null,
      2,
    ) + '\n',
  );
}
