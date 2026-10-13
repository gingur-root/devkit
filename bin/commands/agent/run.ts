import { Option } from 'commander';

import type { RunOptions } from '../../agent/run.ts';
import { EXECUTORS } from '../../agent/constants.ts';
import { ROLES } from '../../agent/roles.ts';
import type { ParsedCommand } from '../../command.ts';

export default {
  kind: 'parsed',
  describe: 'Run one agent role, isolated to what the role declares, on the subscription login',
  configure(command) {
    command
      .addOption(
        new Option('--role <role>', 'role to run')
          .choices(Object.keys(ROLES))
          .makeOptionMandatory(),
      )
      .addOption(
        new Option('--executor <executor>', "override the role's executor").choices(EXECUTORS),
      )
      .option('--prompt <text>', "prompt text (default: the role's objective)")
      .option('--cwd <dir>', 'working directory for the agent', '.')
      .option('--in <dir>', 'job directory ($AGENT_IN), for a pipeline stage')
      .option('--out <dir>', 'output directory ($AGENT_OUT), for a pipeline stage');
  },
  async run(options) {
    // The SDKs are optional peers; load them only when a run actually happens.
    const { run } = await import('../../agent/run.ts');
    await run(options);
  },
} satisfies ParsedCommand<RunOptions>;
