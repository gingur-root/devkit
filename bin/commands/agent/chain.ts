import { Option } from 'commander';
import type { ChainOptions } from '../../agent/chain.ts';
import { ROLES } from '../../agent/roles.ts';
import type { ParsedCommand } from '../../command.ts';

export default {
  kind: 'parsed',
  describe: "Build the next stage's job from trusted inputs and plan artifacts",
  configure(command) {
    command
      .addOption(
        new Option('--role <role>', 'next role').choices(Object.keys(ROLES)).makeOptionMandatory(),
      )
      .requiredOption('--from-in <dir>', 'controller-rendered inputs')
      .option('--from-out <dir>', "previous stage's outputs")
      .requiredOption('--out <dir>', 'next stage inputs');
  },
  async run(options) {
    const { chain } = await import('../../agent/chain.ts');
    chain(options);
  },
} satisfies ParsedCommand<ChainOptions>;
