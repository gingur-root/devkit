import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ParsedCommand } from '../../command.ts';

interface ValidateOptions {
  in: string;
  out: string;
}

export default {
  kind: 'parsed',
  describe: 'Validate a stage result against its job without publishing',
  configure(command) {
    command
      .requiredOption('--in <dir>', 'the job directory')
      .requiredOption('--out <dir>', 'the output directory');
  },
  async run(options) {
    const { Job, JOB_FILE } = await import('../../agent/job.ts');
    const { verdict } = await import('../../agent/publish.ts');
    const job = Job.parse(JSON.parse(readFileSync(join(options.in, JOB_FILE), 'utf8')));
    const checked = verdict(job, job.issue.revision, options.out);
    if ('stage' in checked) {
      console.error(`${checked.stage}: ${checked.reason}`);
      process.exitCode = 1;
    }
  },
} satisfies ParsedCommand<ValidateOptions>;
