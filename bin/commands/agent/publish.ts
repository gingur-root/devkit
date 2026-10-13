import type { PublishOptions } from '../../agent/publish.ts';
import type { ParsedCommand } from '../../command.ts';

export default {
  kind: 'parsed',
  describe:
    "Validate a stage's result and publish it: comment, label, Status, and a build's PR (GH_TOKEN)",
  configure(command) {
    command
      .requiredOption('--in <dir>', 'the job directory ($AGENT_IN)')
      .requiredOption('--out <dir>', "the agent's output directory ($AGENT_OUT)")
      .option('--checkout <dir>', "a build's target repo at the job's source, with push access");
  },
  async run(options) {
    const { publish } = await import('../../agent/publish.ts');
    await publish(options);
  },
} satisfies ParsedCommand<PublishOptions>;
