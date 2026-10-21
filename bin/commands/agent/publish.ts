import { InvalidArgumentError } from 'commander';

import { REPAIR_ROUNDS } from '../../agent/constants.ts';
import type { PublishOptions } from '../../agent/publish.ts';
import type { ParsedCommand } from '../../command.ts';

export default {
  kind: 'parsed',
  describe:
    "Validate a stage's result and publish it: comment, label, Status, a build's PR, a review (GH_TOKEN)",
  configure(command) {
    command
      .option('--in <dir>', 'the job directory ($AGENT_IN)')
      .option('--out <dir>', "the agent's output directory ($AGENT_OUT)")
      .option('--critique <dir>', 'critique parent directory, containing in and out')
      .option('--app-id <id>', 'pipeline App ID for criticism publication', Number)
      .option('--checkout <dir>', "a build's target repo at the job's source, with push access")
      .option('--round <n>', "a review's repair round: 0 for the build's review", Number)
      .option('--rounds <n>', 'the repair-round cap; default REPAIR_ROUNDS', (value) => {
        const rounds = Number(value);
        if (!Number.isInteger(rounds) || rounds < 0 || rounds > REPAIR_ROUNDS)
          throw new InvalidArgumentError(`--rounds must be an integer from 0 to ${REPAIR_ROUNDS}`);
        return rounds;
      })
      .option(
        '--ci-failed <checks>',
        "a review's round: the comma-separated checks that failed on CI",
      )
      .option('--verified <sha>', "a review's round: the commit CI passed on, empty if it failed")
      .option('--verifier-in <dir>', 'the verifier job directory')
      .option('--verifier-out <dir>', 'the verifier output directory')
      .option('--failed <json>', 'memory report: the calling jobs and results')
      .option('--repo <owner/name>', 'memory report: the merged PR repository')
      .option('--issue <n>', 'memory report: the merged PR number', Number);
  },
  async run(options) {
    if (options.failed === undefined && (!options.in || !options.out))
      throw new Error('--in and --out are required');
    if (options.failed !== undefined && (!options.repo || !options.issue))
      throw new Error('--repo and --issue are required for --failed');
    if (Boolean(options.verifierIn) !== Boolean(options.verifierOut))
      throw new Error('--verifier-in and --verifier-out must be supplied together');
    const { publish } = await import('../../agent/publish.ts');
    await publish(options);
  },
} satisfies ParsedCommand<PublishOptions>;
