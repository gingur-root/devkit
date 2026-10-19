import type { ParsedCommand } from '../../command.ts';

interface CheckOptions {
  dir: string;
  changed?: string[];
  offline?: boolean;
}

export default {
  kind: 'parsed',
  describe: 'Check memory structure and cited evidence',
  configure(command) {
    command
      .requiredOption('--dir <dir>', 'memory directory')
      .option('--changed <owner/repo:path...>', 'check only evidence at these changed files')
      .option('--offline', 'skip evidence reads');
  },
  async run({ dir, changed, offline }) {
    const { check } = await import('../../memory/check.ts');
    const failures = await check(dir, { changed, offline });
    for (const { file, reason } of failures) console.log(`${file}: ${reason}`);
    if (failures.length) process.exitCode = 1;
  },
} satisfies ParsedCommand<CheckOptions>;
