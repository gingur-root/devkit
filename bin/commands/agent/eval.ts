import { Option } from 'commander';

import { EXECUTORS } from '../../agent/constants.ts';
import type { EvalOptions } from '../../agent/eval.ts';
import type { ParsedCommand } from '../../command.ts';

export default {
  kind: 'parsed',
  describe:
    "Run the eval set: each case in the repo's eval/ through plan, build, review and repair, locally",
  configure(command) {
    command
      .requiredOption('--repo <dir>', 'the target repo checkout, with eval/<case>/')
      .requiredOption('--out <dir>', 'where each case runs and the scorecard goes')
      .option('--only <cases>', 'comma-separated case names (default: all)')
      .addOption(
        new Option(
          '--executor <executor>',
          "override every role's executor; `stub` for a smoke run",
        ).choices(EXECUTORS),
      );
  },
  async run(options) {
    const { evaluate } = await import('../../agent/eval.ts');
    evaluate(options);
  },
} satisfies ParsedCommand<EvalOptions>;
