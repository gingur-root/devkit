import { Option } from 'commander';

import type { ParsedCommand } from '../../command.ts';

interface LoopOptions {
  repo: string;
  issue?: number;
  role?: 'plan' | 'build';
  jobs?: string;
  dryRun?: boolean;
}

export default {
  kind: 'parsed',
  describe:
    "One tick of the board loop: flag the run's stalled card, start the next plan (GH_TOKEN)",
  configure(command) {
    command
      .requiredOption('--repo <owner/name>', 'repository')
      .option('--issue <number>', 'the issue the ending run worked on', Number)
      .addOption(new Option('--role <role>', "the ending run's stage").choices(['plan', 'build']))
      .option('--jobs <json>', "the ending run's `toJSON(needs)`")
      .option('--dry-run', 'print the decisions without acting on them');
  },
  async run({ repo, issue, role, jobs, dryRun }) {
    const { loop } = await import('../../agent/loop.ts');
    if ((issue === undefined) !== (role === undefined))
      throw new Error('--issue and --role go together.');
    const ran =
      issue === undefined || !role
        ? undefined
        : { issue, role, jobs: JSON.parse(jobs ?? '{}') as Record<string, { result: string }> };
    await loop(repo, ran, !!dryRun);
  },
} satisfies ParsedCommand<LoopOptions>;
