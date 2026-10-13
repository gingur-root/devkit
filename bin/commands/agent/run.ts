import type { ParsedCommand } from '../../command.ts';
import type { RunOptions } from '../../agent/run.ts';

export default {
  kind: 'parsed',
  describe: 'Run one agent role, isolated to what the role declares, on the subscription login',
  configure(command) {
    command
      .requiredOption('--role <role>', 'role to run')
      .option('--executor <executor>', "override the role's executor (claude or codex)")
      .option('--prompt <text>', 'prompt text')
      .option('--prompt-file <path>', 'file holding the prompt')
      .option('--cwd <dir>', 'working directory for the agent', '.');
  },
  async run(options) {
    // The SDKs are optional peers; load them only when a run actually happens.
    const { run } = await import('../../agent/run.ts');
    await run(options);
  },
} satisfies ParsedCommand<RunOptions>;
