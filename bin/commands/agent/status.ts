import { Option } from 'commander';

import { STATUSES, type Status } from '../../agent/constants.ts';
import type { ParsedCommand } from '../../command.ts';

interface StatusOptions {
  repo: string;
  issue: number;
  status: Status;
}

export default {
  kind: 'parsed',
  describe: 'Add an issue to the Pipeline board and set its Status (GH_TOKEN)',
  configure(command) {
    command
      .requiredOption('--repo <owner/name>', 'repository')
      .requiredOption('--issue <number>', 'issue number', Number)
      .addOption(
        new Option('--status <status>', 'Status to set').choices(STATUSES).makeOptionMandatory(),
      );
  },
  async run({ repo, issue, status }) {
    const { rest } = await import('../../agent/github.ts');
    const { setStatus } = await import('../../agent/board.ts');
    const { node_id } = await rest<{ node_id: string }>('GET', `/repos/${repo}/issues/${issue}`);
    await setStatus(repo, node_id, status);
  },
} satisfies ParsedCommand<StatusOptions>;
