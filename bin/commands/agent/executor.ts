import { Option } from 'commander';

import type { RunOptions } from '../../agent/run.ts';
import { EXECUTORS } from '../../agent/constants.ts';
import { ROLES } from '../../agent/roles.ts';
import type { ParsedCommand } from '../../command.ts';

export default {
  kind: 'parsed',
  describe: 'Print the role’s effective executor',
  configure(command) {
    command
      .addOption(
        new Option('--role <role>', 'role to resolve')
          .choices(Object.keys(ROLES))
          .makeOptionMandatory(),
      )
      .addOption(
        new Option('--executor <executor>', "override the role's executor").choices(EXECUTORS),
      )
      .option('--in <dir>', 'job directory ($AGENT_IN), for a pipeline stage');
  },
  async run(options) {
    const { resolveRole } = await import('../../agent/run.ts');
    process.stdout.write(`${resolveRole(options).executor}\n`);
  },
} satisfies ParsedCommand<RunOptions>;
