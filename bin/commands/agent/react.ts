import { Option } from 'commander';

import type { Receipt } from '../../agent/reactions.ts';
import type { ParsedCommand } from '../../command.ts';

interface ReactOptions {
  repo: string;
  issue: number;
  comment?: number;
  end?: Receipt;
}

export default {
  kind: 'parsed',
  describe: "Add the run's 👀 receipt, or swap it for its end state (GH_TOKEN; never fails)",
  configure(command) {
    command
      .requiredOption('--repo <owner/name>', 'repository')
      .requiredOption('--issue <number>', 'issue number', Number)
      .option('--comment <id>', 'the comment that started the run; default the issue', Number)
      .addOption(
        new Option('--end <receipt>', "swap the writer's 👀 for this end state").choices([
          'done',
          'question',
          'failed',
        ]),
      );
  },
  async run({ repo, issue, comment, end }) {
    const { react, settle } = await import('../../agent/reactions.ts');
    if (end) await settle(repo, issue, end);
    else await react(repo, issue, comment);
  },
} satisfies ParsedCommand<ReactOptions>;
